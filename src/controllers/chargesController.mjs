// controllers/chargesController.mjs
// ─── Account Charges — Commission, Fees, Penalties, Custom ───────────────────
//
// All charge types follow the same double-entry pattern:
//
//   Dr  Customer Deposit Liability   (reduces what we owe them)
//   Cr  Relevant Income Account      (recognises the income/fee)
//
// Endpoints:
//   POST  /api/charges/:accountId          — apply a charge
//   GET   /api/charges/account/:accountId  — charge history for account
//   GET   /api/charges/customer/:customerId — all charges for customer
//   POST  /api/charges/:chargeId/reverse   — reverse a charge
//
// ─────────────────────────────────────────────────────────────────────────────

import pool from "../db.mjs";
import {
  postJournalEntry,
  resolveCOA,
  depositCoaCode,
} from "../services/accountingHelper.mjs";

// ─── COA codes for each charge type ──────────────────────────────────────────
// Adjust to match your actual chart of accounts.
const CHARGE_COA_MAP = {
  commission:      "4020",     // Commission income
  service_fee:     "4030-01",  // Service fee income
  maintenance_fee: "4030-03",  // Account maintenance fee income
  penalty:         "4040-05",  // Penalty & late fee income
  processing_fee:  "4030",  // Processing fee income
  ledger_fee:      "4030-04",  // Ledger / admin fee income
  insurance:       "4050-01",  // Insurance premium income
  custom:          "4090",     // Miscellaneous income
};

// Human-readable labels for transaction descriptions
const CHARGE_LABELS = {
  commission:      "Commission Charge",
  service_fee:     "Service Fee",
  maintenance_fee: "Account Maintenance Fee",
  penalty:         "Penalty Charge",
  processing_fee:  "Processing Fee",
  ledger_fee:      "Ledger Fee",
  insurance:       "Insurance Premium",
  custom:          "Account Charge",
};

const VALID_CHARGE_TYPES = Object.keys(CHARGE_COA_MAP);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/charges/:accountId
// Apply a charge to a customer account.
//
// Body:
//   charge_type    — one of VALID_CHARGE_TYPES
//   amount         — numeric > 0
//   description    — optional custom note
//   company_id
//   created_by     — staff UUID
//   waive_if_zero  — bool (skip if balance would go negative, don't error)
//   charge_date    — optional ISO date string (defaults to today)
// ─────────────────────────────────────────────────────────────────────────────
export const applyCharge = async (req, res) => {
  const { accountId } = req.params;
  const {
    charge_type,
    amount,
    description,
    company_id,
    created_by,
    waive_if_zero = false,
    charge_date,
  } = req.body;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!charge_type || !amount || !company_id || !created_by)
    return res.status(400).json({
      success: false,
      message: "charge_type, amount, company_id, and created_by are required",
    });

  if (!VALID_CHARGE_TYPES.includes(charge_type))
    return res.status(400).json({
      success: false,
      message: `Invalid charge_type. Must be one of: ${VALID_CHARGE_TYPES.join(", ")}`,
    });

  if (Number(amount) <= 0)
    return res.status(400).json({ success: false, message: "Amount must be greater than 0" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ── Fetch & lock the account ──────────────────────────────────────────
    const accRes = await client.query(
      `SELECT id, balance, account_type, customer_id, status, minimum_balance, company_id
       FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_deleted = false
       FOR UPDATE`,
      [accountId, company_id]
    );

    if (accRes.rowCount === 0)
      throw Object.assign(new Error("Account not found"), { status: 404 });

    const account      = accRes.rows[0];
    const numAmount    = parseFloat(amount);
    const curBalance   = parseFloat(account.balance);

    if (account.status === "Inactive")
      throw Object.assign(new Error("Cannot charge an inactive account"), { status: 400 });

    // ── Balance check ─────────────────────────────────────────────────────
    if (curBalance < numAmount) {
      if (waive_if_zero) {
        // Silently skip — caller requested waiver on zero balance
        await client.query("ROLLBACK");
        return res.status(200).json({
          success: true,
          waived:  true,
          message: "Charge waived — insufficient balance",
        });
      }
      throw Object.assign(
        new Error(`Insufficient balance. Available: GHS ${curBalance.toFixed(2)}, Charge: GHS ${numAmount.toFixed(2)}`),
        { status: 400, code: "insufficient_balance" }
      );
    }

    // ── Deduct from account balance ───────────────────────────────────────
    const newBalance = curBalance - numAmount;
    await client.query(
      `UPDATE accounts
       SET balance = $1, last_activity_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [newBalance, accountId]
    );

    // ── Entry date ────────────────────────────────────────────────────────
    const entryDate = charge_date
      ? new Date(charge_date).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    // ── Build description ─────────────────────────────────────────────────
    const chargeLabel   = CHARGE_LABELS[charge_type];
    const autoDesc      = `${chargeLabel.toUpperCase()} OF GHS ${numAmount.toFixed(2)} ON ${account.account_type.toUpperCase()} ACCOUNT (${accountId.slice(-8).toUpperCase()})`;
    const finalDesc     = description
      ? `${autoDesc}. REMARKS: ${description.trim().toUpperCase()}.`
      : `${autoDesc}.`;

    // ── Insert transaction record ─────────────────────────────────────────
    const txRes = await client.query(
      `INSERT INTO transactions
         (account_id, company_id, type, amount, description,
          created_by, created_by_type, status, transaction_date)
       VALUES ($1, $2, 'commission', $3, $4, $5, 'staff', 'completed', $6)
       RETURNING *`,
      [accountId, company_id, numAmount, finalDesc, created_by, entryDate]
    );
    const tx = txRes.rows[0];

    // ── Insert into account_charges table ─────────────────────────────────
    // Creates the charge record that links to the transaction.
    // The table is created by the migration endpoint below.
    const chargeRes = await client.query(
      `INSERT INTO account_charges
         (account_id, customer_id, company_id, charge_type, amount,
          description, transaction_id, created_by, status, charge_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied', $9)
       RETURNING *`,
      [
        accountId, account.customer_id, company_id,
        charge_type, numAmount, finalDesc,
        tx.id, created_by, entryDate,
      ]
    );
    const charge = chargeRes.rows[0];

    // ── Resolve COA accounts ──────────────────────────────────────────────
    const depositCoaId = await resolveCOA(client, company_id, depositCoaCode(account.account_type));
    const incomeCoaId  = await resolveCOA(client, company_id, CHARGE_COA_MAP[charge_type]);

    // ── Post journal entry ────────────────────────────────────────────────
    //   Dr  Customer Deposit Liability   — we owe them less
    //   Cr  Income / Fee Account         — we've earned the charge
    await postJournalEntry(client, {
      companyId:   company_id,
      description: finalDesc,
      entryDate,
      source:      "account_charge",
      sourceId:    charge.id,
      sourceTable: "account_charges",
      createdBy:   created_by,
      lines: [
        {
          coaId:       depositCoaId,
          dc:          "debit",
          amount:      numAmount,
          description: `${chargeLabel} — reduces customer liability`,
          customerId:  account.customer_id,
          accountId:   accountId,
          staffId:     created_by,
        },
        {
          coaId:       incomeCoaId,
          dc:          "credit",
          amount:      numAmount,
          description: `${chargeLabel} income recognised`,
          customerId:  account.customer_id,
          accountId:   accountId,
          staffId:     created_by,
        },
      ],
    });

    await client.query("COMMIT");

    return res.status(201).json({
      success:     true,
      message:     `${chargeLabel} of GHS ${numAmount.toFixed(2)} applied successfully`,
      data: {
        charge,
        transaction:   tx,
        previous_balance: curBalance,
        new_balance:      newBalance,
        amount_charged:   numAmount,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("applyCharge error:", err.message);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/charges/:chargeId/reverse
// Reverse a previously applied charge — restores balance and posts reversal JE.
// ─────────────────────────────────────────────────────────────────────────────
export const reverseCharge = async (req, res) => {
  const { chargeId } = req.params;
  const { company_id, reversed_by, reason } = req.body;

  if (!company_id || !reversed_by)
    return res.status(400).json({ success: false, message: "company_id and reversed_by are required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fetch & lock charge
    const chargeRes = await client.query(
      `SELECT ac.*, a.balance, a.account_type, a.customer_id
       FROM account_charges ac
       JOIN accounts a ON a.id = ac.account_id
       WHERE ac.id = $1 AND ac.company_id = $2
       FOR UPDATE OF ac`,
      [chargeId, company_id]
    );

    if (chargeRes.rowCount === 0)
      throw Object.assign(new Error("Charge not found"), { status: 404 });

    const charge = chargeRes.rows[0];

    if (charge.status === "reversed")
      throw Object.assign(new Error("Charge is already reversed"), { status: 400 });

    const numAmount = parseFloat(charge.amount);

    // Restore balance
    await client.query(
      `UPDATE accounts SET balance = balance + $1, last_activity_at = NOW() WHERE id = $2`,
      [numAmount, charge.account_id]
    );

    // Mark charge reversed
    await client.query(
      `UPDATE account_charges
       SET status = 'reversed', reversed_at = NOW(), reversed_by = $1, reversal_reason = $2
       WHERE id = $3`,
      [reversed_by, reason || null, chargeId]
    );

    // Mark original transaction reversed
    if (charge.transaction_id) {
      await client.query(
        `UPDATE transactions
         SET status = 'reversed', reversed_at = NOW(), reversed_by = $1, reversal_reason = $2
         WHERE id = $3`,
        [reversed_by, reason || null, charge.transaction_id]
      );
    }

    // Insert reversal transaction
    const entryDate = new Date().toISOString().slice(0, 10);
    const revTxRes = await client.query(
      `INSERT INTO transactions
         (account_id, company_id, type, amount, description,
          created_by, created_by_type, status, source_transaction_id)
       VALUES ($1, $2, 'commission', $3, $4, $5, 'staff', 'completed', $6)
       RETURNING *`,
      [
        charge.account_id, company_id, numAmount,
        `REVERSAL OF ${charge.description}${reason ? `. REASON: ${reason.toUpperCase()}` : ""}.`,
        reversed_by, charge.transaction_id,
      ]
    );

    // Reversal JE — mirror of original
    //   Dr  Income Account         — undo the income
    //   Cr  Customer Deposit Liab  — restore what we owe them
    const depositCoaId = await resolveCOA(client, company_id, depositCoaCode(charge.account_type));
    const incomeCoaId  = await resolveCOA(client, company_id, CHARGE_COA_MAP[charge.charge_type] ?? "4090");

    await postJournalEntry(client, {
      companyId:   company_id,
      description: `Charge reversal — ${CHARGE_LABELS[charge.charge_type] ?? "Account Charge"}${reason ? ` — ${reason}` : ""}`,
      entryDate,
      source:      "charge_reversal",
      sourceId:    chargeId,
      sourceTable: "account_charges",
      createdBy:   reversed_by,
      lines: [
        {
          coaId:       incomeCoaId,
          dc:          "debit",
          amount:      numAmount,
          description: "Reverse charge income",
          customerId:  charge.customer_id,
          accountId:   charge.account_id,
          staffId:     reversed_by,
        },
        {
          coaId:       depositCoaId,
          dc:          "credit",
          amount:      numAmount,
          description: "Restore customer deposit balance",
          customerId:  charge.customer_id,
          accountId:   charge.account_id,
          staffId:     reversed_by,
        },
      ],
    });

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: `Charge of GHS ${numAmount.toFixed(2)} reversed successfully`,
      data: {
        charge_id:    chargeId,
        amount:       numAmount,
        reversal_tx:  revTxRes.rows[0],
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("reverseCharge error:", err.message);
    return res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/charges/account/:accountId
// All charges for a specific account
// ─────────────────────────────────────────────────────────────────────────────
export const getChargesByAccount = async (req, res) => {
  const { accountId } = req.params;
  const { company_id } = req.query;

  try {
    const result = await pool.query(
      `SELECT ac.*,
              s.full_name AS created_by_name,
              rs.full_name AS reversed_by_name
       FROM account_charges ac
       LEFT JOIN staff s  ON s.id  = ac.created_by
       LEFT JOIN staff rs ON rs.id = ac.reversed_by
       WHERE ac.account_id = $1
         ${company_id ? "AND ac.company_id = $2" : ""}
       ORDER BY ac.charge_date DESC, ac.created_at DESC`,
      company_id ? [accountId, company_id] : [accountId]
    );

    return res.status(200).json({
      status:  "success",
      results: result.rowCount,
      data:    result.rows,
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/charges/customer/:customerId
// All charges across all accounts for a customer
// ─────────────────────────────────────────────────────────────────────────────
export const getChargesByCustomer = async (req, res) => {
  const { customerId } = req.params;

  try {
    const result = await pool.query(
      `SELECT ac.*,
              a.account_type, a.account_number,
              s.full_name AS created_by_name,
              rs.full_name AS reversed_by_name
       FROM account_charges ac
       JOIN  accounts a ON a.id = ac.account_id
       LEFT JOIN staff s  ON s.id  = ac.created_by
       LEFT JOIN staff rs ON rs.id = ac.reversed_by
       WHERE ac.customer_id = $1
         AND ac.is_deleted IS DISTINCT FROM true
       ORDER BY ac.charge_date DESC, ac.created_at DESC`,
      [customerId]
    );

    // Summary
    const summary = result.rows.reduce(
      (acc, c) => ({
        total_applied:  acc.total_applied  + (c.status === "applied"  ? Number(c.amount) : 0),
        total_reversed: acc.total_reversed + (c.status === "reversed" ? Number(c.amount) : 0),
        count:          acc.count + 1,
      }),
      { total_applied: 0, total_reversed: 0, count: 0 }
    );

    return res.status(200).json({
      status:  "success",
      results: result.rowCount,
      data:    result.rows,
      summary,
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/charges/types
// Returns the list of valid charge types (used to populate dropdowns)
// ─────────────────────────────────────────────────────────────────────────────
export const getChargeTypes = async (req, res) => {
  return res.status(200).json({
    status: "success",
    data: VALID_CHARGE_TYPES.map((type) => ({
      value: type,
      label: CHARGE_LABELS[type],
      coa:   CHARGE_COA_MAP[type],
    })),
  });
};


// ─────────────────────────────────────────────────────────────────────────────
// Migration — run once
// GET /api/charges/migrate
// ─────────────────────────────────────────────────────────────────────────────
export const runChargesMigration = async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_charges (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id       UUID NOT NULL REFERENCES accounts(id),
        customer_id      UUID NOT NULL REFERENCES customers(id),
        company_id       UUID NOT NULL,
        charge_type      VARCHAR(50) NOT NULL,
        amount           NUMERIC(15,2) NOT NULL,
        description      TEXT,
        transaction_id   UUID REFERENCES transactions(id),
        created_by       UUID,
        status           VARCHAR(20) NOT NULL DEFAULT 'applied',
        charge_date      DATE NOT NULL DEFAULT CURRENT_DATE,
        reversed_at      TIMESTAMPTZ,
        reversed_by      UUID,
        reversal_reason  TEXT,
        is_deleted       BOOLEAN DEFAULT false,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ac_account    ON account_charges(account_id);
      CREATE INDEX IF NOT EXISTS idx_ac_customer   ON account_charges(customer_id);
      CREATE INDEX IF NOT EXISTS idx_ac_company    ON account_charges(company_id);
      CREATE INDEX IF NOT EXISTS idx_ac_status     ON account_charges(status);
      CREATE INDEX IF NOT EXISTS idx_ac_charge_date ON account_charges(charge_date);
    `);

    return res.status(200).json({ status: "success", message: "account_charges table ready" });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};
