import pool from "../db.mjs";

export const getCompanyFinancials = async (req, res) => {
  const {companyId} = req.params; 
 
  console.log("Fetching financials for company ID:", companyId);

  try {
    const [expensesRes, paymentsRes, assetsRes, budgetsRes, commissionsRes] = await Promise.all([
      pool.query(
        `SELECT id, description, amount, category, expense_date, created_at
         FROM expenses
         WHERE company_id = $1
         ORDER BY expense_date DESC`,
        [companyId]
      ),
      pool.query(
        `SELECT id, description, amount, category, payment_date, created_at, source, status, notes
         FROM revenue
         WHERE company_id = $1
         ORDER BY payment_date DESC`,
        [companyId]
      ),
      pool.query(
        `SELECT id, name, value, status, purchase_date, depreciation_rate, useful_life, created_at
         FROM assets
         WHERE company_id = $1
         ORDER BY purchase_date DESC`,
        [companyId]
      ),
      pool.query(
        `SELECT id, allocated, spent, date, remaining, status, teller_id
         FROM budgets
         WHERE company_id = $1
         ORDER BY date DESC`,
        [companyId]
      ),
      pool.query(
        `SELECT DATE(created_at) AS date, COALESCE(SUM(amount), 0) AS total_commission
          FROM commissions
          WHERE company_id = $1
          GROUP BY DATE(created_at)
          ORDER BY DATE(created_at);
          `,
        [companyId]
      ),
    ]);

    const totalCommission =
  commissionsRes.rows.length > 0
    ? parseFloat(commissionsRes.rows[0].total_commission)
    : 0;


    res.json({
      status: "success",
      data: {
        expenses: expensesRes.rows,
        revenue: paymentsRes.rows,
        assets: assetsRes.rows,
        budgets: budgetsRes.rows,
        totalCommission: totalCommission,
      },
    });
  } catch (error) {
    console.error("Error fetching financials:", error.message);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  } 
};


export const addBudget = async (req, res) => {
  const { company_id, allocated, source, recorded_by, teller_id } = req.body;

  if (!company_id || !teller_id || !recorded_by || !allocated || Number(allocated) <= 0)
    return res.status(400).json({
      status:  "fail",
      message: "company_id, teller_id, recorded_by and a valid allocated amount are required",
    });

  const client = await pool.connect();
  const today  = new Date().toISOString().split("T")[0];

  try {
    await client.query("BEGIN");

    // ── 1. Upsert today's budget for this teller ──────────
    const budgetRes = await client.query(
      `SELECT * FROM budgets
       WHERE company_id = $1 AND teller_id = $2 AND date = $3 FOR UPDATE`,
      [company_id, teller_id, today]
    );

    let budget;

    if (budgetRes.rowCount === 0) {
      const ins = await client.query(
        `INSERT INTO budgets
           (company_id, date, allocated, spent, status, teller_id, recorded_by)
         VALUES ($1,$2,$3,0,'Active',$4,$5)
         RETURNING *`,
        [company_id, today, Number(allocated), teller_id, recorded_by]
      );
      budget = ins.rows[0];
    } else {
      budget = budgetRes.rows[0];

      if (budget.status !== "Active") {
        await client.query("ROLLBACK");
        return res.status(403).json({
          status:  "fail",
          message: `Budget is ${budget.status}. You cannot add funds.`,
        });
      }

      const upd = await client.query(
        `UPDATE budgets SET allocated = allocated + $1 WHERE id = $2 RETURNING *`,
        [Number(allocated), budget.id]
      );
      budget = upd.rows[0];
    }

    // ── 2. Record top-up history ──────────────────────────
    await client.query(
      `INSERT INTO budget_topups (budget_id, amount, source, recorded_by)
       VALUES ($1,$2,$3,$4)`,
      [budget.id, Number(allocated), source || "manual", recorded_by || null]
    );

    // ── 3. Journal entry: Vault → Teller Float ───────────
    const floatCoaId = await resolveCOA(client, company_id, "1010-02"); // Mobile Banker Float
    const vaultCoaId = source === "bank"
      ? await resolveCOA(client, company_id, "1020-01")                 // Bank account
      : await resolveCOA(client, company_id, "1010-60");                // Cash in Vault

    await postJournalEntry(client, {
      companyId:   company_id,
      description: `Float top-up for teller ${teller_id} — ${source || "manual"}`,
      entryDate:   today,
      source:      "budget_float",
      sourceId:    budget.id,
      sourceTable: "budgets",
      createdBy:   recorded_by,
      lines: [
        {
          coaId:   floatCoaId,
          dc:      "debit",
          amount:  Number(allocated),
          description: "Cash issued to mobile banker",
          staffId: teller_id,
        },
        {
          coaId:   vaultCoaId,
          dc:      "credit",
          amount:  Number(allocated),
          description: source === "bank" ? "Drawn from bank account" : "Taken from vault",
          staffId: recorded_by,
        },
      ],
    });

    await client.query("COMMIT");

    return res.status(201).json({
      status:  "success",
      message: "Float processed successfully",
      data: {
        budget,
        available: Number(budget.allocated) - Number(budget.spent),
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("addBudget error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────
// recordEntry  (expense | revenue | asset)
// ─────────────────────────────────────────────────────────────

export const recordEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { type, company_id } = req.body;
    let result;

    // ────────────────────────────────────────────────────
    // ASSET
    // ────────────────────────────────────────────────────
    //   Dr  Fixed Assets sub-account   (1050-01 | 1050-02 | 1050)
    //   Cr  Cash in Vault              (1010-60)
    // ────────────────────────────────────────────────────
    if (type === "asset") {
      const { name, value, date, category, usefulLife, depreciation_rate, recorded_by } = req.body;

      if (!name || !value || !date || !category)
        throw new Error("Missing required asset fields");

      // Insert asset record
      const assetQ = depreciation_rate
        ? `INSERT INTO assets
             (company_id, name, value, purchase_date, category, depreciation_rate, useful_life)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`
        : `INSERT INTO assets
             (company_id, name, value, purchase_date, category, useful_life)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`;

      const assetParams = depreciation_rate
        ? [company_id, name, parseFloat(value), date, category, parseFloat(depreciation_rate), usefulLife || null]
        : [company_id, name, parseFloat(value), date, category, usefulLife || null];

      const assetRes = await client.query(assetQ, assetParams);
      result = assetRes.rows[0];

      // Resolve asset COA by category
      const assetCoaCode = ["vehicle","vehicles"].includes(category?.toLowerCase())
        ? "1050-02"
        : ["furniture","equipment","computer","phone"].some(k => category?.toLowerCase().includes(k))
          ? "1050-01"
          : "1050";

      const assetCoaId = await resolveCOA(client, company_id, assetCoaCode);
      const vaultCoaId = await resolveCOA(client, company_id, "1010-60");

      const creator = recorded_by || (await client.query(
        `SELECT id FROM staff WHERE company_id = $1 LIMIT 1`, [company_id]
      )).rows[0]?.id;

      // Asset purchase JE
      await postJournalEntry(client, {
        companyId:   company_id,
        description: `Asset purchase: ${name}`,
        entryDate:   date,
        source:      "manual",
        sourceId:    result.id,
        sourceTable: "assets",
        createdBy:   creator,
        lines: [
          {
            coaId:   assetCoaId,
            dc:      "debit",
            amount:  parseFloat(value),
            description: `${category} — ${name}`,
          },
          {
            coaId:   vaultCoaId,
            dc:      "credit",
            amount:  parseFloat(value),
            description: "Cash paid for asset",
          },
        ],
      });

    // ────────────────────────────────────────────────────
    // EXPENSE
    // ────────────────────────────────────────────────────
    //   Dr  Expense COA  (mapped by category)
    //   Cr  Cash in Vault  (1010-60)
    //
    //   Also deducts from today's float (existing logic).
    // ────────────────────────────────────────────────────
    } else if (type === "expense") {
      const { description, amount, date, category, recorded_by } = req.body;

      if (!description || !amount || !date || !category)
        throw new Error("Missing required expense fields");

      const expAmount = parseFloat(amount);

      // Insert expense record
      const expRes = await client.query(
        `INSERT INTO expenses
           (company_id, description, amount, expense_date, category, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [company_id, description, expAmount, date, category, recorded_by || null]
      );
      result = expRes.rows[0];

      // ── Float deduction (existing logic — unchanged) ──
      const today = new Date().toISOString().split("T")[0];
      const budgetRes = await client.query(
        `SELECT id, allocated, spent FROM budgets
         WHERE company_id = $1 AND date = $2 ORDER BY id ASC`,
        [company_id, today]
      );

      let remaining = expAmount;

      if (budgetRes.rowCount > 0) {
        for (const budget of budgetRes.rows) {
          const available = budget.allocated - budget.spent;
          if (remaining <= 0) break;
          if (available > 0) {
            const deducted = Math.min(remaining, available);
            remaining -= deducted;
            await client.query(
              deducted < available
                ? `UPDATE budgets SET spent = spent + $1 WHERE id = $2`
                : `UPDATE budgets SET spent = allocated WHERE id = $1`,
              deducted < available ? [deducted, budget.id] : [budget.id]
            );
            await client.query(
              `INSERT INTO float_movements
                 (budget_id, company_id, source_type, source_id, amount, direction)
               VALUES ($1,$2,'expense',$3,$4,'debit')`,
              [budget.id, company_id, result.id, deducted]
            );
          }
        }
        if (remaining > 0) {
          await client.query(
            `UPDATE budgets SET spent = spent + $1 WHERE id = $2`,
            [remaining, budgetRes.rows[0].id]
          );
        }
      } else {
        const nb = await client.query(
          `INSERT INTO budgets (company_id, date, allocated, spent, status)
           VALUES ($1,$2,0,$3,'Active') RETURNING id`,
          [company_id, today, expAmount]
        );
        await client.query(
          `INSERT INTO float_movements
             (budget_id, company_id, source_type, source_id, amount, direction)
           VALUES ($1,$2,'expense',$3,$4,'debit')`,
          [nb.rows[0].id, company_id, result.id, expAmount]
        );
      }

      // ── Expense COA mapping ───────────────────────────
      const expCoaCode = {
        salary:        "5010-01",
        transport:     "5050-03",
        rent:          "5050-01",
        utilities:     "5050-01",
        marketing:     "5050-06",
        stationery:    "5050-02",
        software:      "5050-05",
        data:          "5050-04",
        communication: "5050-04",
        depreciation:  "5020",
        commission:    "5030",
      }[category?.toLowerCase()] || "5050";

      const expCoaId   = await resolveCOA(client, company_id, expCoaCode);
      const vaultCoaId = await resolveCOA(client, company_id, "1010-60");

      const creator = recorded_by || (await client.query(
        `SELECT id FROM staff WHERE company_id = $1 LIMIT 1`, [company_id]
      )).rows[0]?.id;

      await postJournalEntry(client, {
        companyId:   company_id,
        description: description,
        entryDate:   date,
        source:      "expense",
        sourceId:    result.id,
        sourceTable: "expenses",
        createdBy:   creator,
        lines: [
          {
            coaId:   expCoaId,
            dc:      "debit",
            amount:  expAmount,
            description: `${category} expense`,
          },
          {
            coaId:   vaultCoaId,
            dc:      "credit",
            amount:  expAmount,
            description: "Cash paid out of vault",
          },
        ],
      });

    // ────────────────────────────────────────────────────
    // PAYMENT / REVENUE
    // ────────────────────────────────────────────────────
    //   Dr  Cash in Vault  (1010-60)    — asset ↑
    //   Cr  Income COA     (mapped by category)
    // ────────────────────────────────────────────────────
    } else if (type === "payment") {
      const { description, amount, date, category, recorded_by, source, notes = "" } = req.body;

      if (!description || !amount || !date || !category)
        throw new Error("Missing required payment fields");

      const payAmount = parseFloat(amount);

      const revRes = await client.query(
        `INSERT INTO revenue
           (company_id, description, amount, payment_date,
            category, recorded_by, source, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [company_id, description, payAmount, date,
         category, recorded_by || null, source || null, notes]
      );
      result = revRes.rows[0];

      // ── Income COA mapping ────────────────────────────
      const incCoaCode = {
        interest:   "4010",
        commission: "4020",
        fee:        "4030",
        rental:     "4040-01",
        recovery:   "4040-02",
      }[category?.toLowerCase()] || "4040";

      const incCoaId   = await resolveCOA(client, company_id, incCoaCode);
      const vaultCoaId = await resolveCOA(client, company_id, "1010-60");

      const creator = recorded_by || (await client.query(
        `SELECT id FROM staff WHERE company_id = $1 LIMIT 1`, [company_id]
      )).rows[0]?.id;

      await postJournalEntry(client, {
        companyId:   company_id,
        description: description,
        entryDate:   date,
        source:      "revenue",
        sourceId:    result.id,
        sourceTable: "revenue",
        createdBy:   creator,
        lines: [
          {
            coaId:   vaultCoaId,
            dc:      "debit",
            amount:  payAmount,
            description: "Cash received",
          },
          {
            coaId:   incCoaId,
            dc:      "credit",
            amount:  payAmount,
            description: `${category} income`,
          },
        ],
      });

    } else {
      throw new Error("Invalid type. Must be asset, expense, or payment");
    }

    await client.query("COMMIT");
    return res.status(201).json({ status: "success", data: result });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("recordEntry error:", err.message);
    return res.status(400).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};
