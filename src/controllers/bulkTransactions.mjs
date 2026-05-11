import pool from "../db.mjs";
import {
  postJournalEntry,
  resolveCOA,
  cashCoaCode,
  depositCoaCode,
} from "../services/accountingHelper.mjs";
/**
 * POST /api/transactions/bulk
 *
 * Body:
 * {
 *   transactions: [
 *     {
 *       account_id, amount, transaction_type, staked_by,
 *       company_id, staff_id, description?, unique_code?,
 *       transaction_date?, withdrawal_type?
 *     },
 *     ...
 *   ]
 * }
 *
 * Response:
 * {
 *   status: "success" | "partial" | "fail",
 *   summary: { total, succeeded, failed },
 *   results: [
 *     { index, status: "success"|"failed", transaction?, updatedAccount?, message? },
 *     ...
 *   ]
 * }
 */
export const bulkStakeMoney = async (req, res) => {
  const { transactions } = req.body;

  // ── Top-level validation ──────────────────────────────
  if (!Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({
      status:  "fail",
      message: "Request body must contain a non-empty 'transactions' array",
    });

  if (transactions.length > 100)
    return res.status(400).json({
      status:  "fail",
      message: "Bulk limit exceeded. Maximum 100 transactions per request",
    });

  // ── Row-level validation (before DB) ─────────────────
  const validationErrors = [];
  transactions.forEach((txn, i) => {
    const { account_id, amount, staked_by, company_id, transaction_type } = txn;
    const errs = [];
    if (!account_id)       errs.push("account_id is required");
    if (!amount)           errs.push("amount is required");
    if (!staked_by)        errs.push("staked_by is required");
    if (!company_id)       errs.push("company_id is required");
    if (!transaction_type) errs.push("transaction_type is required");
    if (transaction_type && !["deposit","withdrawal"].includes(transaction_type))
      errs.push("transaction_type must be 'deposit' or 'withdrawal'");
    if (amount && parseFloat(amount) <= 0)
      errs.push("amount must be greater than 0");
    if (errs.length) validationErrors.push({ index: i, errors: errs });
  });

  if (validationErrors.length)
    return res.status(400).json({
      status:           "fail",
      message:          "Validation failed for one or more rows",
      validationErrors,
    });

  // ── Process each transaction independently ────────────
  const results  = [];
  let succeeded  = 0;
  let failed     = 0;

  for (let i = 0; i < transactions.length; i++) {
    const {
      account_id,
      amount,
      staked_by,
      company_id,
      transaction_type,
      description    = null,
      unique_code    = "",
      transaction_date = null,
      staff_id       = null,
      withdrawal_type = null,
      payment_method = null,
    } = transactions[i];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ── Fetch account ─────────────────────────────────
      const accRes = await client.query(
        `SELECT id, balance, account_type, minimum_balance, status, customer_id
         FROM accounts WHERE id = $1`,
        [account_id]
      );

      if (accRes.rowCount === 0) {
        await client.query("ROLLBACK");
        results.push({ index: i, status: "failed", message: "Account not found" });
        failed++; continue;
      }

      const account       = accRes.rows[0];
      const numericAmount = parseFloat(amount);

      if (account.status === "Inactive") {
        await client.query("ROLLBACK");
        results.push({ index: i, status: "failed", message: "Account is inactive" });
        failed++; continue;
      }

      if (transaction_type === "withdrawal") {
        if (numericAmount > parseFloat(account.balance)) {
          await client.query("ROLLBACK");
          results.push({ index: i, status: "failed", message: "Insufficient balance" });
          failed++; continue;
        }
        if (numericAmount > parseFloat(account.balance) - parseFloat(account.minimum_balance || 0)) {
          await client.query("ROLLBACK");
          results.push({ index: i, status: "failed", message: "Withdrawal would breach minimum balance" });
          failed++; continue;
        }
      }

      // ── Insert stake ──────────────────────────────────
      await client.query(
        `INSERT INTO stakes (account_id, amount, staked_by) VALUES ($1,$2,$3)`,
        [account_id, numericAmount, staked_by]
      );

      // ── Update balance ────────────────────────────────
      let txnStatus = "completed";
      const isLoan  = account.account_type.toLowerCase().includes("loan");

      if (transaction_type === "deposit") {
        const op = isLoan ? "-" : "+";
        await client.query(
          `UPDATE accounts SET balance = balance ${op} $1, last_activity_at = NOW() WHERE id = $2`,
          [numericAmount, account_id]
        );
      } else {
        // pending — balance deducted on approval
        txnStatus = "pending";
      }

      // ── Insert transaction record ─────────────────────
      const txFields = [
        "account_id","amount","type","status","created_by",
        "company_id","description","unique_code","staff_id","withdrawal_type","payment_method"
      ];
      const txValues = [
        account_id, numericAmount, transaction_type, txnStatus,
        staked_by, company_id, description, unique_code,
        staff_id, withdrawal_type, payment_method || null,
      ];
      if (transaction_date) {
        txFields.push("transaction_date");
        txValues.push(transaction_date);
      }
      const placeholders = txValues.map((_,k)=>`$${k+1}`);
      const txnResult = await client.query(
        `INSERT INTO transactions (${txFields.join(",")})
         VALUES (${placeholders.join(",")})
         RETURNING id, account_id, amount, type, status, transaction_date`,
        txValues
      );
      const tx = txnResult.rows[0];

      // ── Resolve COA accounts ──────────────────────────
      const cashCode    = cashCoaCode(payment_method);
      const depositCode = depositCoaCode(account.account_type);
      const cashCoaId    = await resolveCOA(client, company_id, cashCode);
      const depositCoaId = await resolveCOA(client, company_id, depositCode);

      const entryDate = transaction_date
        ? new Date(transaction_date).toISOString().slice(0,10)
        : new Date().toISOString().slice(0,10);

      // ── Post journal entry ────────────────────────────
      if (transaction_type === "deposit") {
        if (!isLoan) {
          // Standard savings deposit
          await postJournalEntry(client, {
            companyId:   company_id,
            description: description || `Bulk deposit — ${account.account_type}`,
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
          // Loan repayment via bulk
          const loanRecCoaId = await resolveCOA(client, company_id, "1030-01");
          await postJournalEntry(client, {
            companyId:   company_id,
            description: description || "Bulk loan repayment",
            entryDate,
            source:      "loan_repayment",
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
              },
              {
                coaId:      loanRecCoaId,
                dc:         "credit",
                amount:     numericAmount,
                customerId: account.customer_id,
                accountId:  account_id,
              },
            ],
          });
        }

      } else {
        // ── Pending withdrawal — park a draft JE ─────
        const refRes = await client.query(
          "SELECT generate_journal_ref($1) AS ref", [company_id]
        );
        const ref = refRes.rows[0].ref;

        const periodRes = await client.query(
          `SELECT id FROM accounting_periods
           WHERE company_id = $1 AND status = 'open'
             AND start_date <= $2 AND end_date >= $2 LIMIT 1`,
          [company_id, entryDate]
        );
        const periodId = periodRes.rows[0]?.id || null;

        const jeRes = await client.query(
          `INSERT INTO journal_entries
             (company_id, reference_no, description, entry_date,
              source, source_id, source_table, period_id, status, created_by)
           VALUES ($1,$2,$3,$4,'customer_withdrawal',$5,'transactions',$6,'draft',$7)
           RETURNING id`,
          [
            company_id, ref,
            description || `Bulk withdrawal request`,
            entryDate, tx.id, periodId, staked_by,
          ]
        );
        const jeId = jeRes.rows[0].id;

        await client.query(
          `INSERT INTO journal_entry_lines
             (journal_entry_id, coa_id, debit_credit, amount, customer_id, account_id, staff_id)
           VALUES ($1,$2,'debit',$3,$4,$5,$6)`,
          [jeId, depositCoaId, numericAmount, account.customer_id, account_id, staff_id || staked_by]
        );
        await client.query(
          `INSERT INTO journal_entry_lines
             (journal_entry_id, coa_id, debit_credit, amount, customer_id, account_id, staff_id)
           VALUES ($1,$2,'credit',$3,$4,$5,$6)`,
          [jeId, cashCoaId, numericAmount, account.customer_id, account_id, staff_id || staked_by]
        );

        // Store draft JE id on the transaction
        await client.query(
          `UPDATE transactions SET accounting_je_id = $1 WHERE id = $2`,
          [jeId, tx.id]
        );
      }

      // ── Final account state ───────────────────────────
      const updatedAcc = await client.query(
        `SELECT id, account_type, balance FROM accounts WHERE id = $1`,
        [account_id]
      );

      await client.query("COMMIT");

      results.push({
        index:          i,
        status:         "success",
        message:        transaction_type === "deposit"
                          ? "Deposit successful"
                          : "Withdrawal request submitted for approval",
        transaction:    tx,
        updatedAccount: updatedAcc.rows[0],
      });
      succeeded++;

    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[bulkStakeMoney] Row ${i} error:`, err.message);
      results.push({
        index:   i,
        status:  "failed",
        message: "Internal error processing this transaction",
        error:   err.message,
      });
      failed++;
    } finally {
      client.release();
    }
  }

  // ── Response ──────────────────────────────────────────
  const overallStatus = failed === 0 ? "success" : succeeded === 0 ? "fail" : "partial";
  const httpStatus    = failed === 0 ? 200 : succeeded === 0 ? 400 : 207;

  return res.status(httpStatus).json({
    status:  overallStatus,
    summary: { total: transactions.length, succeeded, failed },
    results,
  });
};
