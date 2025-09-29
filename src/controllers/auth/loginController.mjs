import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../../db.mjs';
import dotenv from 'dotenv';
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || '';

export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. First, check if email belongs to a company
    let { rows } = await pool.query(
      'SELECT * FROM companies WHERE company_email = $1',
      [email]
    );

    if (rows.length > 0) {
      const company = rows[0];

      // Compare password
      const isMatch = await bcrypt.compare(password, company.password_hash);
      if (!isMatch) {
        return res
          .status(401)
          .json({ status: 'error', message: 'Invalid credentials' });
      }

      // Optional: trial period check
      const trialDays = 50;
      const signupDate = new Date(company.signup_date);
      const today = new Date();
      const daysSinceSignup = Math.floor(
        (today - signupDate) / (1000 * 60 * 60 * 24)
      );

      if (daysSinceSignup > trialDays && !company.has_paid) {
        return res.status(403).json({
          status: 'error',
          message: 'Free trial expired. Please upgrade to continue.',
        });
      }

      // Generate token for company
      const token = jwt.sign(
        {
          type: 'company',
          id: company.id,
          email: company.company_email,
          name: company.company_name,
          permissions: company.permissions,
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.status(200).json({
        status: 'success',
        message: 'Login successful',
        token,
        data: {
          id: company.id,
          companyName: company.company_name,
          email: company.company_email,
          phone: company.company_phone,
          address: company.company_address,
          website: company.company_website,
          two_factor_enabled: company.two_factor_enabled,
          login_notifications: company.login_notifications,
          has_paid: company.has_paid,
          signupDate: company.signup_date, 
          permissions: company.permissions,
          type: 'company'
        },
      });
    }

    // 2. If not company, check staff
    ({ rows } = await pool.query(
      `SELECT s.*, c.company_name, c.company_email AS parent_email, c.company_phone AS parent_phone 
       FROM staff s 
       JOIN companies c ON s.company_id = c.id 
       WHERE s.email = $1`,
      [email]
    ));

    if (rows.length === 0) {
      return res
        .status(401)
        .json({ status: 'error', message: 'Invalid credentials' });
    }

    const staff = rows[0];

    // Compare password
    const isMatch = await bcrypt.compare(password, staff.password_hash);
    if (!isMatch) {
      return res
        .status(401)
        .json({ status: 'error', message: 'Invalid credentials' });
    }

    // Generate token for staff
    const token = jwt.sign(
      {
        type: 'staff',
        id: staff.id,
        email: staff.staff_email,
        name: staff.staff_name,
        companyId: staff.company_id,
        role: staff.role,
        permissions: staff.permissions,
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      status: 'success',
      message: 'Login successful',
      token,
      data: {
        id: staff.id,
        staffName: staff.full_name,
        email: staff.email,
        phone: staff.phone,
        role: staff.role,
        companyId: staff.company_id,
        companyName: staff.company_name,
        parentCompanyEmail: staff.parent_email,
        parentPhone: staff.parent_phone,
        two_factor_enabled: staff.two_factor_enabled,
        login_notifications: staff.login_notifications,
        has_paid: true,
        signupDate: staff.created_at, 
        permissions: staff.permissions,
        type: 'staff', 
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};
