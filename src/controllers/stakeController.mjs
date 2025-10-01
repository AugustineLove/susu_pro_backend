import pool from "../db.mjs";

export const stakeMoney = async (req, res) => {
  const { account_id, amount, staked_by, company_id, transaction_type, description, unique_code } = req.body;

  console.log()
  if (!account_id || !amount || !staked_by || !company_id || !transaction_type) {
    return res.status(400).json({
      status: "fail",
      message:
        "All fields (account_id, amount, staked_by, company_id, transaction_type) are required",
    });
  }

  if (!["deposit", "withdrawal"].includes(transaction_type)) {
    return res.status(400).json({
      status: "fail",
      message: "Invalid transaction_type. Must be 'deposit' or 'withdrawal'",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Fetch account details
    const accRes = await client.query(
      `SELECT id, balance FROM accounts WHERE id = $1`,
      [account_id]
    );

    if (accRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Account not found",
      });
    }

    const account = accRes.rows[0];
    const numericAmount = parseFloat(amount);

    if (numericAmount <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Amount must be greater than 0",
      });
    }

    // For withdrawals: check balance but don't deduct yet
    if (transaction_type === "withdrawal" && numericAmount > account.balance) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "insufficient_balance",
        message: "Insufficient balance for withdrawal",
      });
    }

    // 1. Record the stake (optional depending on your use case)
    await client.query(
      `INSERT INTO stakes (account_id, amount, staked_by)
       VALUES ($1, $2, $3)`,
      [account_id, numericAmount, staked_by]
    );

    let status = "completed"; 

    // 2. Only update balance for deposits
    if (transaction_type === "deposit") {
      const balanceChange = numericAmount;
      await client.query(
        `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
        [balanceChange, account_id]
      );
    } else {
      status = "pending";
    }

    // 3. Record the transaction with a status
    const transactionResult = await client.query(
      `INSERT INTO transactions (account_id, amount, type, status, created_by, company_id, description, unique_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, account_id, amount, type, status`,
      [account_id, numericAmount, transaction_type, status, staked_by, company_id, description, unique_code]
    );

    // 4. Fetch updated balance
    const updatedAccountRes = await client.query(
      `SELECT id, account_type, balance FROM accounts WHERE id = $1`,
      [account_id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message:
        transaction_type === "deposit"
          ? "Deposit successful"
          : "Withdrawal request submitted for approval",
      transaction: transactionResult.rows[0],
      updatedAccount: updatedAccountRes.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error in stakeMoney:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const deductCommission = async (req, res) => {
  const { accountId } = req.params;
  const { amount, description, created_by, created_by_type, company_id } = req.body;

  console.log(accountId, amount, description, created_by_type, created_by, company_id)
  if (!amount || amount <= 0) {
    return res.status(400).json({
      status: 'fail',
      message: 'Commission amount must be greater than 0',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Check account
    const accountRes = await client.query(
      `SELECT * FROM accounts 
       WHERE id = $1 AND company_id = $2`,
      [accountId, company_id]
    );

    if (accountRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        status: 'fail',
        message: 'Account not found or unauthorized',
      });
    }

    const account = accountRes.rows[0];

    // 2. Check sufficient balance
    if (Number(account.balance) < Number(amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        status: 'fail',
        message: 'Insufficient balance for commission deduction',
      });
    }


    await client.query(
      `UPDATE accounts
       SET balance = balance - $1
       WHERE id = $2 AND company_id = $3`,
      [amount, accountId, company_id]
    );


    const txRes = await client.query(
      `INSERT INTO transactions 
        (account_id, company_id, type, amount, description, created_by_type, created_by) 
       VALUES ($1, $2, 'commission', $3, $4, $5, $6)
       RETURNING *`,
      [accountId, company_id, amount, description || 'Commission deduction', created_by_type, created_by]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      status: 'success',
      message: 'Commission deducted successfully',
      data: {
        accountId,
        deducted: amount,
        newBalance: Number(account.balance) - Number(amount),
        transaction: txRes.rows[0],
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deducting commission:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  } finally {
    client.release();
  }
};
