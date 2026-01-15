import pool from "../db.mjs";


export const recordEntry = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { type, company_id } = req.body;
    let result;

    /* =====================================================
     * ASSET
     * =================================================== */
    if (type === "asset") {
      const {
        name,
        value,
        date,
        category,
        usefulLife,
        depreciation_rate,
      } = req.body;

      if (!name || !value || !date || !category) {
        throw new Error("Missing required asset fields");
      }

      const query = depreciation_rate
        ? `
          INSERT INTO assets (
            company_id, name, value, purchase_date, category,
            depreciation_rate, useful_life
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `
        : `
          INSERT INTO assets (
            company_id, name, value, purchase_date, category, useful_life
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *;
        `;

      const params = depreciation_rate
        ? [
            company_id,
            name,
            parseFloat(value),
            date,
            category,
            parseFloat(depreciation_rate),
            usefulLife || null,
          ]
        : [
            company_id,
            name,
            parseFloat(value),
            date,
            category,
            usefulLife || null,
          ];

      const { rows } = await client.query(query, params);
      result = rows[0];
    }

    /* =====================================================
     * EXPENSE — DEDUCT FROM TODAY'S FLOAT
     * =================================================== */
    else if (type === "expense") {
      const { description, amount, date, category, recorded_by } = req.body;

      if (!description || !amount || !date || !category) {
        throw new Error("Missing required expense fields");
      }

      const expenseAmount = parseFloat(amount);

      // 1. Record expense
      const expenseRes = await client.query(
        `
        INSERT INTO expenses (
          company_id, description, amount, expense_date, category, recorded_by
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
        `,
        [company_id, description, expenseAmount, date, category, recorded_by || null]
      );

      result = expenseRes.rows[0];

      // 2. Deduct from today's budget (float)
      const today = new Date().toISOString().split("T")[0];

      const budgetRes = await client.query(
        `
        SELECT id, allocated, spent
        FROM budgets
        WHERE company_id = $1
        AND date = $2
        ORDER BY id ASC;
        `,
        [company_id, today]
      );

      let remaining = expenseAmount;

      if (budgetRes.rowCount > 0) {
        for (const budget of budgetRes.rows) {
          const available = budget.allocated - budget.spent;

          if (remaining <= 0) break;

          if (available > 0) {
            if (remaining <= available) {
              await client.query(
                `UPDATE budgets SET spent = spent + $1 WHERE id = $2`,
                [remaining, budget.id]
              );
              remaining = 0;
            } else {
              await client.query(
                `UPDATE budgets SET spent = allocated WHERE id = $1`,
                [budget.id]
              );
              remaining -= available;
            }
            await client.query(
            `
            INSERT INTO float_movements (
              budget_id, company_id, source_type, source_id, amount, direction
            )
            VALUES ($1, $2, 'expense', $3, $4, 'debit')
            `,
            [budget.id, company_id, result.id, amount]
          );
          console.log("Recorded float movement for expense:", result.id);
          }
        }

        // 🚨 Push negative if still remaining
        if (remaining > 0) {
          await client.query(
            `UPDATE budgets SET spent = spent + $1 WHERE id = $2`,
            [remaining, budgetRes.rows[0].id]
          );
        }
      } else {
        // 🚨 No budget today → create negative float
        await client.query(
          `
          INSERT INTO budgets (company_id, date, allocated, spent)
          VALUES ($1, $2, 0, $3);
          `,
          [company_id, today, expenseAmount]
        );
      }

    }

    /* =====================================================
     * PAYMENT / REVENUE
     * =================================================== */
    else if (type === "payment") {
      const {
        description,
        amount,
        date,
        category,
        recorded_by,
        source,
      } = req.body;

      if (!description || !amount || !date || !category) {
        throw new Error("Missing required payment fields");
      }

      const { rows } = await client.query(
        `
        INSERT INTO revenue (
          company_id, description, amount, payment_date,
          category, recorded_by, source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
        `,
        [
          company_id,
          description,
          parseFloat(amount),
          date,
          category,
          recorded_by || null,
          source || null,
        ]
      );

      result = rows[0];
    }

    /* =====================================================
     * INVALID TYPE
     * =================================================== */
    else {
      throw new Error("Invalid type. Must be asset, expense, or payment");
    }

    await client.query("COMMIT");

    return res.status(201).json({
      status: "success",
      data: result,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error recording entry:", error.message);

    return res.status(400).json({
      status: "error",
      message: error.message,
    });
  } finally {
    client.release();
  }
};

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
        `SELECT id, description, amount, category, payment_date, created_at, source
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
        `SELECT id, allocated, spent, date, remaining
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

    res.json({
      status: "success",
      data: {
        expenses: expensesRes.rows,
        revenue: paymentsRes.rows,
        assets: assetsRes.rows,
        budgets: budgetsRes.rows,
        totalCommission: parseFloat(commissionsRes.rows[0].total_commission),
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
  const { company_id, allocated, source, recorded_by } = req.body;
  console.log("Adding budget:", req.body);
  if (!company_id || !allocated) {
    return res.status(400).json({
      status: "fail",
      message: "company_id and allocated are required",
    });
  }

  const client = await pool.connect();
  const today = new Date().toISOString().split("T")[0];

  try {
    await client.query("BEGIN");

    // 1️⃣ Get or create today's budget
    const budgetRes = await client.query(
      `SELECT * FROM budgets
       WHERE company_id = $1 AND date = $2`,
      [company_id, today]
    );

    let budget;

    if (budgetRes.rowCount === 0) {
      const insertRes = await client.query(
        `INSERT INTO budgets (company_id, date, allocated, spent)
         VALUES ($1, $2, $3, 0)
         RETURNING *`,
        [company_id, today, allocated]
      );

      budget = insertRes.rows[0];
    } else {
      const updateRes = await client.query(
        `UPDATE budgets
         SET allocated = allocated + $1
         WHERE id = $2
         RETURNING *`,
        [allocated, budgetRes.rows[0].id]
      );

      budget = updateRes.rows[0];
    }

    // 2️⃣ Record the top-up history
    await client.query(
      `INSERT INTO budget_topups (budget_id, amount, source, recorded_by)
       VALUES ($1, $2, $3, $4)`,
      [budget.id, allocated, source || "manual", recorded_by || null]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      status: "success",
      data: {
        budget,
        available: budget.allocated - budget.spent,
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error adding budget:", error.message);

    return res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
};
