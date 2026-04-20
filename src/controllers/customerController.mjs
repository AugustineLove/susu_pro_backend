import pool from '../db.mjs';
import { generateWithdrawalCode } from '../utils/withdrawalCode.mjs';
import { sendCustomerMessageBackend } from './smsController.mjs';
import { formatEndDate, formatStartDate } from './transactionController.mjs';

export const createCustomer = async (req, res) => {
  const {
    name,
    date_of_registration,
    id_card,
    gender,
    email,
    phone_number,
    momo_number,
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

  const withdrawalCode = await generateWithdrawalCode();

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
        company_id, registered_by, date_of_birth, city, account_number, momo_number, withdrawal_code
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id, name, date_of_registration, id_card, gender, email, phone_number, next_of_kin, location, daily_rate, company_id, registered_by, created_at, date_of_birth, city, account_number, momo_number, withdrawal_code
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
      account_number || null,
      momo_number || null,
      withdrawalCode || null,
    ];

    const result = await pool.query(insertQuery, values);
    // if(res.status === 201 || res.status === 200){
    //   sendCustomerMessageBackend(
    //     makeSusuProName(company_id),
    //     message: `Dear ${name}, you have successfully opened a ${formData.account_type} account with ${parentCompanyName}. Your customer account number is, ${addedCustomerData.data.account_number}. \nYour secret withdrawal code is ${addedCustomerData.data.withdrawal_code}. Please do not share this code with anyone. \nThank you for choosing us!`
    //     phone_number,
    //     );
    // }
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
  try {
    const { companyId } = req.params;
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // ── Destructure every filter field ──────────────────────────────────
    const {
      // Identity
      name, phone_number, email, account_number, id_card, momo_number,
      // Demographics
      gender, status, location, city,
      // Registration
      registered_by_name, date_from, date_to, date_of_birth,
      // Financial
      daily_rate_min, daily_rate_max, balance_min, balance_max,
    } = req.query;

    // ── Build WHERE conditions ───────────────────────────────────────────
    const whereConditions = ['c.company_id = $1', 'c.is_deleted = false'];
    const values          = [companyId];
    let   p               = 2;   // next param index

    // Helper — appends an ILIKE condition (partial match, case-insensitive)
    const ilike = (col, val) => {
      whereConditions.push(`${col} ILIKE $${p++}`);
      values.push(`%${val}%`);
    };

    // Helper — appends an exact equality condition
    const exact = (col, val) => {
      whereConditions.push(`${col} = $${p++}`);
      values.push(val);
    };

    // Identity — partial match makes sense for free-text fields
    if (name)           ilike('c.name',           name);
    if (phone_number)   ilike('c.phone_number',   phone_number);
    if (email)          ilike('c.email',          email);
    if (account_number) ilike('c.account_number', account_number);
    if (id_card)        ilike('c.id_card',        id_card);
    if (momo_number)    ilike('c.momo_number',    momo_number);

    // Demographics
    if (gender)   exact('c.gender',   gender);
    if (status)   exact('c.status',   status);
    if (location) ilike('c.location', location);
    if (city)     ilike('c.city',     city);

    // Registration — staff name is partial, dates are range bounds
    if (registered_by_name) ilike('s.full_name', registered_by_name);

    if (date_from && date_to) {
      whereConditions.push(`c.date_of_registration BETWEEN $${p} AND $${p + 1}`);
      values.push(formatStartDate(date_from), formatEndDate(date_to));
      p += 2;
    } else if (date_from) {
      whereConditions.push(`c.date_of_registration >= $${p++}`);
      values.push(formatStartDate(date_from));
    } else if (date_to) {
      whereConditions.push(`c.date_of_registration <= $${p++}`);
      values.push(formatEndDate(date_to));
    }

    if (date_of_birth) {
      exact('c.date_of_birth', date_of_birth);
    }

    // Financial — range filters using HAVING (balance is aggregated)
    // daily_rate is on the customers row so it can go in WHERE
    if (daily_rate_min) {
      whereConditions.push(`c.daily_rate >= $${p++}`);
      values.push(parseFloat(daily_rate_min));
    }
    if (daily_rate_max) {
      whereConditions.push(`c.daily_rate <= $${p++}`);
      values.push(parseFloat(daily_rate_max));
    }

    // ── HAVING clause for aggregated balance ────────────────────────────
    // balance_min / balance_max filter on the SUM computed in the SELECT,
    // so they must live in HAVING, not WHERE.
    const havingConditions = [];
    if (balance_min) {
      havingConditions.push(`COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END), 0) >= $${p++}`);
      values.push(parseFloat(balance_min));
    }
    if (balance_max) {
      havingConditions.push(`COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END), 0) <= $${p++}`);
      values.push(parseFloat(balance_max));
    }

    const whereClause  = 'WHERE '  + whereConditions.join(' AND ');
    const havingClause = havingConditions.length > 0
      ? 'HAVING ' + havingConditions.join(' AND ')
      : '';

    // ── Count query ─────────────────────────────────────────────────────
    // Wrap in a subquery so HAVING applies before counting
    const countQuery = `
      SELECT COUNT(*) AS total FROM (
        SELECT c.id
        FROM customers c
        JOIN staff s ON c.registered_by = s.id
        LEFT JOIN accounts a ON c.id = a.customer_id
        ${whereClause}
        GROUP BY c.id
        ${havingClause}
      ) sub
    `;

    const countResult = await pool.query(countQuery, values);
    const total       = parseInt(countResult.rows[0].total, 10);
    const totalPages  = Math.ceil(total / limit) || 1;

    // ── Main query — always paginated ───────────────────────────────────
    const mainQuery = `
      SELECT
        c.id                  AS customer_id,
        c.name,
        c.phone_number,
        c.account_number,
        c.momo_number,
        c.email,
        c.location,
        c.city,
        c.daily_rate,
        c.next_of_kin,
        c.id_card,
        c.registered_by,
        c.date_of_birth,
        c.withdrawal_code,
        c.is_deleted,
        c.gender,
        c.status,
        c.date_of_registration,
        c.send_sms,
        c.sms_numbers,
        s.full_name AS registered_by_name,
        COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END), 0)
          AS total_balance_across_all_accounts,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'account_id',  a.id,
              'account_type', a.account_type,
              'balance',     a.balance,
              'created_at',  a.created_at
            ) ORDER BY a.created_at
          ) FILTER (WHERE a.id IS NOT NULL),
          '[]'
        ) AS accounts
      FROM customers c
      JOIN  staff    s ON c.registered_by = s.id
      LEFT JOIN accounts a ON c.id = a.customer_id
      ${whereClause}
      GROUP BY c.id, s.full_name
      ${havingClause}
      ORDER BY c.name
      LIMIT  $${p}
      OFFSET $${p + 1}
    `;

    values.push(limit, offset);

    const result = await pool.query({
      text:              mainQuery,
      values,
      statement_timeout: 30000,
    });

    return res.status(200).json({
      status:     'success',
      page,
      limit,
      total,
      totalPages,
      data:       result.rows,
    });

  } catch (error) {
    console.error('Error fetching customers:', error.message);
    return res.status(500).json({
      status:  'error',
      message: 'Internal server error',
      error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};
// Helper function to calculate date ranges
function getDateFromRange(dateRange) {
  const now = new Date();
  switch (dateRange) {
    case 'last_week':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case 'last_month':
      return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    case 'last_3_months':
      return new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    case 'this_year':
      return new Date(now.getFullYear(), 0, 1);
    default:
      return null;
  }
}

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
    id_card,
    momo_number
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
        id_card = $8,
        momo_number = $10
      WHERE id = $9
      RETURNING *;
      `,
      [name, phone_number, next_of_kin, daily_rate, location, gender, date_of_birth, id_card, id, momo_number]
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

export const getCustomerByAccountNumber = async (req, res) => {
  const { accountNumber } = req.params;
  console.log(accountNumber)

  try {
    // Extract first 11 characters (customer number)
    // const customerNumber = accountNumber.slice(0, 11);

    const query = `
      SELECT c.*
      FROM accounts a
      JOIN customers c ON a.customer_id = c.id
      WHERE a.account_number = $1;
    `;

    const { rows } = await pool.query(query, [accountNumber]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }
    console.log(rows[0])

    res.status(200).json({
      success: true,
      data: rows[0],
    });

  } catch (error) {
    console.error("Error fetching customer:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const loginCustomer = async (req, res) => {
  const { account_number, withdrawal_code } = req.body;

  if (!account_number || !withdrawal_code) {
    return res.status(400).json({ message: "Missing credentials" });
  }

  try {
    // 1️⃣ Get customer
    const customerQuery = `
      SELECT * FROM customers
      WHERE account_number = $1
      AND withdrawal_code = $2
      LIMIT 1;
    `;

    const { rows: customerRows } = await pool.query(customerQuery, [
      account_number,
      withdrawal_code,
    ]);

    if (customerRows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const customer = customerRows[0];

    // 2️⃣ Get accounts
    const accountsQuery = `
      SELECT * FROM accounts
      WHERE customer_id = $1;
    `;

    const { rows: accounts } = await pool.query(accountsQuery, [
      customer.id,
    ]);

    // 3️⃣ Get transactions for all customer accounts
    const accountIds = accounts.map(acc => acc.id);
    console.log(accountIds);
    let transactions = [];

    if (accountIds.length > 0) {
      const transactionsQuery = `
        SELECT *
        FROM transactions
        WHERE account_id = ANY($1)
        ORDER BY created_at DESC
        LIMIT 50;
      `;

      const { rows } = await pool.query(transactionsQuery, [
        accountIds,
      ]);

      transactions = rows;
    }

    return res.json({
      customer,
      accounts,
      transactions,
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const searchCustomers = async (req, res) => {
  const { companyId } = req.params;
  const { query } = req.query;

  if (!query || query.trim() === "") {
    return res.status(200).json({
      status: "success",
      data: [],
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT 
        c.id,
        c.name,
        c.status,
        c.phone_number,
        c.email,
        c.account_number,
        c.daily_rate,
        c.id AS customer_id,

        c.send_sms,
        COALESCE(c.sms_numbers, '{}') AS sms_numbers,

        -- Staff Info
        s.id AS registered_by,
        s.full_name AS registered_by_name,

        -- Total Balance (Exclude Loan Accounts)
        COALESCE(
          SUM(
            CASE 
              WHEN a.account_type NOT ILIKE '%loan%' 
              THEN a.balance 
              ELSE 0 
            END
          ),
          0
        ) AS total_balance_across_all_accounts

      FROM customers c

      LEFT JOIN accounts a 
        ON c.id = a.customer_id

      LEFT JOIN staff s
        ON c.registered_by = s.id

      WHERE 
        c.company_id = $1
        AND c.is_deleted = false
        AND (
          c.name ILIKE $2 OR
          c.phone_number ILIKE $2 OR
          c.email ILIKE $2 OR
          c.account_number ILIKE $2
        )

      GROUP BY 
        c.id,
        s.id,
        s.full_name

      ORDER BY c.name
      LIMIT 10;
      `,
      [companyId, `%${query}%`]
    );

    return res.status(200).json({
      status: "success",
      data: result.rows,
    });

  } catch (error) {
    console.error("Search error:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

// POST /customers/:customerId/sms-numbers
export const addSmsNumber = async (req, res) => {
  const { customerId } = req.params;
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({
      status: "error",
      message: "Phone number is required",
    });
  }

  try {
    // Avoid duplicates
    const result = await pool.query(
      `
      UPDATE customers
      SET sms_numbers = (
        CASE 
          WHEN sms_numbers @> ARRAY[$1] THEN sms_numbers
          ELSE array_append(sms_numbers, $1)
        END
      )
      WHERE id = $2
      RETURNING sms_numbers;
      `,
      [phoneNumber, customerId]
    );

    return res.status(200).json({
      status: "success",
      sms_numbers: result.rows[0].sms_numbers,
    });

  } catch (error) {
    console.error("Add SMS number error:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

// DELETE /customers/:customerId/sms-numbers
export const removeSmsNumber = async (req, res) => {
  const { customerId } = req.params;
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({
      status: "error",
      message: "Phone number is required",
    });
  }

  try {
    const result = await pool.query(
      `
      UPDATE customers
      SET sms_numbers = array_remove(sms_numbers, $1)
      WHERE id = $2
      RETURNING sms_numbers;
      `,
      [phoneNumber, customerId]
    );

    return res.status(200).json({
      status: "success",
      sms_numbers: result.rows[0].sms_numbers,
    });

  } catch (error) {
    console.error("Remove SMS number error:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

// PATCH /customers/:customerId/toggle-sms
export const toggleSendSms = async (req, res) => {
  const { customerId } = req.params;

  try {
    const result = await pool.query(
      `
      UPDATE customers
      SET send_sms = NOT send_sms
      WHERE id = $1
      RETURNING send_sms;
      `,
      [customerId]
    );

    return res.status(200).json({
      status: "success",
      send_sms: result.rows[0].send_sms,
    });

  } catch (error) {
    console.error("Toggle SMS error:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};