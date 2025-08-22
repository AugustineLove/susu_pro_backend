import pool from "../db.mjs";

export const createAccount = async (req, res) => {
  const { customer_id, account_type, created_by, company_id } = req.body;

  if (!customer_id || !account_type || !created_by || !company_id) {
    return res.status(400).json({
      status: 'fail',
      message: 'All fields are required',
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO accounts (customer_id, account_type, created_by, company_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [customer_id, account_type, created_by, company_id]
    );

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
  const { customer_id } = req.params;
  try {
    const accounts = await pool.query(
      `SELECT 
         id, account_type, balance, created_at, company_id, created_by 
       FROM accounts 
       WHERE customer_id = $1`,
      [customer_id]
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
