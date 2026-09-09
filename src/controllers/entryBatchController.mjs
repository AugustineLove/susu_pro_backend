import pool from "../db.mjs";
import {
  postJournalEntry,
  resolveAccountingRule,
} from "../services/accountingHelper.mjs";
import { sendCustomerMessageBackend } from "./smsController.mjs";

async function generateBatchCode(client, companyId, entryDate) {
  const dateStr = entryDate.replace(/-/g, ""); // "2026-09-09" -> "20260909"
  const countRes = await client.query(
    `SELECT COUNT(*)::int AS n FROM entry_batches
     WHERE company_id = $1 AND entry_date = $2`,
    [companyId, entryDate]
  );
  const seq = countRes.rows[0].n + 1;
  return `${dateStr}${String(seq).padStart(3, "0")}`;
}

async function insertBatchWithRetry(client, { companyId, entryDate, mobileBankerStaffId, enteredByStaffId, notes, totalDeposits, totalWithdrawals, rowCount }) {
  let attempts = 0;
  while (attempts < 5) {
    attempts++;
    const code = await generateBatchCode(client, companyId, entryDate);
    try {
      const res = await client.query(
        `INSERT INTO entry_batches
           (batch_code, company_id, entry_date, mobile_banker_staff_id,
            entered_by_staff_id, status, total_deposits, total_withdrawals,
            row_count, notes)
         VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9)
         RETURNING *`,
        [code, companyId, entryDate, mobileBankerStaffId, enteredByStaffId,
         totalDeposits, totalWithdrawals, rowCount, notes || null]
      );
      return res.rows[0];
    } catch (err) {
      if (err.code === "23505" && attempts < 5) continue; // code collision, retry
      throw err;
    }
  }
  throw Object.assign(new Error("Could not generate a unique batch code"), { status: 500 });
}

/** Validates one row against the account it targets. Returns an
 *  error string, or null if the row is fine. Pure/no side effects. */
function validateRow(row, account) {
  if (!account) return "Account not found";
  if (!row.amount || parseFloat(row.amount) <= 0) return "Amount must be greater than 0";
  if (!["deposit", "withdrawal"].includes(row.transaction_type))
    return "transaction_type must be 'deposit' or 'withdrawal'";
  if (row.transaction_type === "withdrawal" && !row.withdrawal_type)
    return "Withdrawal type is required";
  if (account.status === "Inactive") return "Account is inactive";
  if (row.transaction_type === "withdrawal") {
    const bal = parseFloat(account.balance);
    const min = parseFloat(account.minimum_balance || 0);
    const amt = parseFloat(row.amount);
    if (amt > bal) return "Insufficient balance";
    if (bal - amt < min) return "Would breach minimum balance";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// POST /api/entry-batches
// Body: {
//   company_id, entry_date ("YYYY-MM-DD"),
//   mobile_banker_staff_id, entered_by_staff_id, notes?,
//   rows: [{ account_id, amount, transaction_type, description?,
//            payment_method?, withdrawal_type? }]
// }
// ─────────────────────────────────────────────────────────────
export const createEntryBatch = async (req, res) => {
  const {
    company_id, entry_date, mobile_banker_staff_id,
    entered_by_staff_id, notes, rows,
  } = req.body;

  if (!company_id || !entry_date || !mobile_banker_staff_id || !entered_by_staff_id)
    return res.status(400).json({ status: "fail", message: "Required sheet-level fields missing" });

  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ status: "fail", message: "Sheet must contain at least one row" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Validate every row up front — block the whole sheet on
    //    the first problem, per policy. ────────────────────────
    const accountIds = [...new Set(rows.map((r) => r.account_id))];
    const accRes = await client.query(
      `SELECT id, balance, account_type, minimum_balance, status, customer_id
       FROM accounts WHERE id = ANY($1::uuid[])`,
      [accountIds]
    );
    const accountsById = Object.fromEntries(accRes.rows.map((a) => [a.id, a]));

    const rowErrors = [];
    rows.forEach((row, i) => {
      const err = validateRow(row, accountsById[row.account_id]);
      if (err) rowErrors.push({ index: i, error: err });
    });

    if (rowErrors.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "One or more rows failed validation — fix them and resubmit the sheet",
        rowErrors,
      });
    }

    // ── Totals ───────────────────────────────────────────────
    const totalDeposits = rows
      .filter((r) => r.transaction_type === "deposit")
      .reduce((s, r) => s + parseFloat(r.amount), 0);
    const totalWithdrawals = rows
      .filter((r) => r.transaction_type === "withdrawal")
      .reduce((s, r) => s + parseFloat(r.amount), 0);

    // ── Create the batch shell ──────────────────────────────
    const batch = await insertBatchWithRetry(client, {
      companyId: company_id,
      entryDate: entry_date,
      mobileBankerStaffId: mobile_banker_staff_id,
      enteredByStaffId: entered_by_staff_id,
      notes,
      totalDeposits,
      totalWithdrawals,
      rowCount: rows.length,
    });

    // ── Insert every row as a normal transaction, parked at
    //    'pending' and tagged to this batch. No balance change,
    //    no journal entry yet — that happens on approval. ─────
    for (const row of rows) {
      await client.query(
        `INSERT INTO stakes (account_id, amount, staked_by)
         VALUES ($1,$2,$3)`,
        [row.account_id, parseFloat(row.amount), mobile_banker_staff_id]
      );

      await client.query(
        `INSERT INTO transactions
           (account_id, amount, type, status, processing_status,
            payment_method, created_by, company_id, description,
            unique_code, staff_id, withdrawal_type,
            transaction_date, batch_id)
         VALUES ($1,$2,$3,'pending','paid',$4,$5,$6,$7,
                 '', $5, $8, $9, $10)`,
        [
          row.account_id, parseFloat(row.amount), row.transaction_type,
          row.payment_method || null, entered_by_staff_id, company_id,
          row.description || null, row.withdrawal_type || null,
          entry_date, batch.id,
        ]
      );
    }

    await client.query("COMMIT");
    return res.status(201).json({ status: "success", data: batch });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createEntryBatch error:", err);
    return res.status(err.status || 500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/entry-batches/pending?company_id=...
// ─────────────────────────────────────────────────────────────
export const getPendingBatches = async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ status: "fail", message: "company_id is required" });

  try {
    const result = await pool.query(
      `SELECT eb.*,
              mb.full_name AS mobile_banker_name,
              eb2.full_name AS entered_by_name
       FROM entry_batches eb
       LEFT JOIN staff mb  ON mb.id = eb.mobile_banker_staff_id
       LEFT JOIN staff eb2 ON eb2.id = eb.entered_by_staff_id
       WHERE eb.company_id = $1 AND eb.status = 'pending'
       ORDER BY eb.created_at DESC`,
      [company_id]
    );
    return res.status(200).json({ status: "success", data: result.rows });
  } catch (err) {
    console.error("getPendingBatches error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/entry-batches/:code
// Returns the batch plus every row, with customer/account context
// so the accountant sees "everything" in one screen.
// ─────────────────────────────────────────────────────────────
export const getBatchByCode = async (req, res) => {
  const { code } = req.params;
  try {
    const batchRes = await pool.query(
      `SELECT eb.*,
              mb.full_name AS mobile_banker_name,
              eb2.full_name AS entered_by_name,
              ap.full_name AS approved_by_name
       FROM entry_batches eb
       LEFT JOIN staff mb  ON mb.id = eb.mobile_banker_staff_id
       LEFT JOIN staff eb2 ON eb2.id = eb.entered_by_staff_id
       LEFT JOIN staff ap  ON ap.id = eb.approved_by
       WHERE eb.batch_code = $1`,
      [code]
    );
    if (batchRes.rowCount === 0)
      return res.status(404).json({ status: "fail", message: "No sheet found with that code" });

    const batch = batchRes.rows[0];

    const rowsRes = await pool.query(
      `SELECT t.*, a.account_number, a.account_type, a.balance AS current_balance,
              c.name AS customer_name, c.phone_number AS customer_phone
       FROM transactions t
       JOIN accounts a  ON a.id = t.account_id
       JOIN customers c ON c.id = a.customer_id
       WHERE t.batch_id = $1
       ORDER BY t.created_at ASC`,
      [batch.id]
    );

    return res.status(200).json({ status: "success", data: { batch, rows: rowsRes.rows } });
  } catch (err) {
    console.error("getBatchByCode error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
export const updateEntryBatch = async (req, res) => {
  const { code } = req.params;
  const { entry_date, mobile_banker_staff_id, notes, rows } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchRes = await client.query(
      `SELECT * FROM entry_batches WHERE batch_code = $1 FOR UPDATE`,
      [code]
    );
    if (batchRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "No sheet found with that code" });
    }
    const batch = batchRes.rows[0];
    if (batch.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ status: "fail", message: `Sheet is already ${batch.status} — cannot edit` });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ status: "fail", message: "Sheet must contain at least one row" });
    }

    const accountIds = [...new Set(rows.map((r) => r.account_id))];
    const accRes = await client.query(
      `SELECT id, balance, account_type, minimum_balance, status, customer_id
       FROM accounts WHERE id = ANY($1::uuid[])`,
      [accountIds]
    );
    const accountsById = Object.fromEntries(accRes.rows.map((a) => [a.id, a]));
    const rowErrors = [];
    rows.forEach((row, i) => {
      const err = validateRow(row, accountsById[row.account_id]);
      if (err) rowErrors.push({ index: i, error: err });
    });
    if (rowErrors.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ status: "fail", message: "One or more rows failed validation", rowErrors });
    }

    // Wipe and reinsert this batch's transaction rows.
    await client.query(`DELETE FROM transactions WHERE batch_id = $1`, [batch.id]);

    for (const row of rows) {
      await client.query(
        `INSERT INTO stakes (account_id, amount, staked_by) VALUES ($1,$2,$3)`,
        [row.account_id, parseFloat(row.amount), mobile_banker_staff_id || batch.mobile_banker_staff_id]
      );
      await client.query(
        `INSERT INTO transactions
           (account_id, amount, type, status, processing_status,
            payment_method, created_by, company_id, description,
            unique_code, staff_id, withdrawal_type, transaction_date, batch_id)
         VALUES ($1,$2,$3,'pending','paid',$4,$5,$6,$7,'',$5,$8,$9,$10)`,
        [
          row.account_id, parseFloat(row.amount), row.transaction_type,
          row.payment_method || null, batch.entered_by_staff_id, batch.company_id,
          row.description || null, row.withdrawal_type || null,
          entry_date || batch.entry_date, batch.id,
        ]
      );
    }

    const totalDeposits = rows.filter((r) => r.transaction_type === "deposit")
      .reduce((s, r) => s + parseFloat(r.amount), 0);
    const totalWithdrawals = rows.filter((r) => r.transaction_type === "withdrawal")
      .reduce((s, r) => s + parseFloat(r.amount), 0);

    const updated = await client.query(
      `UPDATE entry_batches
       SET entry_date = $1, mobile_banker_staff_id = $2, notes = $3,
           total_deposits = $4, total_withdrawals = $5, row_count = $6
       WHERE id = $7 RETURNING *`,
      [
        entry_date || batch.entry_date,
        mobile_banker_staff_id || batch.mobile_banker_staff_id,
        notes ?? batch.notes,
        totalDeposits, totalWithdrawals, rows.length, batch.id,
      ]
    );

    await client.query("COMMIT");
    return res.status(200).json({ status: "success", data: updated.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateEntryBatch error:", err);
    return res.status(err.status || 500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/entry-batches/:code
// Soft-void — only while pending. Keeps the audit trail rather
// than hard-deleting rows.
// ─────────────────────────────────────────────────────────────
export const voidEntryBatch = async (req, res) => {
  const { code } = req.params;
  const { voided_by } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batchRes = await client.query(`SELECT * FROM entry_batches WHERE batch_code = $1 FOR UPDATE`, [code]);
    if (batchRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "No sheet found with that code" });
    }
    const batch = batchRes.rows[0];
    if (batch.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: `Sheet is already ${batch.status}. An approved sheet needs a reversal, not a void.`,
      });
    }

    await client.query(`UPDATE transactions SET status = 'voided' WHERE batch_id = $1`, [batch.id]);
    const updated = await client.query(
      `UPDATE entry_batches
       SET status = 'voided', voided_by = $1, voided_at = NOW()
       WHERE id = $2 RETURNING *`,
      [voided_by || null, batch.id]
    );

    await client.query("COMMIT");
    return res.status(200).json({ status: "success", data: updated.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("voidEntryBatch error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/entry-batches/:code/reject
// ─────────────────────────────────────────────────────────────
export const rejectEntryBatch = async (req, res) => {
  const { code } = req.params;
  const { rejected_by, reason } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batchRes = await client.query(`SELECT * FROM entry_batches WHERE batch_code = $1 FOR UPDATE`, [code]);
    if (batchRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "No sheet found with that code" });
    }
    const batch = batchRes.rows[0];
    if (batch.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ status: "fail", message: `Sheet is already ${batch.status}` });
    }

    await client.query(`UPDATE transactions SET status = 'rejected' WHERE batch_id = $1`, [batch.id]);
    const updated = await client.query(
      `UPDATE entry_batches
       SET status = 'rejected', rejected_by = $1, rejected_at = NOW(), rejection_reason = $2
       WHERE id = $3 RETURNING *`,
      [rejected_by || null, reason || null, batch.id]
    );

    await client.query("COMMIT");
    return res.status(200).json({ status: "success", data: updated.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("rejectEntryBatch error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/entry-batches/:code/approve
// This is where the sheet actually becomes real: balances move,
// journal entries post, and SMS goes out. Every row is re-checked
// against LIVE balances first (time may have passed since the
// sheet was typed in) — if anything now fails, the whole approval
// is rejected and nothing is touched, per policy.
// ─────────────────────────────────────────────────────────────
export const approveEntryBatch = async (req, res) => {
  const { code } = req.params;
  const { approved_by } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchRes = await client.query(`SELECT * FROM entry_batches WHERE batch_code = $1 FOR UPDATE`, [code]);
    if (batchRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "No sheet found with that code" });
    }
    const batch = batchRes.rows[0];
    if (batch.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ status: "fail", message: `Sheet is already ${batch.status}` });
    }

    const rowsRes = await client.query(
      `SELECT t.*, a.account_type, a.balance, a.minimum_balance, a.status AS account_status,
              a.customer_id, a.sms_enabled
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.batch_id = $1
       FOR UPDATE OF a`,
      [batch.id]
    );

    // ── Re-validate every row against LIVE balances ───────────
    const rowErrors = [];
    rowsRes.rows.forEach((row, i) => {
      const err = validateRow(
        { amount: row.amount, transaction_type: row.type, withdrawal_type: row.withdrawal_type },
        { balance: row.balance, minimum_balance: row.minimum_balance, status: row.account_status }
      );
      if (err) rowErrors.push({ index: i, transaction_id: row.id, error: err });
    });

    if (rowErrors.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Balances have changed since this sheet was entered — fix the flagged rows and try again",
        rowErrors,
      });
    }

    const entryDate = new Date(batch.entry_date).toISOString().slice(0, 10);
    const smsQueue = [];

    // ── Apply each row: move balance, post JE, mark completed ─
    for (const row of rowsRes.rows) {
      const numericAmount = parseFloat(row.amount);
      const isLoan = row.account_type.toLowerCase().includes("loan");
      const isDeposit = row.type === "deposit";

      const balanceOp = isDeposit
        ? (isLoan ? "balance - $1" : "balance + $1")
        : "balance - $1"; // withdrawal always reduces balance

      await client.query(
        `UPDATE accounts SET balance = ${balanceOp}, last_activity_at = NOW() WHERE id = $2`,
        [numericAmount, row.account_id]
      );

      const rule = await resolveAccountingRule(client, batch.company_id, {
        transaction_type: isLoan && isDeposit ? "loan_repayment" : row.type,
        account_subtype: row.account_type,
        payment_method: row.payment_method,
      });

      await postJournalEntry(client, {
        companyId: batch.company_id,
        description: row.description || `Field sheet ${batch.batch_code} — ${row.type}`,
        entryDate,
        source: "entry_batch",
        sourceId: row.id,
        sourceTable: "transactions",
        createdBy: approved_by || batch.entered_by_staff_id,
        lines: isDeposit
          ? [
              { coaId: rule.debitCoaId, dc: "debit", amount: numericAmount, customerId: row.customer_id, accountId: row.account_id },
              { coaId: rule.creditCoaId, dc: "credit", amount: numericAmount, customerId: row.customer_id, accountId: row.account_id },
            ]
          : [
              { coaId: rule.debitCoaId, dc: "debit", amount: numericAmount, customerId: row.customer_id, accountId: row.account_id },
              { coaId: rule.creditCoaId, dc: "credit", amount: numericAmount, customerId: row.customer_id, accountId: row.account_id },
            ],
      });

      await client.query(
        `UPDATE transactions SET status = 'completed', processing_status = 'paid' WHERE id = $1`,
        [row.id]
      );

      if (row.sms_enabled !== false) {
        smsQueue.push({
          customerId: row.customer_id,
          phone: row.customer_phone,
          amount: numericAmount,
          type: row.type,
          balance: isDeposit
            ? parseFloat(row.balance) + (isLoan ? -numericAmount : numericAmount)
            : parseFloat(row.balance) - numericAmount,
        });
      }
    }

    const approved = await client.query(
      `UPDATE entry_batches
       SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2 RETURNING *`,
      [approved_by || null, batch.id]
    );

    await client.query("COMMIT");

    // ── SMS goes out AFTER commit, so a notification failure
    //    never rolls back money that's already moved. ─────────
    for (const item of smsQueue) {
      try {
        await sendCustomerMessageBackend({
          to: item.phone,
          message: `Your account has been ${item.type === "deposit" ? "credited" : "debited"} GHS ${item.amount.toFixed(2)}. New balance: GHS ${item.balance.toFixed(2)}. Ref: ${code}`,
        });
      } catch (smsErr) {
        console.error(`SMS failed for batch ${code}, customer ${item.customerId}:`, smsErr.message);
      }
    }

    return res.status(200).json({ status: "success", data: approved.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("approveEntryBatch error:", err);
    return res.status(err.status || 500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};
