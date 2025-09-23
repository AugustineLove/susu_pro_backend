import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../../db.mjs';
import dotenv from 'dotenv';
dotenv.config();


const JWT_SECRET = process.env.JWT_SECRET || '';

export const loginCompany = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if company exists
    const { rows } = await pool.query(
      'SELECT * FROM companies WHERE company_email = $1',
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
    }

    const company = rows[0];

    // Compare passwords
    const isMatch = await bcrypt.compare(password, company.password_hash);
    if (!isMatch) {
      return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
    }

    // Optional: Check if free trial expired (e.g., 14 days)
    const trialDays = 50;
    const signupDate = new Date(company.signup_date);
    const today = new Date();
    const daysSinceSignup = Math.floor((today - signupDate) / (1000 * 60 * 60 * 24));

    if (daysSinceSignup > trialDays && !company.has_paid) {
      return res.status(403).json({ status: 'error', message: 'Free trial expired. Please upgrade to continue.' });
    }

    // Generate token
    const token = jwt.sign(
      {
        id: company.id,
        email: company.company_email,
        name: company.company_name
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
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
        has_paid : company.has_paid,
        signupDate: company.signup_date
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};


