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
    initial_deposit,
    created_by_type
  } = req.body;

  if (!customer_id || !account_type || !created_by || !company_id) {
    return res.status(400).json({
      status: 'fail',
      message: 'customer_id, account_type, created_by, and company_id are required',
    });
  }

  try {
    // Required fields
    const fields = ["customer_id", "account_type", "created_by", "company_id", "created_by_type", "balance"];
    const values = [customer_id, account_type, created_by, company_id, created_by_type, initial_deposit];
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
