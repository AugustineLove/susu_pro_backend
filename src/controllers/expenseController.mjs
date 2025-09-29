import pool from "../db.mjs";


export const recordEntry = async (req, res) => {
  const { type, company_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    let result;

    console.log("Recording entry:", req.body);

    if (type === "asset") {
      const { name, value, date, category, usefulLife, depreciation_rate } = req.body;

      if (!name || !value || !date || !category) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: "fail",
          message: "Missing required asset fields"
        });
      }

      let insertQuery;
      let params;

      if (depreciation_rate) {
        insertQuery = `
          INSERT INTO assets (company_id, name, value, purchase_date, category, depreciation_rate, useful_life)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `;
        params = [company_id, name, parseFloat(value), date, category, parseFloat(depreciation_rate), usefulLife || null];
      } else {
        insertQuery = `
          INSERT INTO assets (company_id, name, value, purchase_date, category, useful_life)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *;
        `;
        params = [company_id, name, parseFloat(value), date, category, usefulLife || null];
      }

      const { rows } = await client.query(insertQuery, params);
      result = rows[0];
    } 
    
    else if (type === "expense") {
      const { description, amount, date, category, status } = req.body;

      if (!description || !amount || !date || !category) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: "fail",
          message: "Missing required expense fields"
        });
      }

      const { rows } = await client.query(
        `INSERT INTO expenses (company_id, description, amount, expense_date, category)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [company_id, description, parseFloat(amount), date, category]
      );
      result = rows[0];
    } 
    else if (type === "payment"){
      const { description, amount, date, category, payment_date, status, recorded_by, source } = req. body;

      if (!description || !amount || !date || !category){
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: "fail",
          message: "Missing required payment fields"
        });
      }

      const { rows } = await client.query(
        `INSERT INTO revenue (company_id, description, amount, payment_date, category, recorded_by,source)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
        `,
        [company_id, description, amount, date, category, recorded_by, source]
      );
      result = rows[0];
    }

    else {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Invalid type. Must be 'asset' or 'expense'."
      });
    }

    await client.query("COMMIT");

    return res.status(201).json({
      status: "success",
      data: result
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error recording entry:", error.message);

    return res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message
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
        `SELECT COALESCE(SUM(amount), 0) AS total_commission
         FROM commissions
         WHERE company_id = $1`,
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
  const { company_id, allocated, date } = req.body;

  try {
    const insertQuery = `
      INSERT INTO budgets (company_id, allocated, date)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;

    const { rows } = await pool.query(insertQuery, [
      company_id,
      allocated,
      date || new Date().toISOString().split("T")[0]
    ]);

    return res.status(201).json({
      status: "success",
      data: rows[0]
    });

  } catch (error) {
    console.error("Error adding budget:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message
    });
  }
};
