import bcrypt from 'bcrypt';
import pool from '../db.mjs';
import { defaultPermissions } from '../constants/defualtPermissions.mjs';

export const createStaff = async (req, res) => {
  const { full_name, email, phone, role, password, company_id, staff_id } = req.body;

  if (!full_name || !email || !phone || !role || !password || !company_id || !staff_id) {
    return res.status(400).json({
      status: 'fail',
      message: 'All fields are required.',
    });
  }

  // ✅ Check if company exists
  const companyCheck = await pool.query(
    'SELECT id FROM companies WHERE id = $1',
    [company_id]
  );

  if (companyCheck.rows.length === 0) {
    return res.status(404).json({
      status: 'fail',
      message: 'Company not found. Please provide a valid company_id.',
    });
  }

  try {
    // ✅ Check email uniqueness
    const checkEmail = await pool.query(
      'SELECT * FROM staff WHERE email = $1 AND company_id = $2',
      [email, company_id]
    );
    if (checkEmail.rows.length > 0) {
      return res.status(409).json({
        status: 'fail',
        message: 'Staff with this email already exists.',
      });
    }

    // ✅ Check staff ID uniqueness
    const checkStaffId = await pool.query(
      'SELECT * FROM staff WHERE staff_id = $1 AND company_id = $2',
      [staff_id, company_id]
    );
    if (checkStaffId.rows.length > 0) {
      return res.status(409).json({
        status: 'fail',
        message: 'A staff with this staff ID already exists in this company.',
      });
    }

    // ✅ Hash password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // ✅ Assign permissions from role
    const rolePermissions = defaultPermissions[role] || {};

    // ✅ Insert staff
    const insertQuery = `
      INSERT INTO staff (
        staff_id, full_name, email, phone, role, company_id, password_hash, permissions
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING id, staff_id, full_name, email, phone, role, company_id, permissions, created_at
    `;

    const values = [
      staff_id,
      full_name,
      email,
      phone,
      role,
      company_id,
      password_hash,
      JSON.stringify(rolePermissions),
    ];

    const result = await pool.query(insertQuery, values);

    return res.status(201).json({
      status: 'success',
      message: 'Staff created successfully',
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Error creating staff:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};
export const signInStaff = async (req, res) => {
  const { staff_id, password } = req.body;

  // Validate input
  if (!staff_id || !password) {
    return res.status(400).json({
      status: 'fail',
      message: 'Staff ID and password are required.',
    });
  }

  try {
    // Fetch staff by staff_id
    const staffQuery = `
      SELECT 
        s.id, 
        s.staff_id, 
        s.full_name, 
        s.email, 
        s.phone, 
        s.role, 
        s.company_id, 
        s.password_hash,
        c.company_name AS company_name
      FROM staff s
      JOIN companies c ON s.company_id = c.id
      WHERE s.staff_id = $1
    `;
    const staffResult = await pool.query(staffQuery, [staff_id]);

    if (staffResult.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'Staff not found.',
      });
    }

    const staff = staffResult.rows[0];

    // Compare password
    const isMatch = await bcrypt.compare(password, staff.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid password.',
      });
    }

    // Prepare user info to return (excluding password_hash)
    const userData = {
      id: staff.id,
      staff_id: staff.staff_id,
      full_name: staff.full_name,
      email: staff.email,
      phone: staff.phone,
      role: staff.role,
      company_id: staff.company_id,
      company_name: staff.company_name
    };

    return res.status(200).json({
      status: 'success',
      message: 'Login successful.',
      data: userData,
    });

  } catch (error) {
    console.error('Login error:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};


export const getStaffByRole = async (req, res) => {
  const { company_id, role } = req.query;

  if (!company_id || !role) {
    return res.status(400).json({
      status: 'fail',
      message: 'company_id and role are required as query parameters.',
    });
  }

  try {
    const query = `
      SELECT id, staff_id, full_name, email, phone, role, company_id, created_at
      FROM staff
      WHERE company_id = $1 AND role ILIKE $2
    `;
    const result = await pool.query(query, [company_id, role]);

    return res.status(200).json({
      status: 'success',
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching staff by role:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};


export const getAllStaffByCompany = async (req, res) => {
  const { company_id } = req.query;

  if (!company_id) {
    return res.status(400).json({
      status: 'fail',
      message: 'company_id is required as a query parameter.',
    });
  }

  try {
    const query = `
      SELECT *
      FROM staff
      WHERE company_id = $1
    `;
    const result = await pool.query(query, [company_id]);

    return res.status(200).json({
      status: 'success',
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching staff:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};

export const getAllStaffWithFiltering = async (req, res) => {
  const { company_id, role, status } = req.query;

  if (!company_id) {
    return res.status(400).json({
      status: 'fail',
      message: 'company_id is required as a query parameter.',
    });
  }

  try {
    let baseQuery = `SELECT * FROM staff WHERE company_id = $1`;
    const params = [company_id];

    if (role) {
      params.push(role);
      baseQuery += ` AND role = $${params.length}`;
    }

    if (status) {
      params.push(status);
      baseQuery += ` AND status = $${params.length}`;
    }

    const result = await pool.query(baseQuery, params);

    return res.status(200).json({
      status: 'success',
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching staff:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};


export const getStaffById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`SELECT * FROM staff WHERE id = $1`, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'fail', message: 'Staff not found' });
    }

    return res.status(200).json({
      status: 'success',
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Error fetching staff:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

export const getStaffDashboardByCompany = async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) {
    return res.status(400).json({
      status: "fail",
      message: "company_id is required as a query parameter.",
    });
  }

  try {
    // 1️⃣ Fetch main staff stats
    const staffQuery = `
      SELECT
        s.id,
        s.full_name AS name,
        s.phone,
        s.email,
        s.role,
        s.company_id,
        s.created_at,

        -- Total active customers registered by this staff
        COALESCE(cust.total_customers, 0) AS "totalCustomers",

        -- Total deposits ever made by this staff
        COALESCE(dep.total_deposits, 0) AS "totalDeposits",

        -- Total deposits made today
        COALESCE(dep_today.today_deposits, 0) AS "todayDeposits",

        -- Last activity (most recent transaction)
        COALESCE(last_tx.last_activity, NULL) AS "lastActivity",

        s.permissions,
        s.status,

        ROUND((
          0.6 * COALESCE(dep.total_deposits, 0) / 100000 +
          0.4 * COALESCE(cust.total_customers, 0) / 100
        ) * 100)::int AS performance

      FROM staff s

      -- Total active customers
      LEFT JOIN (
        SELECT registered_by, COUNT(*) AS total_customers
        FROM customers
        WHERE is_deleted = false AND status = 'Active'
        GROUP BY registered_by
      ) cust ON cust.registered_by = s.id

      -- Total deposits ever
      LEFT JOIN (
        SELECT created_by AS staff_id, SUM(amount) AS total_deposits
        FROM transactions
        WHERE type = 'deposit' AND status = 'completed' AND is_deleted = false
        GROUP BY created_by
      ) dep ON dep.staff_id = s.id

      -- Total deposits today
      LEFT JOIN (
        SELECT staff_id AS staff_id, SUM(amount) AS today_deposits
        FROM transactions
        WHERE type = 'deposit' AND status = 'completed' AND is_deleted = false
          AND transaction_date::date = CURRENT_DATE
        GROUP BY staff_id
      ) dep_today ON dep_today.staff_id = s.id

      -- Last activity
      LEFT JOIN (
        SELECT staff_id, MAX(transaction_date) AS last_activity
        FROM transactions
        WHERE is_deleted = false
        GROUP BY staff_id
      ) last_tx ON last_tx.staff_id = s.id

      WHERE s.company_id = $1
      ORDER BY s.full_name;
    `;
    const staffResult = await pool.query(staffQuery, [company_id]);
    const staffRows = staffResult.rows;

    // 2️⃣ Fetch accounts per staff
    const accountsQuery = `
      SELECT
        c.registered_by AS staff_id,
        ARRAY_AGG(DISTINCT a.account_type) AS accounts
      FROM customers c
      LEFT JOIN accounts a ON a.customer_id = c.id
      WHERE c.company_id = $1
      GROUP BY c.registered_by;
    `;
    const accountsResult = await pool.query(accountsQuery, [company_id]);

    // 3️⃣ Map accounts to staff
    const accountsMap = {};
    accountsResult.rows.forEach(row => {
      accountsMap[row.staff_id] = row.accounts || [];
    });

    // 4️⃣ Combine staff stats + accounts
    const staffWithAccounts = staffRows.map(staff => ({
      ...staff,
      accounts: accountsMap[staff.id] || [],
    }));



    // 5️⃣ Return final response
    return res.status(200).json({
      status: "success",
      data: staffWithAccounts,
    });

  } catch (error) {
    console.error("Error fetching staff dashboard:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error.",
    });
  }
};
