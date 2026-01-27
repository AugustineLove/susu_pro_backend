import pool from "../db.mjs";

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
    account_number,
  } = req.body;

  if (!customer_id || !account_type || !created_by || !company_id || !account_number) {
    return res.status(400).json({
      status: 'fail',
      message: 'customer_id, account_type, created_by, company_id, and account_number are required',
    });
  }

  try {
   
    const fields = ["customer_id", "account_type", "created_by", "company_id", "created_by_type", "balance", "account_number"];
    const values = [customer_id, account_type, created_by, company_id, created_by_type, initial_deposit, account_number];
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
  console.log(customerId);
  try {
    const accounts = await pool.query(
      `SELECT 
         *
       FROM accounts 
       WHERE customer_id = $1 AND is_deleted = false`,
      [customerId]
    );

    if (accounts.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No accounts found for this customer.',
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
        AND is_deleted = false
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
      WHERE created_by = $1
        AND is_deleted = false
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
      AND c.is_deleted = false
    WHERE LOWER(s.role) IN ('mobile banker', 'mobile_banker', 'Mobile Banker','teller')
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

