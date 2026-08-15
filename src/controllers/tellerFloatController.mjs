import pool from "../db.mjs";

// ─────────────────────────────────────────────────────────────────────────
// TELLER FLOAT — balance + history
//
// TODAY'S MODEL: every teller shares ONE chart_of_accounts row, code
// "1010-02" ("Cash — Teller"). Deposits DEBIT it (cash comes in),
// withdrawal approvals CREDIT it (cash goes out). Because it's a single
// physical till, the account balance itself IS the float — we do NOT
// filter by staff_id. staff_id on journal_entry_lines is stamped
// inconsistently depending on which code path posted the line (creator
// vs. approver vs. whoever reversed it, and commission lines carry none
// at all) — it's fine as an audit trail field, but it's not a reliable
// way to isolate "this teller's" slice of a shared drawer. Filtering on
// it silently drops lines and makes the balance disagree with the real
// account total, which is what you were seeing.
//
// SCALING PATH:
//   True per-teller isolation requires a physically separate till, i.e.
//   its own chart_of_accounts row. When you're ready for a second
//   teller, create the `teller_float_accounts` table (see
//   migrations/002_teller_float_accounts.sql) and provision one active
//   row per teller. resolveTellerFloatCoa() below already checks for
//   that row first and, when found, resolves straight to that teller's
//   own coa_id — no staff_id filtering needed there either, since the
//   account itself is already isolated. The shared "1010-02" account
//   remains the fallback for any teller who hasn't been migrated yet.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_TELLER_FLOAT_COA_CODE = "1010-02";

/**
 * Resolves which chart_of_accounts row represents this teller's float.
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
    return dedicated.rows[0];
  }

  // 2. Fall back to the shared float account — the whole account balance
  //    is the float, no staff_id filtering (see note above).
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

  return shared.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/:companyId/tellers/:staffId/float
// Live balance + today's movement summary.
// ─────────────────────────────────────────────────────────────────────────
export const getTellerFloatBalance = async (req, res) => {
  const { companyId, staffId } = req.params;

  try {
    const floatCoa = await resolveTellerFloatCoa(companyId, staffId);

    const result = await pool.query(
      `SELECT
         coa.id   AS coa_id,
         coa.code AS coa_code,
         coa.name AS coa_name,
         coa.normal_balance,

         COALESCE((
           SELECT CASE coa.normal_balance
             WHEN 'debit' THEN
               COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0) -
               COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0)
             WHEN 'credit' THEN
               COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0) -
               COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0)
           END
           FROM journal_entry_lines jel
           JOIN journal_entries je ON je.id = jel.journal_entry_id
           WHERE jel.coa_id = coa.id
             AND je.status = 'posted'
             AND je.company_id = $1
         ), 0) AS balance,

         COALESCE((
           SELECT SUM(jel.amount)
           FROM journal_entry_lines jel
           JOIN journal_entries je ON je.id = jel.journal_entry_id
           WHERE jel.coa_id = coa.id
             AND je.status = 'posted'
             AND je.company_id = $1
             AND jel.debit_credit = 'debit'
             AND je.entry_date = CURRENT_DATE
         ), 0) AS todays_cash_in,

         COALESCE((
           SELECT SUM(jel.amount)
           FROM journal_entry_lines jel
           JOIN journal_entries je ON je.id = jel.journal_entry_id
           WHERE jel.coa_id = coa.id
             AND je.status = 'posted'
             AND je.company_id = $1
             AND jel.debit_credit = 'credit'
             AND je.entry_date = CURRENT_DATE
         ), 0) AS todays_cash_out,

         COALESCE((
           SELECT COUNT(*)
           FROM journal_entry_lines jel
           JOIN journal_entries je ON je.id = jel.journal_entry_id
           WHERE jel.coa_id = coa.id
             AND je.status = 'posted'
             AND je.company_id = $1
             AND je.entry_date = CURRENT_DATE
         ), 0) AS todays_transaction_count,

         (
           SELECT MAX(je.entry_date)
           FROM journal_entry_lines jel
           JOIN journal_entries je ON je.id = jel.journal_entry_id
           WHERE jel.coa_id = coa.id
             AND je.status = 'posted'
             AND je.company_id = $1
         ) AS last_movement_date

       FROM chart_of_accounts coa
       WHERE coa.id = $2`,
      [companyId, floatCoa.id]
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
