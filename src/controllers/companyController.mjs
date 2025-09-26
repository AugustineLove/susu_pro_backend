import bcrypt from 'bcryptjs';
import pool from '../db.mjs';

export const createCompany = async (req, res) => {
  try {
    const { companyName, email, phone, address, website, password } = req.body;
     console.log('Creating company')
    // Check if email exists
    const { rows: existing } = await pool.query(
      'SELECT * FROM companies WHERE company_email = $1',
      [email]
    );
    if (existing.length > 0) {
      return res.status(400).json({ status: 'error', message: 'Company with this email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    const signupDate = new Date(); // current time

const insertQuery = `
  INSERT INTO companies (
    company_name, company_email, company_phone, company_address, company_website, password_hash, signup_date
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING id, company_name, company_email, company_phone, company_address, company_website, signup_date, created_at
`;

const values = [
  companyName,
  email,
  phone,
  address,
  website,
  passwordHash,
  signupDate
];
    const { rows } = await pool.query(insertQuery, values);

    res.status(201).json({
      status: 'success',
      message: 'Company created successfully',
      data: rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

export const getAllCompanies = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, company_name, company_email, company_phone, company_address, company_website, created_at 
       FROM companies
       ORDER BY created_at DESC`
    );

    res.status(200).json({
      status: 'success',
      message: 'Companies retrieved successfully',
      data: rows
    });
  } catch (error) {
    console.error('Error fetching companies:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};


export const getCompanyStats = async (req, res) => {
  try {
    const companyId = req.user.type === 'staff' ? req.user.companyId : req.user.id;
    console.log('Fetching stats for company ID:', companyId);
const customerQuery = 'SELECT COUNT(*) FROM customers WHERE company_id = $1';
const transactionQuery = 'SELECT COUNT(*) FROM transactions WHERE company_id = $1';
const balanceQuery = 'SELECT COALESCE(SUM(balance), 0) AS total_balance FROM accounts WHERE company_id = $1';
const commissionQuery = 'SELECT COALESCE(SUM(amount), 0) AS total_commissions FROM commissions WHERE company_id = $1';

const [
  { rows: customers },
  { rows: transactions },
  { rows: balances },
  { rows: commissions }
] = await Promise.all([
  pool.query(customerQuery, [companyId]),
  pool.query(transactionQuery, [companyId]),
  pool.query(balanceQuery, [companyId]),
  pool.query(commissionQuery, [companyId])
]);

res.json({
  status: 'success',
  data: {
    totalCustomers: parseInt(customers[0].count),
    totalTransactions: parseInt(transactions[0].count),
    totalBalance: parseFloat(balances[0].total_balance),
    totalCommissions: parseFloat(commissions[0].total_commissions)
  }
});

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

export const updateProfile = async (req, res) => {
  const {
    id,         // or email if you want to use that as identifier
    name,
    email,
    phone,
    address,
    website,
  } = req.body;

  if (!id || !name || !email || !phone || !address) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const result = await pool.query(
      `UPDATE companies
       SET company_name = $1,
           company_email = $2,
           company_phone = $3,
           company_address = $4,
           company_website = $5
       WHERE id = $6
       RETURNING id`,
      [name, email, phone, address, website || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Company profile not found.' });
    }

    return res.status(200).json({ message: 'Profile updated successfully!', id: result.rows[0].id });
  } catch (err) {
    console.error('Error updating company profile:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

export const loginNotification = async (req, res) => {
  const {companyId, logNotStat} = req.body;
  console.log(logNotStat)
  try {
    const company = await pool.query('SELECT company_name FROM companies WHERE id = $1', [companyId]);
    if(company.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Company not found' });
    }

    const company_name = company.rows[0].company_name;

    const updatelognot = await pool.query('UPDATE companies SET login_notifications = $1 WHERE id = $2', [logNotStat, companyId]);
    if (updatelognot.rowCount === 0) {
      return res.status(404).json({ status: 'error', message: 'Company not found' });
    }

    console.log(updatelognot);

    return res.status(200).json({ status: 'success', message: 'Login notification enabled', company_name });
  } catch (error) {
    console.error('Error updating login notification:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
}

export const smsOrEmailNotifications = async (req, res) => {
  const {companyId, smsEnabled, emailEnabled, showWithdrawalAlerts, systemUpdates} = req.body;
  console.log(smsEnabled, emailEnabled)
  try {
    const company = await pool.query('SELECT company_name FROM companies WHERE id = $1', [companyId]);
    if(company.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Company not found' });
    }

    const company_name = company.rows[0].company_name;

    const updatelognot  = await pool.query('UPDATE companies SET email_notifications = $1, sms_notifications = $2, show_withdrawal_alerts = $3, receive_system_updates = $4 WHERE id = $5', [emailEnabled, smsEnabled, showWithdrawalAlerts, systemUpdates, companyId]);
    if (updatelognot.rowCount === 0) {
      return res.status(404).json({ status: 'error', message: 'Company not found' });
    }

    console.log(updatelognot);

    return res.status(200).json({ status: 'success', message: 'Login notification enabled', company_name });
  } catch (error) {
    console.error('Error updating login notification:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
}

