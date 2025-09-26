import bcrypt from 'bcrypt';
import pool from '../db.mjs';

export const createStaff = async (req, res) => {
  const { full_name, email, phone, role, password, company_id, staff_id } = req.body;

  console.log(full_name, email, phone, role, password, company_id, staff_id);
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
    // Check email uniqueness
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

  // Check staff ID uniqueness per company
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

// Hash password
const saltRounds = 10;
const password_hash = await bcrypt.hash(password, saltRounds);

// Insert staff
const insertQuery = `
  INSERT INTO staff (
    staff_id, full_name, email, phone, role, company_id, password_hash
  ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING id, staff_id, full_name, email, phone, role, company_id, created_at
`;

const values = [
  staff_id,
  full_name,
  email,
  phone,
  role,
  company_id,
  password_hash,
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



