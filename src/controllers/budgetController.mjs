import pool from "../db.mjs";

export const getFloatActivity = async (req, res) => {
  const { id } = req.params;
    console.log("Fetching float activity for budget ID:", id);
  const { rows } = await pool.query(
    `
    SELECT
  fm.id AS movement_id,
  fm.source_type,
  fm.amount,
  fm.created_at,

  /* =========================
     WITHDRAWAL DATA
  ========================== */
  t.id AS transaction_id,
  t.status AS transaction_status,
  t.amount AS withdrawal_amount,
  t.description AS description,

  c.name AS customer_name,
  c.account_number,

  -- Mobile banker (who initiated it)
  mb.id AS mobile_banker_id,
  mb.full_name AS mobile_banker_name,

  -- Staff who recorded / approved it
  rs.id AS recorded_staff_id,
  rs.full_name AS recorded_staff_name,

  /* =========================
     EXPENSE DATA
  ========================== */
  e.id AS expense_id,
  e.description AS expense_description,
  e.amount AS expense_amount,

  es.id AS expense_staff_id,
  es.full_name AS expense_staff_name

FROM float_movements fm

/* =========================
   WITHDRAWALS
========================= */
LEFT JOIN transactions t
  ON fm.source_type = 'withdrawal'
 AND fm.source_id = t.id

LEFT JOIN accounts a 
  ON t.account_id = a.id

LEFT JOIN customers c 
  ON a.customer_id = c.id

-- Mobile banker
LEFT JOIN staff mb 
  ON t.created_by = mb.id

-- Recording staff
LEFT JOIN staff rs 
  ON t.staff_id = rs.id

/* =========================
   EXPENSES
========================= */
LEFT JOIN expenses e
  ON fm.source_type = 'expense'
 AND fm.source_id = e.id

LEFT JOIN staff es 
  ON e.recorded_by = es.id

WHERE fm.budget_id = $1
ORDER BY fm.created_at DESC;
    `,
    [id]
  );

  res.json({
    status: "success",
    data: rows,
  });
};

export const getBudgetById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM budgets
      WHERE id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Budget not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error fetching budget:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch budget",
    });
  }
};

export const sellCash = async (req, res) => {
  const { company_id, allocated, destination, recorded_by } = req.body;

  if (!company_id || !allocated || Number(allocated) <= 0) {
    return res.status(400).json({
      status: "fail",
      message: "company_id and a valid amount are required",
    });
  }

  const client = await pool.connect();
  const today = new Date().toISOString().split("T")[0];

  try {
    await client.query("BEGIN");

    // 1️⃣ Get today's budget (lock row)
    const budgetRes = await client.query(
      `
      SELECT *
      FROM budgets
      WHERE company_id = $1
        AND date = $2
      FOR UPDATE
      `,
      [company_id, today]
    );

    if (budgetRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "No budget found for today",
      });
    }

    const budget = budgetRes.rows[0];

    // 🚫 STATUS CHECK
    if (budget.status !== "Active") {
      await client.query("ROLLBACK");
      return res.status(403).json({
        status: "fail",
        message: `Budget is ${budget.status}. Cash sales are not allowed.`,
      });
    }

    const available = Number(budget.allocated) - Number(budget.spent);

    // 2️⃣ Check available balance
    if (available < allocated) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Insufficient float available",
      });
    }

    // 3️⃣ Deduct from allocated
    const updatedBudgetRes = await client.query(
      `
      UPDATE budgets
      SET allocated = allocated - $1
      WHERE id = $2
      RETURNING *
      `,
      [allocated, budget.id]
    );

    const updatedBudget = updatedBudgetRes.rows[0];

    // 4️⃣ Record sale
    await client.query(
      `
      INSERT INTO budget_sales (budget_id, amount, destination, recorded_by)
      VALUES ($1, $2, $3, $4)
      `,
      [
        budget.id,
        allocated,
        destination || "cash sale",
        recorded_by || null,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      status: "success",
      data: {
        budget: updatedBudget,
        available:
          Number(updatedBudget.allocated) - Number(updatedBudget.spent),
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Sell cash error:", error);

    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    client.release();
  }
};

export const toggleBudgetStatus = async (req, res) => {
  const { budgetId } = req.params;
  console.log(budgetId);

  if (!budgetId) {
    return res.status(400).json({
      status: "fail",
      message: "Budget id is required",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const budgetRes = await client.query(
      `
      SELECT id, status
      FROM budgets
      WHERE id = $1
      FOR UPDATE
      `,
      [budgetId]
    );

    if (budgetRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Budget not found",
      });
    }

    const budget = budgetRes.rows[0];

    // 2️⃣ Toggle status
    const newStatus =
      budget.status === "Active" ? "Closed" : "Active";

    const updatedRes = await client.query(
      `
      UPDATE budgets
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [newStatus, budgetId]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: `Budget ${newStatus.toLowerCase()} successfully`,
      data: updatedRes.rows[0],
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Toggle budget status error:", error);

    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    client.release();
  }
};

export const getBudgetsByCompanyId = async (req, res) => {
  const { companyId } = req.params;

  console.log(`Getting budget by company id`)

  if (!companyId) {
    return res.status(400).json({
      status: "fail",
      message: "company_id is required",
    });
  }

  const client = await pool.connect();

  try {
    const budgetsRes = await client.query(
      `SELECT id, company_id, date, allocated, spent, status
       FROM budgets
       WHERE company_id = $1
       ORDER BY date DESC`,
      [companyId]
    );

    if (budgetsRes.rowCount === 0) {
      return res.status(404).json({
        status: "fail",
        message: "No budgets found for this company",
        data: { budgets: [] },
      });
    }

    return res.status(200).json({
      status: "success",
      data: {
        budgets: budgetsRes.rows,
      },
    });
  } catch (error) {
    console.error("Error fetching company budgets:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
};
