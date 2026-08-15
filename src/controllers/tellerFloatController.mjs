import pool from "../db.mjs";

// ─────────────────────────────────────────────────────────────────────────
// TELLER FLOAT — balance + history
//
// TODAY'S MODEL (matches how approveTransaction already validates float):
//   Every teller shares ONE chart_of_accounts row, code "1010-02"
//   ("Cash — Teller"). Deposits DEBIT it (cash comes in), withdrawal
//   approvals CREDIT it (cash goes out). Every line is stamped with
//   staff_id — so a specific teller's float is simply the running
//   balance of the lines THEY posted against that shared account.
//
// SCALING PATH (no rewrite needed later):
//   When you're ready to give each teller a physically separate float
//   account (own COA row under a "Teller Floats" parent, own opening
//   balance, own shift open/close), create the `teller_float_accounts`
//   table (see migrations/002_teller_float_accounts.sql) and insert one
//   active row per teller. resolveTellerFloatCoa() below already checks
//   for that row first — nothing else in this file has to change, and
//   the shared-account code path becomes the fallback for tellers who
//   haven't been migrated yet.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_TELLER_FLOAT_COA_CODE = "1010-02";

/**
 * Resolves which chart_of_accounts row represents this teller's float,
 * and whether results still need to be scoped by staff_id (true whenever
 * the account is shared rather than dedicated to this teller).
 */
async function resolveTellerFloatCoa(companyId, staffId) {
  // 1. Prefer a dedicated per-teller float account, if provisioned.
  let dedicated;
  try {
    dedicated = await pool.query(
      `SELECT coa.id, coa.code, coa.name, coa.normal_balance
       FROM teller_float_accounts tfa
       JOIN chart_of_accounts coa ON coa.id = tfa.coa_id
       WHERE tfa.company_id = $1 AND tfa.staff_id = $2 AND tfa.is_active = true
       LIMIT 1`,
      [companyId, staffId]
    );
  } catch (err) {
    // teller_float_accounts doesn't exist yet on this DB — that's fine,
    // just means no one has been migrated to dedicated accounts.
    dedicated = { rowCount: 0, rows: [] };
  }

  if (dedicated.rowCount > 0) {
    return { ...dedicated.rows[0], scopedToStaff: false };
  }

  // 2. Fall back to the shared float account, scoped by staff_id per line.
  const shared = await pool.query(
    `SELECT id, code, name, normal_balance
     FROM chart_of_accounts
     WHERE company_id = $1 AND code = $2 AND is_active = true AND is_deleted = false
     LIMIT 1`,
    [companyId, DEFAULT_TELLER_FLOAT_COA_CODE]
  );

  if (shared.rowCount === 0) {
    throw Object.assign(
      new Error(`Teller float account (${DEFAULT_TELLER_FLOAT_COA_CODE}) not found for this company`),
      { status: 404 }
    );
  }

  return { ...shared.rows[0], scopedToStaff: true };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/:companyId/tellers/:staffId/float
// Live balance + today's movement summary.
// ─────────────────────────────────────────────────────────────────────────
export const getTellerFloatBalance = async (req, res) => {
  const { companyId, staffId } = req.params;

  try {
    const floatCoa = await resolveTellerFloatCoa(companyId, staffId);
    const staffFilterSql = floatCoa.scopedToStaff ? "AND jel.staff_id = $3" : "";
    const params = floatCoa.scopedToStaff
      ? [companyId, floatCoa.id, staffId]
      : [companyId, floatCoa.id];

    const result = await pool.query(
      `SELECT
         coa.id   AS coa_id,
         coa.code AS coa_code,
         coa.name AS coa_name,
         coa.normal_balance,

         CASE coa.normal_balance
           WHEN 'debit' THEN
             COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0) -
             COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0)
           WHEN 'credit' THEN
             COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0) -
             COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0)
         END AS balance,

         COALESCE(SUM(jel.amount) FILTER (
           WHERE jel.debit_credit = 'debit' AND je.entry_date = CURRENT_DATE
         ), 0) AS todays_cash_in,

         COALESCE(SUM(jel.amount) FILTER (
           WHERE jel.debit_credit = 'credit' AND je.entry_date = CURRENT_DATE
         ), 0) AS todays_cash_out,

         COUNT(jel.id) FILTER (WHERE je.entry_date = CURRENT_DATE) AS todays_transaction_count,
         MAX(je.entry_date) AS last_movement_date

       FROM chart_of_accounts coa
       LEFT JOIN journal_entry_lines jel
         ON jel.coa_id = coa.id
         ${staffFilterSql}
       LEFT JOIN journal_entries je
         ON je.id = jel.journal_entry_id
         AND je.status = 'posted'
         AND je.company_id = $1
       WHERE coa.id = $2
       GROUP BY coa.id`,
      params
    );

    const staffRes = await pool.query(
      `SELECT id, full_name FROM staff WHERE id = $1`,
      [staffId]
    );

    const row = result.rows[0];

    return res.status(200).json({
      status: "success",
      data: {
        staff_id: staffId,
        staff_name: staffRes.rows[0]?.full_name || null,
        coa_id: row.coa_id,
        coa_code: row.coa_code,
        coa_name: row.coa_name,
        scoped_to_staff: floatCoa.scopedToStaff,
        balance: Number(row.balance),
        todays_cash_in: Number(row.todays_cash_in),
        todays_cash_out: Number(row.todays_cash_out),
        todays_net_movement: Number(row.todays_cash_in) - Number(row.todays_cash_out),
        todays_transaction_count: Number(row.todays_transaction_count),
        last_movement_date: row.last_movement_date,
      },
    });
  } catch (err) {
    console.error("getTellerFloatBalance error:", err.message);
    return res.status(err.status || 500).json({
      status: err.status ? "fail" : "error",
      message: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// GET /api/:companyId/tellers/:staffId/float/history
// Full, paginated ledger of everything that moved this teller's float —
// deposits (cash in), withdrawal payouts (cash out), and reversals.
//
// Query params: page, limit, type, status, search, startDate, endDate
// ─────────────────────────────────────────────────────────────────────────
export const getTellerFloatHistory = async (req, res) => {
  const { companyId, staffId } = req.params;
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const { type, status, search, startDate, endDate } = req.query;

  try {
    const floatCoa = await resolveTellerFloatCoa(companyId, staffId);

    const conditions = [
      "je.company_id = $1",
      "je.status = 'posted'",
      "jel.coa_id = $2",
    ];
    const values = [companyId, floatCoa.id];
    let pi = 3;

    if (floatCoa.scopedToStaff) {
      conditions.push(`jel.staff_id = $${pi++}`);
      values.push(staffId);
    }

    if (type && type !== "all") {
      conditions.push(`t.type = $${pi++}`);
      values.push(type);
    }
    if (status && status !== "all") {
      conditions.push(`t.status = $${pi++}`);
      values.push(status);
    }
    if (search) {
      conditions.push(`(
        cu.name ILIKE $${pi} OR
        cu.phone_number ILIKE $${pi} OR
        t.unique_code ILIKE $${pi}
      )`);
      values.push(`%${search}%`);
      pi++;
    }
    if (startDate) {
      conditions.push(`je.entry_date >= $${pi++}`);
      values.push(startDate);
    }
    if (endDate) {
      conditions.push(`je.entry_date <= $${pi++}`);
      values.push(endDate);
    }

    const where = "WHERE " + conditions.join(" AND ");

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      LEFT JOIN customers cu ON cu.id = jel.customer_id
      LEFT JOIN transactions t ON t.id = je.source_id AND je.source_table = 'transactions'
      ${where}
    `;
    const countResult = await pool.query(countQuery, values);
    const total = parseInt(countResult.rows[0].total, 10);

    const mainQuery = `
      SELECT
        jel.id AS line_id,
        je.entry_date,
        je.reference_no,
        je.description AS entry_description,
        je.source,
        jel.debit_credit,
        jel.amount,

        SUM(
          CASE
            WHEN coa.normal_balance = 'debit'  AND jel.debit_credit = 'debit'  THEN  jel.amount
            WHEN coa.normal_balance = 'debit'  AND jel.debit_credit = 'credit' THEN -jel.amount
            WHEN coa.normal_balance = 'credit' AND jel.debit_credit = 'credit' THEN  jel.amount
            WHEN coa.normal_balance = 'credit' AND jel.debit_credit = 'debit'  THEN -jel.amount
          END
        ) OVER (ORDER BY je.entry_date, je.created_at, jel.id) AS running_balance,

        cu.id AS customer_id,
        cu.name AS customer_name,
        cu.phone_number AS customer_phone,

        t.id AS transaction_id,
        t.type AS transaction_type,
        t.status AS transaction_status,
        t.unique_code,
        t.payment_method,
        t.withdrawal_type,
        t.description AS transaction_description

      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.coa_id
      LEFT JOIN customers cu ON cu.id = jel.customer_id
      LEFT JOIN transactions t ON t.id = je.source_id AND je.source_table = 'transactions'
      ${where}
      ORDER BY je.entry_date DESC, je.created_at DESC, jel.id DESC
      LIMIT $${pi} OFFSET $${pi + 1}
    `;

    const result = await pool.query(mainQuery, [...values, limit, offset]);

    return res.status(200).json({
      status: "success",
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      scoped_to_staff: floatCoa.scopedToStaff,
      coa: { id: floatCoa.id, code: floatCoa.code, name: floatCoa.name },
      data: result.rows,
    });
  } catch (err) {
    console.error("getTellerFloatHistory error:", err.message);
    return res.status(err.status || 500).json({
      status: err.status ? "fail" : "error",
      message: err.message,
    });
  }
};
