// ============================================================
// pendingBackdatedController.mjs
// Endpoints for fetching and approving/rejecting backdated
// (and future-dated) pending transactions.
// ============================================================

import pool from "../db.mjs";
import { cashCoaCode, depositCoaCode, postJournalEntry, resolveCOA } from "../services/accountingHelper.mjs";

// ─────────────────────────────────────────────────────────────
// GET /api/transactions/:companyId/pending-backdated
//
// Returns all pending transactions whose transaction_date differs
// from their created_at date (i.e. backdated or future-dated).
//
// Optional query params:
//   ?type=deposit|withdrawal     filter by transaction type
//   ?from=YYYY-MM-DD             filter by transaction_date range
//   ?to=YYYY-MM-DD
//   ?staff_id=uuid               filter by the teller who created it
//   ?limit=50&offset=0           pagination
// ─────────────────────────────────────────────────────────────
export const getPendingBackdatedTransactions = async (req, res) => {
  const { companyId } = req.params;
  const {
    type,
    from,
    to,
    staff_id,
    limit  = 50,
    offset = 0,
  } = req.query;

  if (!companyId)
    return res.status(400).json({ status: "fail", message: "companyId is required" });

  try {
    // Build dynamic WHERE clauses
    const conditions = [
      `t.company_id   = $1`,
      `t.status       = 'pending'`,
      // Core backdating check: transaction_date (cast to date) ≠ created_at (cast to date)
      // This catches both past-dated and future-dated submissions.
      `t.accounting_je_id IS NULL`,
      `t.transaction_date::date != t.created_at::date`,
    ];
    const values = [companyId];
    let idx = 2;

    if (type) {
      conditions.push(`t.type = $${idx++}`);
      values.push(type);
    }
    if (from) {
      conditions.push(`t.transaction_date::date >= $${idx++}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`t.transaction_date::date <= $${idx++}`);
      values.push(to);
    }
    if (staff_id) {
      conditions.push(`t.created_by = $${idx++}`);
      values.push(staff_id);
    }

    const whereClause = conditions.join(" AND ");

    // Main query — join customers, accounts, and the creating staff member
    // so the frontend has everything it needs without extra round trips.
    const dataQuery = `
      SELECT
        t.id                  AS transaction_id,
        t.type,
        t.amount,
        t.status,
        t.processing_status,
        t.payment_method,
        t.description,
        t.withdrawal_type,
        t.unique_code,
        t.transaction_date,
        t.created_at,

        -- How far back (or forward) the date is
        (t.transaction_date::date - t.created_at::date) AS date_offset_days,

        -- Account info
        a.id                  AS account_id,
        a.account_type,
        a.balance             AS current_balance,
        a.minimum_balance,

        -- Customer info
        c.id                  AS customer_id,
        c.name           AS customer_name,
        c.phone_number               AS customer_phone,
        a.account_number      AS customer_account_number,

        -- Teller who submitted
        s.id                  AS teller_id,
        s.full_name           AS teller_name,
        s.role                AS teller_role

      FROM transactions t
      JOIN accounts  a ON a.id = t.account_id
      JOIN customers c ON c.id = a.customer_id
      LEFT JOIN staff s ON s.id = t.created_by
      WHERE ${whereClause}
      ORDER BY t.transaction_date ASC, t.created_at ASC
      LIMIT  $${idx++}
      OFFSET $${idx++}
    `;
    values.push(parseInt(limit), parseInt(offset));

    // Count query for pagination
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM transactions t
      WHERE ${whereClause}
    `;
    // countQuery uses only the first (idx-2) values — strip the limit/offset
    const countValues = values.slice(0, values.length - 2);

    const [dataRes, countRes] = await Promise.all([
      pool.query(dataQuery, values),
      pool.query(countQuery, countValues),
    ]);

    const total = parseInt(countRes.rows[0].total);

    // Group into "backdated" (past) vs "future-dated" for easier UI rendering
    const rows = dataRes.rows.map((row) => ({
      ...row,
      amount:          parseFloat(row.amount),
      current_balance: parseFloat(row.current_balance),
      minimum_balance: parseFloat(row.minimum_balance || 0),
      date_offset_days: parseInt(row.date_offset_days),
      is_future_dated:  parseInt(row.date_offset_days) > 0,
      is_backdated:     parseInt(row.date_offset_days) < 0,
    }));

    return res.status(200).json({
      status: "success",
      data:   rows,
      meta: {
        total,
        limit:  parseInt(limit),
        offset: parseInt(offset),
        pages:  Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("getPendingBackdatedTransactions error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// GET /api/transactions/:companyId/pending-backdated/summary
//
// Quick summary counts + totals for the dashboard badge/widget.
// ─────────────────────────────────────────────────────────────
export const getPendingBackdatedSummary = async (req, res) => {
  const { companyId } = req.params;

  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)                                          AS total_count,
         COUNT(*) FILTER (WHERE t.type = 'deposit')       AS deposit_count,
         COUNT(*) FILTER (WHERE t.type = 'withdrawal')    AS withdrawal_count,
         COUNT(*) FILTER (WHERE t.transaction_date::date < t.created_at::date) AS backdated_count,
         COUNT(*) FILTER (WHERE t.transaction_date::date > t.created_at::date) AS future_dated_count,
         COALESCE(SUM(t.amount), 0)                        AS total_amount,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'),    0) AS total_deposit_amount,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'withdrawal'), 0) AS total_withdrawal_amount,
         MIN(t.transaction_date)                           AS oldest_date,
         MAX(t.transaction_date)                           AS newest_date
       FROM transactions t
       WHERE t.company_id       = $1
         AND t.status           = 'pending'
         AND t.accounting_je_id IS NULL
         AND t.transaction_date::date != t.created_at::date`,
      [companyId]
    );

    const row = result.rows[0];
    return res.status(200).json({
      status: "success",
      data: {
        total_count:            parseInt(row.total_count),
        deposit_count:          parseInt(row.deposit_count),
        withdrawal_count:       parseInt(row.withdrawal_count),
        backdated_count:        parseInt(row.backdated_count),
        future_dated_count:     parseInt(row.future_dated_count),
        total_amount:           parseFloat(row.total_amount),
        total_deposit_amount:   parseFloat(row.total_deposit_amount),
        total_withdrawal_amount:parseFloat(row.total_withdrawal_amount),
        oldest_date:            row.oldest_date,
        newest_date:            row.newest_date,
      },
    });
  } catch (err) {
    console.error("getPendingBackdatedSummary error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// POST /api/transactions/:companyId/pending-backdated/:transactionId/approve
//
// Approves a single backdated/future-dated pending transaction:
//   1. Re-validates balance (for withdrawals)
//   2. Checks accounting period is open for the transaction_date
//   3. Posts the journal entry dated on transaction_date
//   4. Updates account balance
//   5. Stamps the transaction as completed
// ─────────────────────────────────────────────────────────────
export const approveBackdatedTransaction = async (req, res) => {
  const { companyId, transactionId } = req.params;
  const { approved_by } = req.body;

  if (!approved_by)
    return res.status(400).json({ status: "fail", message: "approved_by is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Fetch & lock transaction row ──────────────────────
    const txRes = await client.query(
      `SELECT
         t.*,
         a.balance        AS account_balance,
         a.minimum_balance,
         a.account_type,
         a.status         AS account_status,
         a.customer_id
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.id         = $1
         AND t.company_id = $2
       FOR UPDATE OF t`,
      [transactionId, companyId]
    );

    if (txRes.rowCount === 0)
      throw Object.assign(new Error("Transaction not found"), { status: 404 });

    const tx = txRes.rows[0];

    // ── Guard rails ───────────────────────────────────────
    if (tx.status !== "pending")
      throw Object.assign(
        new Error(`Transaction is already '${tx.status}' — cannot approve`),
        { status: 400 }
      );

    const createdDateStr     = new Date(tx.created_at).toISOString().slice(0, 10);
    const transactionDateStr = new Date(tx.transaction_date).toISOString().slice(0, 10);

    if (transactionDateStr === createdDateStr)
      throw Object.assign(
        new Error(
          "This is a same-day transaction. Use the standard approveTransaction endpoint instead."
        ),
        { status: 400 }
      );

    if (tx.accounting_je_id !== null)
      throw Object.assign(
        new Error(
          "A journal entry already exists for this transaction. Use approveTransaction for same-day pending withdrawals."
        ),
        { status: 400 }
      );

    if (tx.account_status === "Inactive")
      throw Object.assign(new Error("Account is inactive"), { status: 400 });

    const numericAmount = parseFloat(tx.amount);
    const isLoan        = tx.account_type.toLowerCase().includes("loan");
    const entryDate     = transactionDateStr;

    // ── Balance re-check for withdrawals ──────────────────
    // Re-checked here under the row lock because balance may have
    // changed since the teller originally submitted the request.
    if (tx.type === "withdrawal") {
      const currentBalance = parseFloat(tx.account_balance);
      const minBalance     = parseFloat(tx.minimum_balance || 0);

      if (numericAmount > currentBalance)
        throw Object.assign(
          new Error(
            `Insufficient balance. Current: GHS ${currentBalance.toFixed(2)}, Requested: GHS ${numericAmount.toFixed(2)}`
          ),
          { status: 400, code: "insufficient_balance" }
        );

      if (currentBalance - numericAmount < minBalance)
        throw Object.assign(
          new Error(
            `Minimum balance violation. Balance after withdrawal would be GHS ${(currentBalance - numericAmount).toFixed(2)}, minimum is GHS ${minBalance.toFixed(2)}`
          ),
          { status: 400, code: "minimum_balance" }
        );
    }

    // ── Accounting period check ───────────────────────────
    // The JE must land in the period covering transaction_date.
    // If that period is closed the supervisor must reopen it first.
    // const periodRes = await client.query(
    //   `SELECT id, status, name
    //    FROM accounting_periods
    //    WHERE company_id = $1
    //      AND start_date <= $2
    //      AND end_date   >= $2
    //    LIMIT 1`,
    //   [companyId, entryDate]
    // );

    // if (periodRes.rowCount === 0)
    //   throw Object.assign(
    //     new Error(`No accounting period found covering ${entryDate}. Please create or check your periods.`),
    //     { status: 400, code: "no_period" }
    //   );

    // const period = periodRes.rows[0];

    // if (period.status === "closed")
    //   throw Object.assign(
    //     new Error(
    //       `The accounting period "${period.name}" covering ${entryDate} is closed. Reopen it before approving this transaction.`
    //     ),
    //     { status: 400, code: "period_closed" }
    //   );

    // const periodId = period.id;

    // ── Resolve COA accounts ──────────────────────────────
    const cashCode    = cashCoaCode(tx.payment_method, tx.type === "withdrawal" ? "teller" : null);
    const depositCode = depositCoaCode(tx.account_type);
    const cashCoaId    = await resolveCOA(client, companyId, cashCode);
    const depositCoaId = await resolveCOA(client, companyId, depositCode);

    // ── Post journal entry ────────────────────────────────
    let newJeId;

    if (tx.type === "deposit") {
      if (!isLoan) {
        // ── BACKDATED DEPOSIT (savings / susu) ─────────────
        //   Dr  Cash / Float          (asset ↑)
        //   Cr  Customer Deposits     (liability ↑)
        await postJournalEntry(client, {
          companyId:   companyId,
          description: tx.description || `Backdated deposit — ${tx.account_type}`,
          entryDate,
          source:      "customer_deposit",
          sourceId:    tx.id,
          sourceTable: "transactions",
          createdBy:   approved_by,
          lines: [
            {
              coaId:      cashCoaId,
              dc:         "debit",
              amount:     numericAmount,
              customerId: tx.customer_id,
              accountId:  tx.account_id,
              staffId:    tx.staff_id || approved_by,
            },
            {
              coaId:      depositCoaId,
              dc:         "credit",
              amount:     numericAmount,
              customerId: tx.customer_id,
              accountId:  tx.account_id,
              staffId:    tx.staff_id || approved_by,
            },
          ],
        });
      } else {
        // ── BACKDATED LOAN REPAYMENT ────────────────────────
        //   Dr  Cash / Float          (asset ↑)
        //   Cr  Loan Receivable       (asset ↓)
        const loanReceivableId = await resolveCOA(client, companyId, "1030-01");
        await postJournalEntry(client, {
          companyId:   companyId,
          description: tx.description || `Backdated loan repayment`,
          entryDate,
          source:      "loan_repayment",
          sourceId:    tx.id,
          sourceTable: "transactions",
          createdBy:   approved_by,
          lines: [
            {
              coaId:      cashCoaId,
              dc:         "debit",
              amount:     numericAmount,
              customerId: tx.customer_id,
              accountId:  tx.account_id,
            },
            {
              coaId:      loanReceivableId,
              dc:         "credit",
              amount:     numericAmount,
              customerId: tx.customer_id,
              accountId:  tx.account_id,
            },
          ],
        });
      }

      // Fetch the JE that postJournalEntry just created so we can
      // pin its ID on the transaction record.
      const jeRes = await client.query(
        `SELECT id FROM journal_entries
         WHERE source_id    = $1
           AND source_table = 'transactions'
           AND company_id   = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [tx.id, companyId]
      );
      newJeId = jeRes.rows[0]?.id || null;

      // ── Update balance for backdated deposit ─────────────
      const balanceOp = isLoan ? "balance - $1" : "balance + $1";
      await client.query(
        `UPDATE accounts
         SET balance = ${balanceOp}, last_activity_at = NOW()
         WHERE id = $2`,
        [numericAmount, tx.account_id]
      );

    } else {
      // ── BACKDATED WITHDRAWAL ───────────────────────────────
      // Insert JE directly as 'posted' — approval IS the posting event.
      //
      //   Dr  Customer Deposits     (liability ↓)
      //   Cr  Cash / Teller Float   (asset ↓)
      const refRes = await client.query(
        "SELECT generate_journal_ref($1) AS ref",
        [companyId]
      );
      const ref = refRes.rows[0].ref;

      const jeInsert = await client.query(
        `INSERT INTO journal_entries
           (company_id, reference_no, description, entry_date,
            source, source_id, source_table, period_id,
            status, created_by, posted_by, posted_at)
         VALUES ($1,$2,$3,$4,'customer_withdrawal',$5,'transactions', 'posted',$7,$7,NOW())
         RETURNING id`,
        [
          companyId, ref,
          tx.description || `Backdated withdrawal — ${tx.account_type}`,
          entryDate,
          tx.id, approved_by,
        ]
      );
      newJeId = jeInsert.rows[0].id;

      await client.query(
        `INSERT INTO journal_entry_lines
           (journal_entry_id, coa_id, debit_credit, amount, customer_id, account_id, staff_id)
         VALUES ($1,$2,'debit',$3,$4,$5,$6)`,
        [newJeId, depositCoaId, numericAmount, tx.customer_id, tx.account_id, tx.staff_id || approved_by]
      );
      await client.query(
        `INSERT INTO journal_entry_lines
           (journal_entry_id, coa_id, debit_credit, amount, customer_id, account_id, staff_id)
         VALUES ($1,$2,'credit',$3,$4,$5,$6)`,
        [newJeId, cashCoaId, numericAmount, tx.customer_id, tx.account_id, tx.staff_id || approved_by]
      );

      // ── Deduct balance for backdated withdrawal ───────────
      await client.query(
        `UPDATE accounts
         SET balance = balance - $1, last_activity_at = NOW()
         WHERE id = $2`,
        [numericAmount, tx.account_id]
      );
    }

    // ── Stamp the transaction as approved / completed ─────
    const updatedTx = await client.query(
      `UPDATE transactions
       SET status            = 'completed',
           processing_status = 'paid',
           accounting_je_id  = $1,
           approved_by       = $2,
           approved_at       = NOW()
       WHERE id = $3
       RETURNING *`,
      [newJeId, approved_by, transactionId]
    );

    // ── Return fresh account balance ──────────────────────
    const updatedAcc = await client.query(
      `SELECT id, account_type, balance FROM accounts WHERE id = $1`,
      [tx.account_id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status:           "success",
      message:          `Backdated ${tx.type} approved — journal entry posted for ${entryDate}`,
      transaction:      updatedTx.rows[0],
      updatedAccount:   updatedAcc.rows[0],
      journal_entry_id: newJeId,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("approveBackdatedTransaction error:", err);
    return res.status(err.status || 500).json({
      status:  err.status === 400 ? "fail" : "error",
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────
// POST /api/transactions/:companyId/pending-backdated/:transactionId/reject
//
// Rejects a backdated pending transaction.
// No balance or journal entry changes needed — just stamp it.
// Optionally accepts a rejection reason.
// ─────────────────────────────────────────────────────────────
export const rejectBackdatedTransaction = async (req, res) => {
  const { companyId, transactionId } = req.params;
  const { rejected_by, reason } = req.body;

  if (!rejected_by)
    return res.status(400).json({ status: "fail", message: "rejected_by is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const txRes = await client.query(
      `SELECT t.*, a.account_type
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.id = $1 AND t.company_id = $2
       FOR UPDATE OF t`,
      [transactionId, companyId]
    );

    if (txRes.rowCount === 0)
      throw Object.assign(new Error("Transaction not found"), { status: 404 });

    const tx = txRes.rows[0];

    if (tx.status !== "pending")
      throw Object.assign(
        new Error(`Transaction is already '${tx.status}' — cannot reject`),
        { status: 400 }
      );

    // Verify it is actually a backdated transaction
    const createdDateStr     = new Date(tx.created_at).toISOString().slice(0, 10);
    const transactionDateStr = new Date(tx.transaction_date).toISOString().slice(0, 10);

    if (transactionDateStr === createdDateStr)
      throw Object.assign(
        new Error("This is a same-day transaction. Use the standard rejectTransaction endpoint."),
        { status: 400 }
      );

    // No balance or JE changes — simply mark as rejected.
    const updatedTx = await client.query(
      `UPDATE transactions
       SET status      = 'rejected',
           description = COALESCE(description, '') || CASE WHEN $1 IS NOT NULL THEN ' | Rejected: ' || $1 ELSE '' END,
           approved_by = $2,
           approved_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [reason || null, rejected_by, transactionId]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status:      "success",
      message:     `Backdated ${tx.type} rejected`,
      transaction: updatedTx.rows[0],
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("rejectBackdatedTransaction error:", err);
    return res.status(err.status || 500).json({
      status:  err.status === 400 ? "fail" : "error",
      message: err.message,
    });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────
// BULK APPROVE — POST /api/transactions/:companyId/pending-backdated/bulk-approve
//
// Approves multiple backdated transactions in one request.
// Each transaction is processed in its own savepoint so a single
// failure does not roll back the others.
//
// Body: { transaction_ids: string[], approved_by: string }
// ─────────────────────────────────────────────────────────────
export const bulkApproveBackdatedTransactions = async (req, res) => {
  const { companyId } = req.params;
  const { transaction_ids, approved_by } = req.body;

  if (!approved_by)
    return res.status(400).json({ status: "fail", message: "approved_by is required" });

  if (!Array.isArray(transaction_ids) || transaction_ids.length === 0)
    return res.status(400).json({ status: "fail", message: "transaction_ids must be a non-empty array" });

  if (transaction_ids.length > 100)
    return res.status(400).json({ status: "fail", message: "Maximum 100 transactions per bulk approval" });

  const client = await pool.connect();
  const results = { approved: [], failed: [] };

  try {
    await client.query("BEGIN");

    for (const txId of transaction_ids) {
      // Use a savepoint per transaction so one failure is isolated
      await client.query(`SAVEPOINT sp_${txId.replace(/-/g, "_")}`);

      try {
        // ── Fetch & lock ────────────────────────────────────
        const txRes = await client.query(
          `SELECT t.*, a.balance AS account_balance, a.minimum_balance,
                  a.account_type, a.status AS account_status, a.customer_id
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           WHERE t.id = $1 AND t.company_id = $2
           FOR UPDATE OF t`,
          [txId, companyId]
        );

        if (txRes.rowCount === 0) throw new Error("Transaction not found");

        const tx = txRes.rows[0];
        if (tx.status !== "pending") throw new Error(`Already ${tx.status}`);
        if (tx.accounting_je_id)     throw new Error("Has existing JE — use standard approveTransaction");

        const createdDateStr     = new Date(tx.created_at).toISOString().slice(0, 10);
        const transactionDateStr = new Date(tx.transaction_date).toISOString().slice(0, 10);
        if (transactionDateStr === createdDateStr) throw new Error("Same-day transaction — use standard endpoint");

        const numericAmount = parseFloat(tx.amount);
        const isLoan        = tx.account_type.toLowerCase().includes("loan");
        const entryDate     = transactionDateStr;

        // ── Balance check (withdrawals) ─────────────────────
        if (tx.type === "withdrawal") {
          const bal    = parseFloat(tx.account_balance);
          const minBal = parseFloat(tx.minimum_balance || 0);
          if (numericAmount > bal)
            throw new Error(`Insufficient balance (${bal.toFixed(2)})`);
          if (bal - numericAmount < minBal)
            throw new Error(`Minimum balance violation`);
        }

        // ── Period check ────────────────────────────────────
        // const periodRes = await client.query(
        //   `SELECT id, status FROM accounting_periods
        //    WHERE company_id = $1 AND start_date <= $2 AND end_date >= $2 LIMIT 1`,
        //   [companyId, entryDate]
        // );
        // if (periodRes.rowCount === 0) throw new Error(`No accounting period for ${entryDate}`);
        // if (periodRes.rows[0].status === "closed") throw new Error(`Period closed for ${entryDate}`);
        // const periodId = periodRes.rows[0].id;

        // ── COA ────────────────────────────────────────────
        const cashCode    = cashCoaCode(tx.payment_method, tx.type === "withdrawal" ? "teller" : null);
        const depositCode = depositCoaCode(tx.account_type);
        const cashCoaId    = await resolveCOA(client, companyId, cashCode);
        const depositCoaId = await resolveCOA(client, companyId, depositCode);

        let newJeId;

        if (tx.type === "deposit") {
          if (!isLoan) {
            await postJournalEntry(client, {
              companyId, description: tx.description || `Backdated deposit — ${tx.account_type}`,
              entryDate, source: "customer_deposit", sourceId: tx.id,
              sourceTable: "transactions", createdBy: approved_by,
              lines: [
                { coaId: cashCoaId,    dc: "debit",  amount: numericAmount, customerId: tx.customer_id, accountId: tx.account_id },
                { coaId: depositCoaId, dc: "credit", amount: numericAmount, customerId: tx.customer_id, accountId: tx.account_id },
              ],
            });
          } else {
            const loanReceivableId = await resolveCOA(client, companyId, "1030-01");
            await postJournalEntry(client, {
              companyId, description: tx.description || `Backdated loan repayment`,
              entryDate, source: "loan_repayment", sourceId: tx.id,
              sourceTable: "transactions", createdBy: approved_by,
              lines: [
                { coaId: cashCoaId,        dc: "debit",  amount: numericAmount, customerId: tx.customer_id, accountId: tx.account_id },
                { coaId: loanReceivableId,  dc: "credit", amount: numericAmount, customerId: tx.customer_id, accountId: tx.account_id },
              ],
            });
          }
          const jeRes = await client.query(
            `SELECT id FROM journal_entries WHERE source_id=$1 AND source_table='transactions' AND company_id=$2 ORDER BY created_at DESC LIMIT 1`,
            [tx.id, companyId]
          );
          newJeId = jeRes.rows[0]?.id || null;

          const balanceOp = isLoan ? "balance - $1" : "balance + $1";
          await client.query(`UPDATE accounts SET balance = ${balanceOp}, last_activity_at=NOW() WHERE id=$2`, [numericAmount, tx.account_id]);

        } else {
          const refRes = await client.query("SELECT generate_journal_ref($1) AS ref", [companyId]);
          const jeInsert = await client.query(
            `INSERT INTO journal_entries (company_id,reference_no,description,entry_date,source,source_id,source_table,period_id,status,created_by,posted_by,posted_at)
             VALUES ($1,$2,$3,$4,'customer_withdrawal',$5,'transactions', 'posted',$7,$7,NOW()) RETURNING id`,
            [companyId, refRes.rows[0].ref, tx.description || `Backdated withdrawal — ${tx.account_type}`, entryDate, tx.id, approved_by]
          );
          newJeId = jeInsert.rows[0].id;
          await client.query(`INSERT INTO journal_entry_lines (journal_entry_id,coa_id,debit_credit,amount,customer_id,account_id,staff_id) VALUES ($1,$2,'debit',$3,$4,$5,$6)`,  [newJeId, depositCoaId, numericAmount, tx.customer_id, tx.account_id, tx.staff_id || approved_by]);
          await client.query(`INSERT INTO journal_entry_lines (journal_entry_id,coa_id,debit_credit,amount,customer_id,account_id,staff_id) VALUES ($1,$2,'credit',$3,$4,$5,$6)`, [newJeId, cashCoaId,    numericAmount, tx.customer_id, tx.account_id, tx.staff_id || approved_by]);
          await client.query(`UPDATE accounts SET balance = balance - $1, last_activity_at=NOW() WHERE id=$2`, [numericAmount, tx.account_id]);
        }

        await client.query(
          `UPDATE transactions SET status='completed', processing_status='paid', accounting_je_id=$1, approved_by=$2, approved_at=NOW() WHERE id=$3`,
          [newJeId, approved_by, txId]
        );

        await client.query(`RELEASE SAVEPOINT sp_${txId.replace(/-/g, "_")}`);
        results.approved.push({ transaction_id: txId, journal_entry_id: newJeId });

      } catch (innerErr) {
        await client.query(`ROLLBACK TO SAVEPOINT sp_${txId.replace(/-/g, "_")}`);
        results.failed.push({ transaction_id: txId, reason: innerErr.message });
      }
    }

    await client.query("COMMIT");

    const statusCode = results.failed.length === 0 ? 200 : results.approved.length === 0 ? 400 : 207;
    return res.status(statusCode).json({
      status:  results.failed.length === 0 ? "success" : results.approved.length === 0 ? "fail" : "partial",
      message: `${results.approved.length} approved, ${results.failed.length} failed`,
      results,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("bulkApproveBackdatedTransactions error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};