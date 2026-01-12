import pool from '../db.mjs';

export const createCustomer = async (req, res) => {
  const {
    name,
    date_of_registration,
    id_card,
    gender,
    email,
    phone_number,
    account_number,
    next_of_kin,
    location,
    daily_rate,
    company_id,
    registered_by,
    date_of_birth,
    city,
  } = req.body;

  // Validate required fields
  if (!name || !date_of_registration || !id_card || !company_id || !registered_by) {
    return res.status(400).json({
      status: 'fail',
      message: 'name, date_of_registration, id_card, company_id, and registered_by are required.',
    });
  }

  try {
    // Check if company exists
    const companyCheck = await pool.query('SELECT id FROM companies WHERE id = $1', [company_id]);
    if (companyCheck.rows.length === 0) {
      return res.status(404).json({ status: 'fail', message: 'Invalid company_id' });
    }

    // Check if staff exists
    const staffCheck = await pool.query('SELECT id FROM staff WHERE id = $1', [registered_by]);
    if (staffCheck.rows.length === 0) {
      return res.status(404).json({ status: 'fail', message: 'Invalid staff ID (registered_by)' });
    }

    const insertQuery = `
      INSERT INTO customers (
        name, date_of_registration, id_card,
        gender, email, phone_number, next_of_kin, location, daily_rate,
        company_id, registered_by, date_of_birth, city, account_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, name, date_of_registration, id_card, gender, email, phone_number, next_of_kin, location, daily_rate, company_id, registered_by, created_at, date_of_birth, city, account_number
    `;

    const values = [
      name,
      date_of_registration,
      id_card,
      gender || null,
      email || null,
      phone_number || null,
      next_of_kin || null,
      location || null,
      daily_rate || null,
      company_id,
      registered_by,
      date_of_birth || null,
      city || null,
      account_number || null
    ];

    const result = await pool.query(insertQuery, values);
    console.log(result.rows[0])
    return res.status(201).json({
      status: 'success',
      message: 'Customer created successfully.',
      data: result.rows[0],
    });
    
  } catch (error) {
    console.error('Error creating customer:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};


export const deleteCustomer = async (req, res) => {
  const { customer_id } = req.body;
  if (!customer_id) {
    return res.status(400).json({
      status: 'fail',
      message: 'customer_id is required'
    });
  }

  try {
    // Check if customer exists
    const customerCheck = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customer_id]
    );

    if (customerCheck.rows.length === 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid customer_id'
      });
    }

    // Soft delete customer + related accounts + transactions
    const now = new Date();
    await pool.query(
      'UPDATE transactions SET is_deleted = true, deleted_at = $1 WHERE created_by = $2',
      [now, customer_id]
    );
    await pool.query(
      'UPDATE accounts SET is_deleted = true, deleted_at = $1 WHERE customer_id = $2',
      [now, customer_id]
    );
    await pool.query(
      'UPDATE customers SET is_deleted = true, deleted_at = $1 WHERE id = $2',
      [now, customer_id]
    );

    return res.status(200).json({
      status: 'success',
      message: 'Customer deleted successfully (soft delete)',
    });
  } catch (error) {
    console.error('Error deleting customer: ', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};


export const getCustomerById = async (req, res) => {
  const { customerId } = req.params;
  console.log(customerId)
  try {
    const result = await pool.query(
      `SELECT * FROM customers WHERE id = $1 AND is_deleted = false`,
      [customerId]
    );
    return res.status(200).json({
      status: 'success',
      count: result.rows.length,
      data: result.rows[0],
    });
  }
  catch (error) {
      console.error('Error fetching customer by ID:', error.message);
      return res.status(500).json({
        status: 'error',})
  }
}

// GET /api/customers/staff/:staffId

export const getCustomersByStaff = async (req, res) => {
  const { staffId } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM customers WHERE registered_by = $1 AND is_deleted = false`,
      [staffId]
    );

    return res.status(200).json({
      status: 'success',
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching customers by staff:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};


export const getCustomersByCompany = async (req, res) => {
  const { companyId } = req.params;

  try {
    const result = await pool.query({
      text: `
  SELECT
    c.id AS customer_id,
    c.name,
    c.phone_number,
    c.account_number,
    c.email,
    c.location,
    c.daily_rate,
    c.next_of_kin,
    c.id_card,
    c.city,
    c.registered_by,
    c.date_of_birth,
    c.gender,
    c.date_of_registration,
    s.full_name AS registered_by_name,

    -- Customer Summary across all NON-LOAN accounts
    COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END), 0) AS total_balance_across_all_accounts,
    COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN total_deposits_customer.sum_deposits ELSE 0 END), 0) AS total_deposits_across_all_accounts,
    COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN total_withdrawals_customer.sum_withdrawals ELSE 0 END), 0) AS total_withdrawals_across_all_accounts,
    COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN total_stakes_customer.sum_stakes ELSE 0 END), 0) AS total_stakes_across_all_accounts,

    -- Nested accounts (includes all types, but you can filter on frontend if needed)
    COALESCE(
      JSON_AGG(
        JSON_BUILD_OBJECT(
          'account_id', a.id,
          'account_type', a.account_type,
          'balance', a.balance,
          'created_at', a.created_at,
          'total_stakes', COALESCE(stake_summary.total_stakes, 0),
          'total_deposits', COALESCE(dep_with.total_deposits, 0),
          'total_withdrawals', COALESCE(dep_with.total_withdrawals, 0)
        )
        ORDER BY a.created_at
      ) FILTER (WHERE a.id IS NOT NULL),
      '[]'
    ) AS accounts

  FROM customers c
  JOIN staff s ON c.registered_by = s.id
  LEFT JOIN accounts a ON c.id = a.customer_id

  -- Subquery for total stakes per account
  LEFT JOIN (
    SELECT account_id, COUNT(id) AS total_stakes
    FROM stakes
    GROUP BY account_id
  ) stake_summary ON a.id = stake_summary.account_id

  -- Subquery for total deposits/withdrawals per account
  LEFT JOIN (
    SELECT
      account_id,
      SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END) AS total_deposits,
      SUM(CASE WHEN type = 'withdrawal' THEN amount ELSE 0 END) AS total_withdrawals
    FROM transactions
    GROUP BY account_id
  ) dep_with ON a.id = dep_with.account_id

  -- Total deposits across all accounts (exclude loans)
  LEFT JOIN (
    SELECT
        a_inner.customer_id,
        SUM(CASE WHEN t_inner.type = 'deposit' THEN t_inner.amount ELSE 0 END) AS sum_deposits
    FROM accounts a_inner
    JOIN transactions t_inner ON a_inner.id = t_inner.account_id
    WHERE a_inner.account_type NOT ILIKE '%loan%'
    GROUP BY a_inner.customer_id
  ) AS total_deposits_customer ON c.id = total_deposits_customer.customer_id

  -- Total withdrawals across all accounts (exclude loans)
  LEFT JOIN (
      SELECT
          a_inner.customer_id,
          SUM(CASE WHEN t_inner.type = 'withdrawal' THEN t_inner.amount ELSE 0 END) AS sum_withdrawals
      FROM accounts a_inner
      JOIN transactions t_inner ON a_inner.id = t_inner.account_id
      WHERE a_inner.account_type NOT ILIKE '%loan%'
      GROUP BY a_inner.customer_id
  ) AS total_withdrawals_customer ON c.id = total_withdrawals_customer.customer_id

  -- Total stakes across all accounts (exclude loans)
  LEFT JOIN (
      SELECT
          a_inner.customer_id,
          COUNT(s_inner.id) AS sum_stakes
      FROM accounts a_inner
      JOIN stakes s_inner ON a_inner.id = s_inner.account_id
      WHERE a_inner.account_type NOT ILIKE '%loan%'
      GROUP BY a_inner.customer_id
  ) AS total_stakes_customer ON c.id = total_stakes_customer.customer_id

  WHERE c.company_id = $1 AND c.is_deleted = false
  GROUP BY
    c.id,
    c.name,
    c.phone_number,
    c.email,
    c.location,
    c.date_of_registration,
    s.full_name,
    total_deposits_customer.sum_deposits,
    total_withdrawals_customer.sum_withdrawals,
    total_stakes_customer.sum_stakes
  ORDER BY c.name;
`
,
      values: [companyId],
      statement_timeout: 120000
    });

    return res.status(200).json({
      status: 'success',
      count: result.rows.length,
      data: result.rows,
    });

  } catch (error) {
    console.error('Error fetching customers by company:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const udpateCustomerInfoMobile = async (req, res) => {
  const {
    id,
    name,
    phone_number,
    next_of_kin,
    daily_rate,
    location,
    gender,
    date_of_birth,
    id_card
  } = req.body;

  console.log(id, name, phone_number, next_of_kin, daily_rate, location, gender, date_of_birth, id_card);

  try {
    const result = await pool.query(
      `
      UPDATE customers
      SET 
        name = $1,
        phone_number = $2,
        next_of_kin = $3,
        daily_rate = $4,
        location = $5,
        gender = $6,
        date_of_birth = $7,
        id_card = $8
      WHERE id = $9
      RETURNING *;
      `,
      [name, phone_number, next_of_kin, daily_rate, location, gender, date_of_birth, id_card, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    console.error("Error updating customer:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};


export const updateCustomer = async (req, res) => {
  const {
    name,
    date_of_registration,
    id_card,
    gender,
    email,
    phone_number,
    next_of_kin,
    location,
    daily_rate,
    company_id,
    registered_by,
    date_of_birth,
    city,
    account_number,
    customer_id,
  } = req.body;

  try {
    console.log(name, customer_id);
    const query = `
      UPDATE customers
      SET
        name = $1,
        date_of_registration = $2,
        id_card = $3,
        gender = $4,
        email = $5,
        phone_number = $6,
        next_of_kin = $7,
        location = $8,
        daily_rate = $9,
        company_id = $10,
        registered_by = $11,
        date_of_birth = $12,
        city = $13,
        account_number = $14
      WHERE id = $15
      RETURNING *;
    `;

    const values = [
      name,
      date_of_registration,
      id_card,
      gender,
      email,
      phone_number,
      next_of_kin,
      location,
      daily_rate,
      company_id,
      registered_by,
      date_of_birth,
      city,
      account_number,
      customer_id,
    ];

    const { rows } = await pool.query(query, values);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Error updating customer:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};