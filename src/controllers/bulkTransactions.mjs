import pool from "../db.mjs";

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

  // ── Top-level validation ───────────────────────────────────────────────────
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({
      status: "fail",
      message: "Request body must contain a non-empty 'transactions' array",
    });
  }

  if (transactions.length > 100) {
    return res.status(400).json({
      status: "fail",
      message: "Bulk limit exceeded. Maximum 100 transactions per request",
    });
  }

  // ── Validate each row before touching the DB ───────────────────────────────
  const validationErrors = [];

  transactions.forEach((txn, i) => {
    const { account_id, amount, staked_by, company_id, transaction_type } = txn;
    const rowErrors = [];

    if (!account_id)      rowErrors.push("account_id is required");
    if (!amount)          rowErrors.push("amount is required");
    if (!staked_by)       rowErrors.push("staked_by is required");
    if (!company_id)      rowErrors.push("company_id is required");
    if (!transaction_type) rowErrors.push("transaction_type is required");

    if (transaction_type && !["deposit", "withdrawal"].includes(transaction_type)) {
      rowErrors.push("transaction_type must be 'deposit' or 'withdrawal'");
    }

    if (amount && parseFloat(amount) <= 0) {
      rowErrors.push("amount must be greater than 0");
    }

    if (rowErrors.length) {
      validationErrors.push({ index: i, errors: rowErrors });
    }
  });

  if (validationErrors.length > 0) {
    return res.status(400).json({
      status: "fail",
      message: "Validation failed for one or more rows",
      validationErrors,
    });
  }

  // ── Process each transaction independently ─────────────────────────────────
  // Each row gets its own DB transaction so one failure doesn't roll back others.

  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < transactions.length; i++) {
    const {
      account_id,
      amount,
      staked_by,
      company_id,
      transaction_type,
      description = null,
      unique_code = "",
      transaction_date = null,
      staff_id = null,
      withdrawal_type = null,
    } = transactions[i];

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 1. Fetch account
      const accRes = await client.query(
        `SELECT id, balance, account_type, minimum_balance, status
         FROM accounts
         WHERE id = $1`,
        [account_id]
      );

      if (accRes.rowCount === 0) {
        await client.query("ROLLBACK");
        results.push({ index: i, status: "failed", message: "Account not found" });
        failed++;
        continue;
      }

      const account = accRes.rows[0];
      const numericAmount = parseFloat(amount);

      // 2. Guard: inactive account
      if (account.status === "Inactive") {
        await client.query("ROLLBACK");
        results.push({ index: i, status: "failed", message: "Account is inactive" });
        failed++;
        continue;
      }

      // 3. Guard: withdrawal balance checks
      if (transaction_type === "withdrawal") {
        if (numericAmount > account.balance) {
          await client.query("ROLLBACK");
          results.push({ index: i, status: "failed", message: "Insufficient balance for withdrawal" });
          failed++;
          continue;
        }

        if (numericAmount > account.balance - account.minimum_balance) {
          await client.query("ROLLBACK");
          results.push({ index: i, status: "failed", message: "Withdrawal would breach minimum balance" });
          failed++;
          continue;
        }
      }

      // 4. Insert stake record
      await client.query(
        `INSERT INTO stakes (account_id, amount, staked_by) VALUES ($1, $2, $3)`,
        [account_id, numericAmount, staked_by]
      );

      // 5. Update account balance
      let txnStatus = "completed";
      const accountTypeLower = account.account_type.toLowerCase();

      if (transaction_type === "deposit") {
        const balanceOp = accountTypeLower.includes("loan") ? "-" : "+";
        await client.query(
          `UPDATE accounts SET balance = balance ${balanceOp} $1 WHERE id = $2`,
          [numericAmount, account_id]
        );
      } else {
        // Withdrawals stay pending — balance deducted on approval
        txnStatus = "pending";
      }

      // 6. Insert transaction record
      let insertQuery, insertParams;

      if (transaction_date) {
        insertQuery = `
          INSERT INTO transactions (
            account_id, amount, type, status, created_by, company_id,
            description, unique_code, transaction_date, staff_id, withdrawal_type
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING id, account_id, amount, type, status, transaction_date
        `;
        insertParams = [
          account_id, numericAmount, transaction_type, txnStatus,
          staked_by, company_id, description, unique_code,
          transaction_date, staff_id, withdrawal_type,
        ];
      } else {
        insertQuery = `
          INSERT INTO transactions (
            account_id, amount, type, status, created_by, company_id,
            description, unique_code, staff_id, withdrawal_type
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id, account_id, amount, type, status, transaction_date
        `;
        insertParams = [
          account_id, numericAmount, transaction_type, txnStatus,
          staked_by, company_id, description, unique_code,
          staff_id, withdrawal_type,
        ];
      }

      const txnResult = await client.query(insertQuery, insertParams);

      // 7. Update last_activity_at
      await client.query(
        `UPDATE accounts SET last_activity_at = NOW() WHERE id = $1`,
        [account_id]
      );

      // 8. Return updated balance
      const updatedAccRes = await client.query(
        `SELECT id, account_type, balance FROM accounts WHERE id = $1`,
        [account_id]
      );

      await client.query("COMMIT");

      results.push({
        index: i,
        status: "success",
        message:
          transaction_type === "deposit"
            ? "Deposit successful"
            : "Withdrawal request submitted for approval",
        transaction: txnResult.rows[0],
        updatedAccount: updatedAccRes.rows[0],
      });
      succeeded++;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`[bulkStakeMoney] Row ${i} error:`, error.message);
      results.push({
        index: i,
        status: "failed",
        message: "Internal error processing this transaction",
        error: error.message,
      });
      failed++;
    } finally {
      client.release();
    }
  }

  // ── Build response ─────────────────────────────────────────────────────────
  const overallStatus =
    failed === 0 ? "success" : succeeded === 0 ? "fail" : "partial";

  const httpStatus = failed === 0 ? 200 : succeeded === 0 ? 400 : 207; // 207 Multi-Status for partial

  return res.status(httpStatus).json({
    status: overallStatus,
    summary: {
      total: transactions.length,
      succeeded,
      failed,
    },
    results,
  });
};
