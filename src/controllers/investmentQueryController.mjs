// controllers/investmentQueryController.mjs
// ─── Investment Dashboard Queries ─────────────────────────────────────────────
//
// These endpoints power a company-wide "Investment Management" dashboard —
// as opposed to investmentController.mjs's getCustomerInvestments, which is
// scoped to a single customer.
//
// Endpoints:
//   GET  /api/investments/all/:company_id       — paginated, filterable list
//   GET  /api/investments/stats/:company_id     — summary cards for the dashboard
//   GET  /api/investments/maturing/:company_id  — upcoming / overdue maturities
//
// ─────────────────────────────────────────────────────────────────────────────

import pool from "../db.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investments/all/:company_id
//
// Query params (all optional):
//   status          — active | matured | cancelled  (omit for all)
//   product_type    — fixed_deposit | treasury_bill | susu_plus | investment_bond | money_market
//   search          — matches customer name, phone, account number, or investment reference
//   maturity_status — upcoming | overdue | none (only meaningful for active investments)
//   sort            — maturity_date_asc (default) | maturity_date_desc | created_desc | amount_desc
//   page            — default 1
//   limit           — default 25 (max 100)
// ─────────────────────────────────────────────────────────────────────────────
export const getAllInvestments = async (req, res) => {
  const { company_id } = req.params;
  const {
    status,
    product_type,
    search,
    maturity_status,
    sort = "maturity_date_asc",
    page = 1,
    limit = 25,
  } = req.query;

  if (!company_id)
    return res.status(400).json({ success: false, message: "company_id is required" });

  const safeLimit = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
  const safePage = Math.max(parseInt(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const where = [`ia.company_id = $1`];
  const params = [company_id];
  let p = 1;

  const push = (clause, value) => {
    p += 1;
    where.push(clause.replace("?", `$${p}`));
    params.push(value);
  };

  if (status) push(`ia.status = ?`, status);
  if (product_type) push(`ia.product_type = ?`, product_type);

  if (search && search.trim()) {
    p += 1;
    const idx = p;
    where.push(
      `(c.name ILIKE $${idx} OR c.phone_number ILIKE $${idx} OR a.account_number ILIKE $${idx} OR ia.reference ILIKE $${idx})`
    );
    params.push(`%${search.trim()}%`);
  }

  if (maturity_status === "upcoming") {
    where.push(
      `ia.status = 'active' AND ia.maturity_date IS NOT NULL AND ia.maturity_date > CURRENT_DATE AND ia.maturity_date <= CURRENT_DATE + INTERVAL '7 days'`
    );
  } else if (maturity_status === "overdue") {
    where.push(
      `ia.status = 'active' AND ia.maturity_date IS NOT NULL AND ia.maturity_date <= CURRENT_DATE`
    );
  } else if (maturity_status === "none") {
    where.push(`ia.maturity_date IS NULL`);
  }

  const sortMap = {
    maturity_date_asc: `ia.maturity_date ASC NULLS LAST`,
    maturity_date_desc: `ia.maturity_date DESC NULLS LAST`,
    created_desc: `ia.created_at DESC`,
    amount_desc: `ia.principal_amount DESC`,
  };
  const orderBy = sortMap[sort] ?? sortMap.maturity_date_asc;

  const whereSql = where.join(" AND ");

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM investment_accounts ia
       JOIN accounts a  ON a.id = ia.account_id
       JOIN customers c ON c.id = ia.customer_id
       WHERE ${whereSql}`,
      params
    );

    const dataRes = await pool.query(
      `SELECT
         ia.id, ia.reference, ia.product_type, ia.principal_amount,
         ia.interest_rate, ia.term_months, ia.start_date, ia.maturity_date,
         ia.expected_interest, ia.expected_maturity_value,
         ia.actual_interest, ia.actual_maturity_value,
         ia.auto_rollover, ia.status, ia.narration, ia.matured_at, ia.created_at,
         a.id AS account_id, a.account_number, a.balance AS current_balance,
         a.status AS account_status, a.sms_enabled,
         c.id AS customer_id, c.name AS customer_name, c.phone_number AS customer_phone,
         CASE
           WHEN ia.maturity_date IS NOT NULL
           THEN (ia.maturity_date - CURRENT_DATE)
           ELSE NULL
         END AS days_to_maturity,
         CASE
           WHEN ia.status = 'active' AND ia.maturity_date IS NOT NULL AND ia.maturity_date <= CURRENT_DATE
           THEN true ELSE false
         END AS is_overdue
       FROM investment_accounts ia
       JOIN accounts a  ON a.id = ia.account_id
       JOIN customers c ON c.id = ia.customer_id
       WHERE ${whereSql}
       ORDER BY ${orderBy}
       LIMIT ${safeLimit} OFFSET ${offset}`,
      params
    );

    return res.status(200).json({
      success: true,
      data: dataRes.rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: countRes.rows[0].total,
        total_pages: Math.ceil(countRes.rows[0].total / safeLimit),
      },
    });
  } catch (err) {
    console.error("getAllInvestments error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investments/stats/:company_id
// Summary numbers for dashboard header cards.
// ─────────────────────────────────────────────────────────────────────────────
export const getInvestmentStats = async (req, res) => {
  const { company_id } = req.params;

  if (!company_id)
    return res.status(400).json({ success: false, message: "company_id is required" });

  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active')                                     AS active_count,
         COUNT(*) FILTER (WHERE status = 'matured')                                    AS matured_count,
         COUNT(*) FILTER (WHERE status = 'cancelled')                                  AS cancelled_count,
         COUNT(*) FILTER (
           WHERE status = 'active' AND maturity_date IS NOT NULL
             AND maturity_date > CURRENT_DATE AND maturity_date <= CURRENT_DATE + INTERVAL '7 days'
         )                                                                              AS maturing_soon_count,
         COUNT(*) FILTER (
           WHERE status = 'active' AND maturity_date IS NOT NULL AND maturity_date <= CURRENT_DATE
         )                                                                              AS overdue_count,
         COALESCE(SUM(principal_amount) FILTER (WHERE status = 'active'), 0)           AS total_active_principal,
         COALESCE(SUM(expected_maturity_value) FILTER (WHERE status = 'active'), 0)    AS total_active_expected_value,
         COALESCE(SUM(expected_interest) FILTER (WHERE status = 'active'), 0)          AS total_active_expected_interest,
         COALESCE(SUM(actual_maturity_value) FILTER (WHERE status = 'matured'), 0)     AS total_paid_out
       FROM investment_accounts
       WHERE company_id = $1`,
      [company_id]
    );

    const byProduct = await pool.query(
      `SELECT product_type,
              COUNT(*)::int AS count,
              COALESCE(SUM(principal_amount), 0) AS total_principal
       FROM investment_accounts
       WHERE company_id = $1 AND status = 'active'
       GROUP BY product_type
       ORDER BY total_principal DESC`,
      [company_id]
    );

    return res.status(200).json({
      success: true,
      data: { ...result.rows[0], by_product: byProduct.rows },
    });
  } catch (err) {
    console.error("getInvestmentStats error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investments/maturing/:company_id
// Query params: window = upcoming | overdue | all (default "all"), days = 7
// Returns everything the dashboard needs to prompt staff into action + send SMS.
// ─────────────────────────────────────────────────────────────────────────────
export const getMaturingInvestments = async (req, res) => {
  const { company_id } = req.params;
  const { window = "all", days = 7 } = req.query;

  if (!company_id)
    return res.status(400).json({ success: false, message: "company_id is required" });

  const safeDays = Math.max(parseInt(days) || 7, 1);

  let condition = `ia.status = 'active' AND ia.maturity_date IS NOT NULL`;
  if (window === "upcoming") {
    condition += ` AND ia.maturity_date > CURRENT_DATE AND ia.maturity_date <= CURRENT_DATE + INTERVAL '${safeDays} days'`;
  } else if (window === "overdue") {
    condition += ` AND ia.maturity_date <= CURRENT_DATE`;
  } else {
    condition += ` AND ia.maturity_date <= CURRENT_DATE + INTERVAL '${safeDays} days'`;
  }

  try {
    const result = await pool.query(
      `SELECT
         ia.id, ia.reference, ia.product_type, ia.principal_amount,
         ia.interest_rate, ia.term_months, ia.maturity_date,
         ia.expected_interest, ia.expected_maturity_value, ia.auto_rollover,
         a.id AS account_id, a.account_number, a.balance AS current_balance,
         a.sms_enabled, a.sms_numbers,
         c.id AS customer_id, c.name AS customer_name, c.phone_number,
         (ia.maturity_date - CURRENT_DATE) AS days_to_maturity,
         CASE WHEN ia.maturity_date <= CURRENT_DATE THEN true ELSE false END AS is_overdue
       FROM investment_accounts ia
       JOIN accounts a  ON a.id = ia.account_id
       JOIN customers c ON c.id = ia.customer_id
       WHERE ia.company_id = $1 AND ${condition}
       ORDER BY ia.maturity_date ASC`,
      [company_id]
    );

    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error("getMaturingInvestments error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};
