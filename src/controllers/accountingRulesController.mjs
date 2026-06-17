
// ─────────────────────────────────────────────────────────────
// GET /api/:companyId/accounting-rules
// Returns all rules for the company, joined with COA names.

import pool from "../db.mjs";

// ─────────────────────────────────────────────────────────────
export const getAccountingRules = async (req, res) => {
  const { companyId } = req.params;
  const { transaction_type, is_active } = req.query;

  try {
    const conditions = ["r.company_id = $1"];
    const values     = [companyId];
    let   idx        = 2;

    if (transaction_type) {
      conditions.push(`r.transaction_type = $${idx++}`);
      values.push(transaction_type);
    }
    if (is_active !== undefined) {
      conditions.push(`r.is_active = $${idx++}`);
      values.push(is_active === "true");
    }

    const result = await pool.query(
      `SELECT
         r.id,
         r.transaction_type,
         r.account_subtype,
         r.payment_method,
         r.label,
         r.is_system_default,
         r.is_active,
         r.created_at,
         r.updated_at,

         dr.id   AS debit_coa_id,
         dr.code AS debit_coa_code,
         dr.name AS debit_coa_name,

         cr.id   AS credit_coa_id,
         cr.code AS credit_coa_code,
         cr.name AS credit_coa_name
       FROM accounting_rules r
       JOIN chart_of_accounts dr ON dr.id = r.debit_coa_id
       JOIN chart_of_accounts cr ON cr.id = r.credit_coa_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY r.transaction_type, r.account_subtype NULLS LAST, r.payment_method NULLS LAST`,
      values
    );

    // Group by transaction_type for easier frontend rendering
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.transaction_type]) grouped[row.transaction_type] = [];
      grouped[row.transaction_type].push(row);
    }

    return res.status(200).json({
      status: "success",
      data:   result.rows,
      grouped,
      total:  result.rowCount,
    });
  } catch (err) {
    console.error("getAccountingRules error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// GET /api/:companyId/accounting-rules/transaction-types
// Returns the distinct list of supported transaction types
// so the frontend can build dropdowns without hardcoding.
// ─────────────────────────────────────────────────────────────
export const getTransactionTypes = async (req, res) => {
  // Canonical list — add new types here as the system grows
  const types = [
    { value: "deposit",              label: "Deposit" },
    { value: "withdrawal",           label: "Withdrawal" },
    { value: "loan_repayment",       label: "Loan repayment" },
    { value: "loan_disbursement",    label: "Loan disbursement" },
    { value: "commission",           label: "Commission / charge deduction" },
    { value: "investment_deposit",   label: "Investment deposit" },
    { value: "investment_maturity",  label: "Investment maturity payout" },
    { value: "salary_payment",       label: "Salary payment" },
    { value: "expense",              label: "Operating expense" },
    { value: "revenue",              label: "Revenue / income" },
    { value: "cash_shortage",        label: "Cash shortage (variance)" },
    { value: "cash_excess",          label: "Cash excess (variance)" },
    { value: "budget_float",         label: "Budget / float top-up" },
    { value: "transfer",             label: "Account transfer" },
  ];

  const subtypes = [
    { value: "savings",       label: "Savings" },
    { value: "susu",          label: "Susu" },
    { value: "fixed_deposit", label: "Fixed deposit / locked" },
    { value: "loan",          label: "Loan" },
  ];

  const methods = [
    { value: "cash", label: "Cash" },
    { value: "momo", label: "Mobile money (MoMo)" },
    { value: "bank", label: "Bank transfer" },
  ];

  return res.status(200).json({
    status: "success",
    data: { types, subtypes, methods },
  });
};


// ─────────────────────────────────────────────────────────────
// POST /api/:companyId/accounting-rules
// Create a new rule.
// ─────────────────────────────────────────────────────────────
export const createAccountingRule = async (req, res) => {
  const { companyId } = req.params;
  const {
    transaction_type,
    account_subtype,
    payment_method,
    debit_coa_id,
    credit_coa_id,
    label,
    created_by,
  } = req.body;

  if (!transaction_type || !debit_coa_id || !credit_coa_id || !label)
    return res.status(400).json({
      status:  "fail",
      message: "transaction_type, debit_coa_id, credit_coa_id, and label are required",
    });

  if (debit_coa_id === credit_coa_id)
    return res.status(400).json({
      status:  "fail",
      message: "Debit and credit accounts must be different",
    });

  try {
    const result = await pool.query(
      `INSERT INTO accounting_rules
         (company_id, transaction_type, account_subtype, payment_method,
          debit_coa_id, credit_coa_id, label, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        companyId,
        transaction_type,
        account_subtype || null,
        payment_method  || null,
        debit_coa_id,
        credit_coa_id,
        label,
        created_by || null,
      ]
    );

    return res.status(201).json({
      status:  "success",
      message: "Accounting rule created",
      data:    result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({
        status:  "fail",
        message: "A rule for this transaction type / subtype / method combination already exists. Edit the existing rule instead.",
      });
    console.error("createAccountingRule error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// PATCH /api/:companyId/accounting-rules/:ruleId
// Update debit/credit accounts or label.
// System defaults can be updated but not deleted.
// ─────────────────────────────────────────────────────────────
export const updateAccountingRule = async (req, res) => {
  const { companyId, ruleId } = req.params;
  const {
    debit_coa_id,
    credit_coa_id,
    label,
    is_active,
    updated_by,
  } = req.body;

  if (debit_coa_id && credit_coa_id && debit_coa_id === credit_coa_id)
    return res.status(400).json({
      status:  "fail",
      message: "Debit and credit accounts must be different",
    });

  try {
    const result = await pool.query(
      `UPDATE accounting_rules SET
         debit_coa_id  = COALESCE($1, debit_coa_id),
         credit_coa_id = COALESCE($2, credit_coa_id),
         label         = COALESCE($3, label),
         is_active     = COALESCE($4, is_active),
         updated_by    = $5,
         updated_at    = NOW()
       WHERE id = $6 AND company_id = $7
       RETURNING *`,
      [
        debit_coa_id  || null,
        credit_coa_id || null,
        label         || null,
        is_active     !== undefined ? is_active : null,
        updated_by    || null,
        ruleId,
        companyId,
      ]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ status: "fail", message: "Rule not found" });

    return res.status(200).json({
      status:  "success",
      message: "Accounting rule updated",
      data:    result.rows[0],
    });
  } catch (err) {
    console.error("updateAccountingRule error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// DELETE /api/:companyId/accounting-rules/:ruleId
// System defaults cannot be deleted — only deactivated.
// ─────────────────────────────────────────────────────────────
export const deleteAccountingRule = async (req, res) => {
  const { companyId, ruleId } = req.params;

  try {
    // Check if it's a system default
    const check = await pool.query(
      `SELECT is_system_default FROM accounting_rules
       WHERE id = $1 AND company_id = $2`,
      [ruleId, companyId]
    );

    if (check.rowCount === 0)
      return res.status(404).json({ status: "fail", message: "Rule not found" });

    if (check.rows[0].is_system_default)
      return res.status(400).json({
        status:  "fail",
        message: "System default rules cannot be deleted. Deactivate or edit them instead.",
      });

    await pool.query(
      `DELETE FROM accounting_rules WHERE id = $1 AND company_id = $2`,
      [ruleId, companyId]
    );

    return res.status(200).json({
      status:  "success",
      message: "Accounting rule deleted",
    });
  } catch (err) {
    console.error("deleteAccountingRule error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// POST /api/:companyId/accounting-rules/seed
// Re-run the seeder for a company (e.g. after adding new COA).
// ─────────────────────────────────────────────────────────────
export const seedAccountingRules = async (req, res) => {
  const { companyId } = req.params;

  try {
    await pool.query("SELECT seed_accounting_rules($1)", [companyId]);
    return res.status(200).json({
      status:  "success",
      message: "Default accounting rules seeded (existing rules untouched)",
    });
  } catch (err) {
    console.error("seedAccountingRules error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// GET /api/:companyId/accounting-rules/preview
// Preview what rule would fire for a given transaction.
// Useful for the frontend "test" button.
// ─────────────────────────────────────────────────────────────
export const previewAccountingRule = async (req, res) => {
  const { companyId } = req.params;
  const { transaction_type, account_subtype, payment_method } = req.query;

  if (!transaction_type)
    return res.status(400).json({ status: "fail", message: "transaction_type is required" });

  try {
    const result = await pool.query(
      `SELECT
         r.id,
         r.label,
         r.transaction_type,
         r.account_subtype,
         r.payment_method,
         r.is_system_default,

         dr.code AS debit_coa_code,
         dr.name AS debit_coa_name,

         cr.code AS credit_coa_code,
         cr.name AS credit_coa_name,

         (CASE WHEN r.account_subtype IS NOT NULL THEN 2 ELSE 0 END +
          CASE WHEN r.payment_method  IS NOT NULL THEN 1 ELSE 0 END) AS specificity
       FROM accounting_rules r
       JOIN chart_of_accounts dr ON dr.id = r.debit_coa_id
       JOIN chart_of_accounts cr ON cr.id = r.credit_coa_id
       WHERE r.company_id       = $1
         AND r.transaction_type = $2
         AND r.is_active        = true
         AND (r.account_subtype = $3 OR r.account_subtype IS NULL)
         AND (r.payment_method  = $4 OR r.payment_method  IS NULL)
       ORDER BY specificity DESC
       LIMIT 1`,
      [
        companyId,
        transaction_type,
        account_subtype || null,
        payment_method  || null,
      ]
    );

    if (result.rowCount === 0)
      return res.status(404).json({
        status:  "fail",
        message: "No matching rule found. Add one in Settings → Accounting Rules.",
      });

    return res.status(200).json({
      status: "success",
      data:   result.rows[0],
    });
  } catch (err) {
    console.error("previewAccountingRule error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
};