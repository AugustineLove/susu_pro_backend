// controllers/transactionController.mjs
import pool from '../db.mjs';

export const getTransactionsByAccount = async (req, res) => {
  const { account_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, amount, type, description, transaction_date, created_by, company_id 
       FROM transactions 
       WHERE account_id = $1 AND is_deleted = false
       ORDER BY transaction_date DESC`,
      [account_id]
    );

    return res.status(200).json({
      status: 'success',
      results: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching account transactions:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};


export const getTransactionsByStaff = async (req, res) => {
  const { staff_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT 
    t.id,
    t.amount,
    t.type,
    t.description,
    t.status,
    t.transaction_date,
    t.account_id,
    t.company_id,
    a.account_type,
    c.company_name,
    s.full_name,
    cu.location AS customer_location,
    cu.name AS customer_name
FROM transactions t
JOIN accounts a ON t.account_id = a.id
JOIN companies c ON t.company_id = c.id
JOIN staff s ON t.created_by = s.id
JOIN customers cu ON a.customer_id = cu.id
WHERE t.created_by = $1 AND t.is_deleted = false
ORDER BY t.transaction_date DESC;
`,
      [staff_id]
    );

    return res.status(200).json({
      status: 'success',
      results: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching staff transactions:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getTransactionsByCustomer = async (req, res) => {
  const { customerId } = req.params;

  try {
    // Get all account IDs for the customer
    const accountsResult = await pool.query(
      'SELECT id FROM accounts WHERE customer_id = $1 AND is_deleted = false',
      [customerId]
    );

    if (accountsResult.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No accounts found for this customer.',
      });
    }

    const accountIds = accountsResult.rows.map((acc) => acc.id);

    // Fetch transactions for those account IDs
    const transactionsResult = await pool.query(
      `SELECT t.*, a.account_type
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE t.account_id = ANY($1::uuid[])
      ORDER BY t.transaction_date DESC;`,
      [accountIds]
    );

    return res.status(200).json({
      status: 'success',
      results: transactionsResult.rowCount,
      data: transactionsResult.rows,
    });
  } catch (error) {
    console.error('Error fetching customer transactions:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};


export const getCompanyTransactions = async (req, res) => {
  const { company_id } = req.params;

  if (!company_id) {
    return res.status(400).json({
      status: 'fail',
      message: 'Company ID is required',
    });
  }

  try {
    const result = await pool.query(
      `SELECT t.*, a.account_type, c.name AS customer_name, s.full_name AS staff_name
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN customers c ON a.customer_id = c.id
       LEFT JOIN staff s ON t.created_by = s.id
       WHERE t.company_id = $1 AND t.is_deleted = false
       ORDER BY t.transaction_date DESC`,
      [company_id]
    );

    return res.status(200).json({
      status: 'success',
      transactions: result.rows,
    });
  } catch (error) {
    console.error('Error fetching company transactions:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getRecentTransactions = async (req, res) => {
  try {
    const { company_id } = req.params;

    const result = await pool.query({ text: `
      SELECT 
  t.id AS transaction_id,
  t.amount,
  t.type,
  t.description,
  t.status,
  t.unique_code,
  t.transaction_date,
  t.reversed_at,
  t.reversal_reason,
  t.reversed_by,
  t.is_deleted,

  a.id AS account_id,
  a.customer_id AS customer_id,
  a.account_type AS account_type,
  a.account_number AS account_number,

  c.name AS customer_name,
  c.phone_number AS customer_phone,
  c.account_number AS customer_account_number,

  -- Mobile Banker (created_by)
  mb.id AS mobile_banker_id,
  mb.full_name AS mobile_banker_name,

  -- Recording Staff (staff_id)
  rs.id AS recorded_staff_id,
  rs.full_name AS recorded_staff_name,

  str.full_name AS reversed_by_name

FROM transactions t

LEFT JOIN staff str
  ON t.reversed_by = str.id

-- Mobile banker who created it
LEFT JOIN staff mb 
  ON t.created_by = mb.id

-- Staff who recorded / approved it
LEFT JOIN staff rs 
  ON t.staff_id = rs.id

JOIN accounts a 
  ON t.account_id = a.id

JOIN customers c 
  ON a.customer_id = c.id

WHERE 
  t.company_id = $1 

ORDER BY 
  t.transaction_date DESC;

    `, values: [company_id], statement_timeout: 120000});
    // console.log(result.rows);
    res.status(200).json({ status: 'success', data: result.rows });

  } catch (error) {
    console.error('Error fetching recent transactions:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch transactions' });
  }
};

export const approveTransaction = async (req, res) => {
  const transactionId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =====================================================
     * 1. Fetch transaction
     * =================================================== */
    const txRes = await client.query(
      `
      SELECT id, account_id, amount, type, status, created_by
      FROM transactions
      WHERE id = $1
      `,
      [transactionId]
    );

    if (txRes.rowCount === 0) {
      throw new Error("Transaction not found");
    }

    const transaction = txRes.rows[0];

    if (transaction.type !== "withdrawal" || transaction.status !== "pending") {
      throw new Error("Only pending withdrawals can be approved");
    }

    const amount = parseFloat(transaction.amount);

    /* =====================================================
     * 2. Fetch account, customer & company
     * =================================================== */
    const accRes = await client.query(
      `
      SELECT 
        a.id,
        a.balance,
        a.company_id,
        c.id AS customer_id
      FROM accounts a
      JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1
      `,
      [transaction.account_id]
    );

    if (accRes.rowCount === 0) {
      throw new Error("Associated account not found");
    }

    const account = accRes.rows[0];

    if (amount > account.balance) {
      throw new Error("Insufficient account balance");
    }

    /* =====================================================
     * 3. Deduct from account
     * =================================================== */
    await client.query(
      `
      UPDATE accounts
      SET balance = balance - $1
      WHERE id = $2
      `,
      [amount, account.id]
    );

    /* =====================================================
     * 4. Approve transaction
     * =================================================== */
    await client.query(
      `
      UPDATE transactions
      SET status = 'approved'
      WHERE id = $1
      `,
      [transaction.id]
    );

    /* =====================================================
     * 5. Deduct from float (ALLOW NEGATIVE)
     *    + record float_movements
     * =================================================== */
    const today = new Date().toISOString().split("T")[0];

    const budgetRes = await client.query(
      `
      SELECT id, allocated, spent
      FROM budgets
      WHERE company_id = $1
      AND date = $2
      ORDER BY id ASC
      `,
      [account.company_id, today]
    );

    let remaining = amount;

    if (budgetRes.rowCount > 0) {
      for (const budget of budgetRes.rows) {
        if (remaining <= 0) break;

        const available = budget.allocated - budget.spent;
        let deducted = 0;

        if (available > 0) {
          if (remaining <= available) {
            deducted = remaining;
            remaining = 0;

            await client.query(
              `UPDATE budgets SET spent = spent + $1 WHERE id = $2`,
              [deducted, budget.id]
            );
          } else {
            deducted = available;
            remaining -= available;

            await client.query(
              `UPDATE budgets SET spent = allocated WHERE id = $1`,
              [budget.id]
            );
          }

          // 🔹 Record float movement
          await client.query(
            `
            INSERT INTO float_movements (
              budget_id,
              company_id,
              source_type,
              source_id,
              amount,
              direction
            )
            VALUES ($1, $2, 'withdrawal', $3, $4, 'debit')
            `,
            [budget.id, account.company_id, transaction.id, deducted]
          );
        }
      }

      // 🚨 Push negative if still remaining
      if (remaining > 0) {
        const targetBudget = budgetRes.rows[0];

        await client.query(
          `UPDATE budgets SET spent = spent + $1 WHERE id = $2`,
          [remaining, targetBudget.id]
        );

        await client.query(
          `
          INSERT INTO float_movements (
            budget_id,
            company_id,
            source_type,
            source_id,
            amount,
            direction
          )
          VALUES ($1, $2, 'withdrawal', $3, $4, 'debit')
          `,
          [targetBudget.id, account.company_id, transaction.id, remaining]
        );
      }
    } else {
      // 🚨 No float today → create NEGATIVE float
      const { rows } = await client.query(
        `
        INSERT INTO budgets (company_id, date, allocated, spent)
        VALUES ($1, $2, 0, $3)
        RETURNING id
        `,
        [account.company_id, today, amount]
      );

      await client.query(
        `
        INSERT INTO float_movements (
          budget_id,
          company_id,
          source_type,
          source_id,
          amount,
          direction
        )
        VALUES ($1, $2, 'withdrawal', $3, $4, 'debit')
        `,
        [rows[0].id, account.company_id, transaction.id, amount]
      );
    }

    /* =====================================================
     * 6. Commit
     * =================================================== */
    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Withdrawal approved successfully",
      data: {
        transaction_id: transaction.id,
        withdrawn: amount,
        newBalance: account.balance - amount,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Approve transaction error:", error.message);

    return res.status(400).json({
      status: "fail",
      message: error.message,
    });
  } finally {
    client.release();
  }
};


export const rejectTransaction = async (req, res) => {
  const transactionId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Fetch the transaction
    const txRes = await client.query(
      `SELECT id, type, status FROM transactions WHERE id = $1`,
      [transactionId]
    );

    if (txRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Transaction not found",
      });
    }

    const transaction = txRes.rows[0];

    // 2. Ensure it's a pending withdrawal
    if (transaction.type !== "withdrawal" || transaction.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Only pending withdrawals can be rejected",
      });
    }

    // 3. Update status to rejected
    await client.query(
      `UPDATE transactions SET status = 'rejected' WHERE id = $1`,
      [transaction.id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Withdrawal request rejected successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error rejecting transaction:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
};


export const deleteTransaction = async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.body;
  console.log(`Delete transaction id: ${id}`);
  if (!id) {
    return res.status(400).json({
      status: 'fail',
      message: 'Transaction ID is required',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `SELECT * FROM transactions 
       WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );

    if (txResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        status: 'fail',
        message: 'Transaction not found or not authorized',
      });
    }

    const transaction = txResult.rows[0];

    // 2. Update the account balance
    if (transaction.account_id) {
      let adjustment = 0;

      if (transaction.type === 'deposit') {
        adjustment = -Number(transaction.amount); // remove deposit
      } else if (transaction.type === 'withdrawal' || transaction.type === 'expense') {
        adjustment = Number(transaction.amount); // add back withdrawal/expense
      }

      await client.query(
        `UPDATE accounts
         SET balance = balance + $1
         WHERE id = $2 AND company_id = $3`,
        [adjustment, transaction.account_id, company_id]
      );
    }

    // 3. Delete the transaction
    await client.query(
       `
  UPDATE transactions
SET 
  is_deleted = TRUE,
  deleted_at = NOW(),
  status = 'reversed'
WHERE id = $1
  AND company_id = $2
  AND is_deleted = FALSE;

  `,
      [id, company_id]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      status: 'success',
      message: 'Transaction deleted and account balance updated',
      data: transaction,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting transaction:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  } finally {
    client.release();
  }
};

export const reverseWithdrawal = async (req, res) => {
  const { transactionId } = req.params;
  const { reason, staffId } = req.body;
  // const staffId = req.user?.id; // from auth middleware
  if (!staffId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* 1️⃣ Fetch transaction */
    const txRes = await client.query(
      `
      SELECT id, amount, account_id, status, type
      FROM transactions
      WHERE id = $1
      FOR UPDATE
      `,
      [transactionId]
    );

    if (txRes.rowCount === 0) {
      throw new Error("Transaction not found");
    }

    const transaction = txRes.rows[0];

    if (transaction.type !== "withdrawal") {
      throw new Error("Only withdrawals can be reversed");
    }

    if (transaction.status !== "approved") {
      throw new Error("Only approved withdrawals can be reversed");
    }

    /* 3️⃣ Fetch float movements tied to this withdrawal */
    const floatRes = await client.query(
      `
      SELECT id, budget_id, amount
      FROM float_movements
      WHERE source_type = 'withdrawal'
        AND source_id = $1
        AND direction = 'debit'
      `,
      [transactionId]
    );

    /* 4️⃣ Reverse each float movement */
    for (const movement of floatRes.rows) {
      // Restore budget
      await client.query(
        `
        UPDATE budgets
        SET spent = spent - $1
        WHERE id = $2
        `,
        [movement.amount, movement.budget_id]
      );

      // Insert reversal movement
      await client.query(
        `
        INSERT INTO float_movements (
          budget_id,
          source_type,
          source_id,
          amount,
          direction,
          company_id
        ) VALUES ($1, 'withdrawal', $2, $3, 'credit', (SELECT company_id FROM budgets WHERE id = $1))
        `,
        [movement.budget_id, transactionId, movement.amount]
      );
    }

    /* 5️⃣ Mark transaction as reversed */
    await client.query(
      `
      UPDATE transactions
      SET status = 'reversed',
          reversed_at = NOW(),
          reversed_by = $1,
          reversal_reason = $2
      WHERE id = $3
      `,
      [staffId, reason || null, transactionId]
    );

    /* 1️⃣ Fetch commission for the transaction */
const commissionResult = await client.query(
  `
  SELECT id, status, amount
  FROM commissions
  WHERE transaction_id = $1
  FOR UPDATE
  `,
  [transactionId]
);

let commissionAmount = 0;

if (commissionResult.rowCount > 0) {
  commissionAmount = parseFloat(commissionResult.rows[0].amount);
  
  console.log(`Commission amount: ${commissionAmount}`)
  await client.query(
    `
    UPDATE commissions
    SET
      status = 'reversed',
      reversed_at = NOW(),
      reversed_by = $1
    WHERE transaction_id = $2
    `,
    [staffId, transactionId]
  );

  const commissionTxRes = await client.query(
  `
  SELECT id
  FROM transactions
  WHERE source_transaction_id = $1
    AND type = 'commission'
    AND status != 'reversed'
  FOR UPDATE
  `,
  [transactionId] // withdrawal ID
);

if (commissionTxRes.rowCount === 0) {
  console.log('No commission transaction found to reverse');
} else {
  const commissionTxId = commissionTxRes.rows[0].id;
    console.log(`Commission transaction id: ${commissionTxId}`);

  // Update commission transaction row
  await client.query(
    `
    UPDATE transactions
    SET status = 'reversed',
        reversed_at = NOW(),
        reversed_by = $1,
        reversal_reason = $2
    WHERE id = $3
    `,
    [staffId, reason || null, commissionTxId]
  );

  console.log('Commission transaction reversed:', commissionTxId);
}
}



const refundAMount = Number(transaction.amount) + Number(commissionAmount);
const totalRefund = Math.round(refundAMount * 100) / 100;
await client.query(
  `
  UPDATE accounts
  SET balance = balance + $1
  WHERE id = $2
  `,
  [totalRefund, transaction.account_id]
);


console.log(`Total amount: ${totalRefund}`)
    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Withdrawal reversed successfully",
      data: {
        transactionId,
        refundedAmount: transaction.amount,
        floatRestored: floatRes.rowCount > 0
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to reverse withdrawal"
    });
  } finally {
    client.release();
  }
};

export const transferBetweenAccounts = async (req, res) => {
  const {
    from_account_id,
    to_account_id,
    amount,
    company_id,
    created_by,
    created_by_type = "staff",
    description,
  } = req.body;
  console.log(req.body);
  if (!from_account_id || !to_account_id || !amount || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid transfer data",
    });
  }

  if (from_account_id === to_account_id) {
    return res.status(400).json({
      success: false,
      message: "Cannot transfer to the same account",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* 1️⃣ Lock both accounts */
    const accountsRes = await client.query(
      `
      SELECT id, balance
      FROM accounts
      WHERE id IN ($1, $2)
        AND company_id = $3
      FOR UPDATE
      `,
      [from_account_id, to_account_id, company_id]
    );

    if (accountsRes.rowCount !== 2) {
      throw new Error("One or both accounts not found");
    }

    const fromAccount = accountsRes.rows.find(
      (a) => a.id === from_account_id
    );
    const toAccount = accountsRes.rows.find(
      (a) => a.id === to_account_id
    );

    if (Number(fromAccount.balance) < Number(amount)) {
      throw new Error("Insufficient balance");
    }

    /* 2️⃣ Debit sender */
    await client.query(
      `
      UPDATE accounts
      SET balance = balance - $1
      WHERE id = $2
      `,
      [amount, from_account_id]
    );

    /* 3️⃣ Credit receiver */
    await client.query(
      `
      UPDATE accounts
      SET balance = balance + $1
      WHERE id = $2
      `,
      [amount, to_account_id]
    );

    /* 4️⃣ Log transactions */
    const outTx = await client.query(
      `
      INSERT INTO transactions (
        account_id,
        company_id,
        type,
        amount,
        description,
        created_by,
        created_by_type
      ) VALUES ($1, $2, 'transfer_out', $3, $4, $5, $6)
      RETURNING *
      `,
      [
        from_account_id,
        company_id,
        amount,
        description || "Transfer to another account",
        created_by,
        created_by_type,
      ]
    );

    const inTx = await client.query(
      `
      INSERT INTO transactions (
        account_id,
        company_id,
        type,
        amount,
        description,
        created_by,
        created_by_type
      ) VALUES ($1, $2, 'transfer_in', $3, $4, $5, $6)
      RETURNING *
      `,
      [
        to_account_id,
        company_id,
        amount,
        description || "Transfer from another account",
        created_by,
        created_by_type,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Transfer completed successfully",
      data: {
        from_account_id,
        to_account_id,
        amount,
        debit_transaction: outTx.rows[0],
        credit_transaction: inTx.rows[0],
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(400).json({
      success: false,
      message: error.message || "Transfer failed",
    });
  } finally {
    client.release();
  }
};

export const reverseTransfer = async (req, res) => {
  const { transactionId } = req.params;
  const { staffId, reason } = req.body;

  if (!staffId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* 1️⃣ Lock the original transaction */
    const txRes = await client.query(
      `
      SELECT *
      FROM transactions
      WHERE id = $1
      FOR UPDATE
      `,
      [transactionId]
    );

    if (txRes.rowCount === 0) {
      throw new Error("Transaction not found");
    }

    const tx = txRes.rows[0];

    if (!["transfer_out", "transfer_in"].includes(tx.type)) {
      throw new Error("Not a transfer transaction");
    }

    if (tx.status !== "approved") {
      throw new Error("Only approved transfers can be reversed");
    }

    /* 2️⃣ Find the linked transaction */
    const linkedTxRes = await client.query(
      `
      SELECT *
      FROM transactions
      WHERE source_transaction_id = $1
         OR id = $1
      FOR UPDATE
      `,
      [tx.source_transaction_id || tx.id]
    );

    if (linkedTxRes.rowCount !== 2) {
      throw new Error("Linked transfer transaction not found");
    }

    const transferOut = linkedTxRes.rows.find(
      (t) => t.type === "transfer_out"
    );
    const transferIn = linkedTxRes.rows.find(
      (t) => t.type === "transfer_in"
    );

    if (!transferOut || !transferIn) {
      throw new Error("Invalid transfer pair");
    }

    /* 3️⃣ Reverse balances */
    await client.query(
      `
      UPDATE accounts
      SET balance = balance + $1
      WHERE id = $2
      `,
      [transferOut.amount, transferOut.account_id]
    );

    await client.query(
      `
      UPDATE accounts
      SET balance = balance - $1
      WHERE id = $2
      `,
      [transferIn.amount, transferIn.account_id]
    );

    /* 4️⃣ Mark both transactions reversed */
    await client.query(
      `
      UPDATE transactions
      SET status = 'reversed',
          reversed_at = NOW(),
          reversed_by = $1,
          reversal_reason = $2
      WHERE id IN ($3, $4)
      `,
      [staffId, reason || null, transferOut.id, transferIn.id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Transfer reversed successfully",
      data: {
        reversed_transactions: [transferOut.id, transferIn.id],
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to reverse transfer",
    });
  } finally {
    client.release();
  }
};
