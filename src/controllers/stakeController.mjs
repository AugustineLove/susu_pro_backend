import pool from "../db.mjs";
import {
  postJournalEntry,
  resolveCOA,
  cashCoaCode,
  depositCoaCode,
} from "../services/accountingHelper.mjs";

// ─────────────────────────────────────────────────────────────
// stakeMoney  (deposit OR withdrawal)
// ─────────────────────────────────────────────────────────────
//
// DEPOSIT
//   Dr  Cash / MoMo float   (1010-02 | 1010-03 | 1020-01)
//   Cr  Customer deposits   (2010-01 | 2010-02)
//
// WITHDRAWAL  (stays pending until approved)
//   No balance movement yet — balance is deducted in approveTransaction.
//   We still post a DRAFT journal entry so the intent is recorded.
//   The draft gets POSTED when the withdrawal is approved.
// ─────────────────────────────────────────────────────────────
export const stakeMoney = async (req, res) => {
  const {
    account_id,
    amount,
    staked_by,
    company_id,
    transaction_type,
    description,
    unique_code,
    transaction_date,
    staff_id,
    withdrawal_type,
    payment_method,
  } = req.body;

  // ── Validation ────────────────────────────────────────────
  if (!account_id || !amount || !staked_by || !company_id || !transaction_type)
    return res.status(400).json({ status: "fail", message: "Required fields missing" });

  if (!["deposit", "withdrawal"].includes(transaction_type))
    return res.status(400).json({ status: "fail", message: "transaction_type must be 'deposit' or 'withdrawal'" });

  if (payment_method && !["momo", "cash", "bank"].includes(payment_method))
    return res.status(400).json({ status: "fail", message: "Invalid payment_method" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Fetch the savings account ─────────────────────────
    const accRes = await client.query(
      `SELECT a.id, a.balance, a.account_type, a.minimum_balance, a.status, a.customer_id
       FROM accounts a WHERE a.id = $1`,
      [account_id]
    );
    if (accRes.rowCount === 0) throw Object.assign(new Error("Account not found"), { status: 404 });

    const account       = accRes.rows[0];
    const numericAmount = parseFloat(amount);

    if (account.status === "Inactive")
      throw Object.assign(new Error("Account is inactive"), { status: 400 });
    if (numericAmount <= 0)
      throw Object.assign(new Error("Amount must be greater than 0"), { status: 400 });

    // ── Withdrawal pre-checks ────────────────────────────
    if (transaction_type === "withdrawal") {
      if (numericAmount > parseFloat(account.balance))
        throw Object.assign(new Error("Insufficient balance"), { status: 400, code: "insufficient_balance" });
      if (numericAmount > parseFloat(account.balance) - parseFloat(account.minimum_balance || 0))
        throw Object.assign(new Error("Minimum balance violation"), { status: 400, code: "minimum_balance" });
    }

    // ── Record stake ──────────────────────────────────────
    await client.query(
      `INSERT INTO stakes (account_id, amount, staked_by) VALUES ($1,$2,$3)`,
      [account_id, numericAmount, staked_by]
    );

    // ── Determine transaction status ──────────────────────
    let txStatus         = "completed";
    let processing_status = null;

    const isLoan = account.account_type.toLowerCase().includes("loan");

    if (transaction_type === "deposit") {
      // Deposits update balance immediately
      const balanceOp = isLoan ? "balance - $1" : "balance + $1";
      await client.query(
        `UPDATE accounts SET balance = ${balanceOp}, last_activity_at = NOW() WHERE id = $2`,
        [numericAmount, account_id]
      );
      processing_status = "paid";
    }

    if (transaction_type === "withdrawal") {
      // Balance is NOT deducted yet — happens on approveTransaction
      txStatus          = "pending";
      processing_status = payment_method === "momo" ? "pending" : "paid";
    }

    // ── Insert transaction record ─────────────────────────
    const txFields = [
      "account_id","amount","type","status","processing_status",
      "payment_method","created_by","company_id","description",
      "unique_code","staff_id","withdrawal_type"
    ];
    const txValues = [
      account_id, numericAmount, transaction_type, txStatus, processing_status,
      payment_method || null, staked_by, company_id, description,
      unique_code, staff_id, withdrawal_type,
    ];

    if (transaction_date) {
      txFields.push("transaction_date");
      txValues.push(transaction_date);
    }

    const placeholders = txValues.map((_, i) => `$${i + 1}`);
    const txRes = await client.query(
      `INSERT INTO transactions (${txFields.join(",")}) VALUES (${placeholders.join(",")}) RETURNING *`,
      txValues
    );
    const tx = txRes.rows[0];

    // ── Resolve COA accounts ──────────────────────────────
    const cashCode    = cashCoaCode(payment_method, 'teller');
    const depositCode = depositCoaCode(account.account_type);

    const cashCoaId    = await resolveCOA(client, company_id, cashCode);
    const depositCoaId = await resolveCOA(client, company_id, depositCode);

    const entryDate = transaction_date
      ? new Date(transaction_date).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    // ── Post journal entry ────────────────────────────────
    if (transaction_type === "deposit") {
      // ── DEPOSIT ──
      // Dr Cash/Float   — asset increases
      // Cr Cust Deposits — liability increases
      if (!isLoan) {
        await postJournalEntry(client, {
          companyId:   company_id,
          description: description || `Customer deposit — ${account.account_type}`,
          entryDate,
          source:      "customer_deposit",
          sourceId:    tx.id,
          sourceTable: "transactions",
          createdBy:   staked_by,
          lines: [
            {
              coaId:      cashCoaId,
              dc:         "debit",
              amount:     numericAmount,
              customerId: account.customer_id,
              accountId:  account_id,
              staffId:    staff_id || staked_by,
            },
            {
              coaId:      depositCoaId,
              dc:         "credit",
              amount:     numericAmount,
              customerId: account.customer_id,
              accountId:  account_id,
              staffId:    staff_id || staked_by,
            },
          ],
        });
      } else {
        // Loan repayment deposit:
        // Dr Cash/Float         — asset increases (we received money)
        // Cr Loan Receivable    — asset decreases (loan balance paid down)
        const loanReceivableId = await resolveCOA(client, company_id, "1030-01");
        await postJournalEntry(client, {
          companyId:   company_id,
          description: description || `Loan repayment`,
          entryDate,
          source:      "loan_repayment",
          sourceId:    tx.id,
          sourceTable: "transactions",
          createdBy:   staked_by,
          lines: [
            {
              coaId: cashCoaId,       dc: "debit",  amount: numericAmount,
              customerId: account.customer_id, accountId: account_id,
            },
            {
              coaId: loanReceivableId, dc: "credit", amount: numericAmount,
              customerId: account.customer_id, accountId: account_id,
            },
          ],
        });
      }
    }

    if (transaction_type === "withdrawal") {
      // ── WITHDRAWAL (PENDING) ──
      // We record a DRAFT entry now — it gets posted in approveTransaction.
      // This keeps the audit trail from the moment the request is submitted.
      // Dr Customer Deposits  — liability will decrease (debit reduces credit-normal account)
      // Cr Cash / Float       — asset will decrease
      //
      // Note: we post as DRAFT here, approveTransaction will flip it to posted.
      const refRes = await client.query(
        "SELECT generate_journal_ref($1) AS ref", [company_id]
      );
      const ref = refRes.rows[0].ref;

      const periodRes = await client.query(
        `SELECT id FROM accounting_periods
         WHERE company_id = $1 AND status = 'open'
           AND start_date <= $2 AND end_date >= $2
         LIMIT 1`,
        [company_id, entryDate]
      );
      const periodId = periodRes.rows[0]?.id || null;

      const pendingJe = await client.query(
        `INSERT INTO journal_entries
           (company_id, reference_no, description, entry_date,
            source, source_id, source_table, period_id, status, created_by)
         VALUES ($1,$2,$3,$4,'customer_withdrawal',$5,'transactions',$6,'draft',$7)
         RETURNING id`,
        [company_id, ref,
         description || `Withdrawal request — ${account.account_type}`,
         entryDate, tx.id, periodId, staked_by]
      );
      const pendingJeId = pendingJe.rows[0].id;

      // explicit line inserts — debit side
      await client.query(
        `INSERT INTO journal_entry_lines
           (journal_entry_id, coa_id, debit_credit, amount, customer_id, account_id, staff_id)
         VALUES ($1,$2,'debit',$3,$4,$5,$6)`,
        [pendingJeId, depositCoaId, numericAmount, account.customer_id, account_id, staff_id || staked_by]
      );
      await client.query(
        `INSERT INTO journal_entry_lines
           (journal_entry_id, coa_id, debit_credit, amount, customer_id, account_id, staff_id)
         VALUES ($1,$2,'credit',$3,$4,$5,$6)`,
        [pendingJeId, cashCoaId, numericAmount, account.customer_id, account_id, staff_id || staked_by]
      );

      // Store je id on the transaction so approveTransaction can find it
      await client.query(
        `UPDATE transactions SET accounting_je_id = $1 WHERE id = $2`,
        [pendingJeId, tx.id]
      );
    }

    // ── Fetch final account state ─────────────────────────
    const updatedAcc = await client.query(
      `SELECT id, account_type, balance FROM accounts WHERE id = $1`,
      [account_id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status:   "success",
      message:  transaction_type === "deposit" ? "Deposit successful" : "Withdrawal request submitted",
      transaction:    tx,
      updatedAccount: updatedAcc.rows[0],
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("stakeMoney error:", err);
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
// deductCommission
// ─────────────────────────────────────────────────────────────
//
//   Dr  Customer deposits   (2010-01)   — liability ↓  (debit reduces it)
//   Cr  Commission income   (4020)      — income ↑
//
// ─────────────────────────────────────────────────────────────
export const deductCommission = async (req, res) => {
  const { accountId } = req.params;
  const {
    amount, description, created_by,
    created_by_type, company_id, transaction_id,
  } = req.body;

  if (!amount || amount <= 0)
    return res.status(400).json({ status: "fail", message: "Commission amount must be greater than 0" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Fetch account ────────────────────────────────────
    const accRes = await client.query(
      `SELECT a.*, a.customer_id FROM accounts a WHERE a.id = $1 AND a.company_id = $2`,
      [accountId, company_id]
    );
    if (accRes.rowCount === 0)
      throw Object.assign(new Error("Account not found or unauthorized"), { status: 404 });

    const account = accRes.rows[0];

    if (Number(account.balance) < Number(amount))
      throw Object.assign(new Error("Insufficient balance for commission deduction"), { status: 400 });

    // ── Deduct from savings balance ───────────────────────
    await client.query(
      `UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND company_id = $3`,
      [amount, accountId, company_id]
    );

    // ── Insert commission record ──────────────────────────
    const commRes = await client.query(
      `INSERT INTO commissions (account_id, customer_id, company_id, amount, transaction_id)
       VALUES ($1,
         (SELECT customer_id FROM accounts WHERE id = $1),
         (SELECT company_id  FROM accounts WHERE id = $1),
         $2, $3)
       RETURNING *`,
      [accountId, amount, transaction_id]
    );
    const commission = commRes.rows[0];

    // ── Insert commission transaction record ──────────────
    const txRes = await client.query(
      `INSERT INTO transactions
         (source_transaction_id, account_id, company_id, type,
          amount, description, created_by_type, created_by)
       VALUES ($1,$2,$3,'commission',$4,$5,$6,$7)
       RETURNING *`,
      [transaction_id, accountId, company_id, amount,
       description || "Commission deduction", created_by_type, created_by]
    );
    const tx = txRes.rows[0];

    // ── Resolve COA accounts ──────────────────────────────
    const depositCoaId    = await resolveCOA(client, company_id, depositCoaCode(account.account_type));
    const commIncomeCoaId = await resolveCOA(client, company_id, "4020");

    // ── Post journal entry ────────────────────────────────
    await postJournalEntry(client, {
      companyId:   company_id,
      description: description || "Commission deduction from customer savings",
      entryDate:   new Date().toISOString().slice(0, 10),
      source:      "commission",
      sourceId:    commission.id,
      sourceTable: "commissions",
      createdBy:   created_by,
      lines: [
        {
          coaId:      depositCoaId,
          dc:         "debit",
          amount:     Number(amount),
          description: "Reduce customer deposit liability",
          customerId: account.customer_id,
          accountId:  accountId,
        },
        {
          coaId:      commIncomeCoaId,
          dc:         "credit",
          amount:     Number(amount),
          description: "Commission income recognised",
          customerId: account.customer_id,
          accountId:  accountId,
        },
      ],
    });

    await client.query("COMMIT");

    return res.status(201).json({
      status:  "success",
      message: "Commission deducted successfully",
      data: {
        accountId,
        deducted:   amount,
        newBalance: Number(account.balance) - Number(amount),
        transaction: tx,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deductCommission error:", err.message);
    return res.status(err.status || 500).json({
      status:  err.status ? "fail" : "error",
      message: err.message,
    });
  } finally {
    client.release();
  }
};
