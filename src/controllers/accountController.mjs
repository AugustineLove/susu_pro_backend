import pool from "../db.mjs";
import { generateAccountNumber, getCustomerBaseAccountNumber } from "../services/accountServices.mjs";

export const createAccount = async (req, res) => {
  const {
    customer_id,
    account_type,
    created_by,
    company_id,
    daily_rate,
    frequency,
    minimum_balance,
    interest_rate,
    initial_deposit = 0,
    created_by_type,
    account_number // optional
  } = req.body;

  if (!customer_id || !account_type || !created_by || !company_id) {
    return res.status(400).json({
      status: "fail",
      message: "customer_id, account_type, created_by, and company_id are required",
    });
  }

  try {
    // 🔑 base number (however you already get it)
    const baseNumber = account_number?.replace(/(SU|SA)\d+$/, "")
      || await getCustomerBaseAccountNumber(customer_id);

    const finalAccountNumber = await generateAccountNumber({
      customerId: customer_id,
      baseNumber,
      accountType: account_type
    });

    // then continue with your existing insert

   
    const fields = ["customer_id", "account_type", "created_by", "company_id", "created_by_type", "balance", "account_number"];
    const values = [customer_id, account_type, created_by, company_id, created_by_type, initial_deposit, finalAccountNumber];
    const placeholders = values.map((_, i) => `$${i + 1}`);

    // Optional fields
    if (daily_rate !== undefined) {
      fields.push("daily_rate");
      values.push(daily_rate);
      placeholders.push(`$${values.length}`);
    }

    if (frequency !== undefined) {
      fields.push("frequency");
      values.push(frequency);
      placeholders.push(`$${values.length}`);
    }

    if (minimum_balance !== undefined) {
      fields.push("minimum_balance");
      values.push(minimum_balance);
      placeholders.push(`$${values.length}`);
    }

    if (interest_rate !== undefined) {
      fields.push("interest_rate");
      values.push(interest_rate);
      placeholders.push(`$${values.length}`);
    }

    if (initial_deposit !== undefined) {
      fields.push("initial_deposit");
      values.push(initial_deposit);
      placeholders.push(`$${values.length}`);
    }

    // Build query dynamically
    const query = `
      INSERT INTO accounts (${fields.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING *
    `;

    const result = await pool.query(query, values);

    return res.status(201).json({
      status: 'success',
      message: 'Account created successfully',
      data: result.rows[0],
    });

  } catch (error) {
    console.error('Error creating account:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

export const getAccountsByCustomer = async (req, res) => {
  const { customerId } = req.params;
  try {
    // 1. Get accounts (UNCHANGED)
    const accounts = await pool.query(
      `SELECT * 
       FROM accounts 
       WHERE customer_id = $1`,
      [customerId]
    );

    if (accounts.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No accounts found for this customer.',
      });
    }

    // 2. Get summary (NEW)
    const summary = await pool.query(
  `SELECT
     -- Deposits
     COALESCE(SUM(CASE 
       WHEN t.type = 'deposit' AND is_deleted = false THEN t.amount 
       ELSE 0 END), 0) AS total_deposits,

     -- Withdrawals
     COALESCE(SUM(CASE 
       WHEN t.type = 'withdrawal' AND is_deleted = false THEN t.amount 
       ELSE 0 END), 0) AS total_withdrawals,

     -- Transfer In
     COALESCE(SUM(CASE 
       WHEN t.type = 'transfer_in' AND is_deleted = false THEN t.amount 
       ELSE 0 END), 0) AS total_transfer_ins,

     -- Transfer Out
     COALESCE(SUM(CASE 
       WHEN t.type = 'transfer_out' AND is_deleted = false THEN t.amount 
       ELSE 0 END), 0) AS total_transfer_outs,

     -- Commissions (separate subquery to avoid duplication)
     (
       SELECT COALESCE(SUM(c.amount), 0)
       FROM commissions c
       INNER JOIN accounts a2 ON c.account_id = a2.id
       WHERE a2.customer_id = $1
     ) AS total_commissions

   FROM transactions t
   INNER JOIN accounts a ON t.account_id = a.id
   WHERE a.customer_id = $1`,
  [customerId]
);

    // 3. Total balance (optional but useful)
    const balance = await pool.query(
      `SELECT COALESCE(SUM(balance), 0) AS total_balance
       FROM accounts
       WHERE customer_id = $1`,
      [customerId]
    );
    return res.status(200).json({
      status: 'success',
      results: accounts.rowCount,
      data: accounts.rows,
      summary: {
        totalDeposits: Number(summary.rows[0].total_deposits),
        totalWithdrawals: Number(summary.rows[0].total_withdrawals),
        totalBalance: Number(balance.rows[0].total_balance),
        totalTransferIns: Number(summary.rows[0].total_transfer_ins),
        totalTransferOuts: Number(summary.rows[0].total_transfer_outs),
        totalCommissions: Number(summary.rows[0].total_commissions),
      },
    });

  } catch (error) {
    console.error('Error fetching customer accounts:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getAllCompanyAccounts = async (req, res) => {
  const { companyId } = req.params;
  console.log(companyId);
  try {
    const accounts = await pool.query(
      `SELECT 
         *
       FROM accounts 
       WHERE company_id = $1`,
      [companyId]
    );

    if (accounts.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No accounts found for this company.',
      });
    }

    return res.status(200).json({
      status: 'success',
      results: accounts.rowCount,
      data: accounts.rows,
    });
  } catch (error) {
    console.error('Error fetching customer accounts:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getLastAccountNumber = async (req, res) => {
  const { staffId } = req.params;
  console.log("Fetching last account number for staff ID:", staffId);

  try {
    if (!staffId) {
      return res.status(400).json({
        status: 'error',
        message: 'staffId is required',
      });
    }

    const query = `
      SELECT account_number
      FROM accounts
      WHERE created_by = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [staffId]);

    return res.json({
      status: 'success',
      lastAccountNumber: rows.length ? rows[0].account_number : null,
    });
  } catch (error) {
    console.error('Error fetching last account number:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getLastCustomerAccountNumber = async (req, res) => {
  const { staffId } = req.params;
  console.log("Fetching last customer account number for staff ID:", staffId);

  try {
    if (!staffId) {
      return res.status(400).json({
        status: 'error',
        message: 'staffId is required',
      });
    }

    const query = `
      SELECT account_number
      FROM customers
      WHERE registered_by = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [staffId]);

    return res.json({
      status: 'success',
      lastCustomerAccountNumber: rows.length ? rows[0].account_number : null,
    });
  } catch (error) {
    console.error('Error fetching last customer account number:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getLastAccountNumbersByStaff = async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT ON (s.id)
      s.id AS staff_id,
      s.staff_id AS staff_account_number,
      s.full_name AS staff_name,
      c.account_number,
      c.created_at
    FROM staff s
    LEFT JOIN customers c
      ON c.registered_by = s.id
    WHERE LOWER(s.role) IN ('mobile banker', 'mobile_banker', 'Mobile Banker','teller', 'manager', 'accountant', 'sales_manager', 'hr')
    ORDER BY s.id, c.created_at DESC;
    `;

    const { rows } = await pool.query(query);

    return res.json({
      status: 'success',
      data: rows.map(row => ({
        staff_id: row.staff_id,
        staff_name: row.staff_name,
        staff_account_number: row.staff_account_number,
        last_account_number: row.account_number || null,
      })),
    });
  } catch (error) {
    console.error('Error fetching last account numbers:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};


export const toggleAccountStatus = async (req, res) => {
  const { accountId } = req.params;
  const { company_id, staff_id } = req.body;

  if (!staff_id) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const accRes = await client.query(
      `
      SELECT id, status
      FROM accounts
      WHERE id = $1 AND company_id = $2
      FOR UPDATE
      `,
      [accountId, company_id]
    );

    if (accRes.rowCount === 0) {
      throw new Error("Account not found");
    }

    const currentStatus = accRes.rows[0].status;
    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";

    const updateRes = await client.query(
      `
      UPDATE accounts
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [newStatus, accountId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: `Account successfully set to ${newStatus.toLowerCase()}`,
      data: updateRes.rows[0],
    });

  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  } finally {
    client.release();
  }
};

export const updateAccountSettings = async (req, res) => {
  const { accountId } = req.params;
  const {
    allow_negative_balance,
    overdraft_limit,
    low_balance_threshold,
    minimum_balance,
  } = req.body;

  const companyId = req.user?.companyId; 
  console.log(accountId, companyId);
  try {
    // 1️⃣ Check account exists and belongs to company
    const { rows } = await pool.query(
      `SELECT id, balance 
       FROM accounts 
       WHERE id = $1 AND company_id = $2`,
      [accountId, companyId]
    );
    console.log(rows.length)
    if (rows.length === 0) {
      return res.status(404).json({
        message: "Account not found."
      });
    }

    const account = rows[0];

    // 2️⃣ Validation

    if (overdraft_limit !== undefined && overdraft_limit < 0) {
      return res.status(400).json({
        message: "Overdraft limit cannot be negative."
      });
    }

    if (low_balance_threshold !== undefined && low_balance_threshold < 0) {
      return res.status(400).json({
        message: "Low balance threshold cannot be negative."
      });
    }

    // If negative balance is being disabled,
    // ensure current balance is not below zero
    if (
      allow_negative_balance === false &&
      account.balance < 0
    ) {
      return res.status(400).json({
        message:
          "Cannot disable negative balance while account balance is negative."
      });
    }

    // 3️⃣ Perform Partial Update
    await pool.query(
      `UPDATE accounts
       SET
         allow_negative_balance = COALESCE($1, allow_negative_balance),
         overdraft_limit = COALESCE($2, overdraft_limit),
         low_balance_threshold = COALESCE($3, low_balance_threshold),
         minimum_balance = $6
       WHERE id = $4 AND company_id = $5`,
      [
        allow_negative_balance,
        overdraft_limit,
        low_balance_threshold,
        accountId,
        companyId,
        minimum_balance
      ]
    );

    return res.status(200).json({
      message: "Account settings updated successfully."
    });

  } catch (error) {
    console.error("Update account settings error:", error);
    return res.status(500).json({
      message: "Internal server error."
    });
  }
};

