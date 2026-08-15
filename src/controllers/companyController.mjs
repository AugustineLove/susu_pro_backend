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


const DEPOSIT_LIABILITY_CODES = ['2010-01', '2010-03']; // savings/susu, fixed deposit
const COMMISSION_INCOME_CODE  = '4020';

export const getCompanyStats = async (req, res) => {
  try {
    const companyId =
      req.user.type === "staff" ? req.user.companyId : req.user.id;

    // ---------------------------
    // 1️⃣ Customers count
    // ---------------------------
    const customerQuery = `
      SELECT COUNT(*)
      FROM customers
      WHERE company_id = $1
        AND is_deleted = false
    `;

    // ---------------------------
    // 2️⃣ Transactions count
    // ---------------------------
    const transactionCountQuery = `
      SELECT COUNT(*)
      FROM transactions
      WHERE company_id = $1
        AND is_deleted = false
    `;

    // ---------------------------
    // 3️⃣ Pending withdrawals
    // ---------------------------
    // These haven't been approved yet, which means no journal entry has
    // been posted for them (see stakeMoney / approveTransaction) — there
    // is nothing in the ledger to reconcile against, so this is the one
    // figure that legitimately stays sourced from the transactions table.
    const pendingWithdrawalsQuery = `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE company_id = $1
        AND type = 'withdrawal'
        AND status = 'pending'
        AND is_deleted = false
    `;

    // ---------------------------
    // 4️⃣ Customer balance (deposits liability)
    // ---------------------------
    // Same posted-only correlated-subquery pattern as getChartOfAccounts /
    // getTrialBalance — this IS the accounting module's own number, not a
    // re-derivation of it.
    const balanceQuery = `
      SELECT COALESCE(SUM(
        CASE coa.normal_balance
          WHEN 'credit' THEN
            COALESCE((
              SELECT SUM(jel.amount) FROM journal_entry_lines jel
              JOIN journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.coa_id = coa.id AND je.status = 'posted' AND je.company_id = $1
                AND jel.debit_credit = 'credit'
            ), 0)
            -
            COALESCE((
              SELECT SUM(jel.amount) FROM journal_entry_lines jel
              JOIN journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.coa_id = coa.id AND je.status = 'posted' AND je.company_id = $1
                AND jel.debit_credit = 'debit'
            ), 0)
          ELSE 0
        END
      ), 0) AS total_balance
      FROM chart_of_accounts coa
      WHERE coa.company_id = $1
        AND coa.code = ANY($2::text[])
        AND coa.is_deleted = false
    `;

    // ---------------------------
    // 5️⃣ Total deposits (posted only)
    // ---------------------------
    // Credit side of the deposit-liability account, from deposit journal
    // entries specifically — excludes pending/draft and excludes
    // commission/withdrawal lines that touch the same liability account.
    const depositsQuery = `
      SELECT COALESCE(SUM(jel.amount), 0) AS total
      FROM journal_entry_lines jel
      JOIN journal_entries je   ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.coa_id
      WHERE je.company_id = $1
        AND je.status = 'posted'
        AND je.source = 'customer_deposit'
        AND jel.debit_credit = 'credit'
        AND coa.code = ANY($2::text[])
    `;

    // ---------------------------
    // 6️⃣ Total approved withdrawals (posted only)
    // ---------------------------
    const withdrawalsQuery = `
      SELECT COALESCE(SUM(jel.amount), 0) AS total
      FROM journal_entry_lines jel
      JOIN journal_entries je   ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.coa_id
      WHERE je.company_id = $1
        AND je.status = 'posted'
        AND je.source = 'customer_withdrawal'
        AND jel.debit_credit = 'debit'
        AND coa.code = ANY($2::text[])
    `;

    // ---------------------------
    // 7️⃣ Total commissions (posted only)
    // ---------------------------
    const commissionQuery = `
      SELECT COALESCE(SUM(jel.amount), 0) AS total
      FROM journal_entry_lines jel
      JOIN journal_entries je   ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.coa_id
      WHERE je.company_id = $1
        AND je.status = 'posted'
        AND je.source = 'commission'
        AND jel.debit_credit = 'credit'
        AND coa.code = $2
    `;

    // ---------------------------
    // Execute all in parallel
    // ---------------------------
    const [
      { rows: customers },
      { rows: transactionsCount },
      { rows: pendingW },
      { rows: balances },
      { rows: deposits },
      { rows: withdrawals },
      { rows: commissions },
    ] = await Promise.all([
      pool.query(customerQuery, [companyId]),
      pool.query(transactionCountQuery, [companyId]),
      pool.query(pendingWithdrawalsQuery, [companyId]),
      pool.query(balanceQuery, [companyId, DEPOSIT_LIABILITY_CODES]),
      pool.query(depositsQuery, [companyId, DEPOSIT_LIABILITY_CODES]),
      pool.query(withdrawalsQuery, [companyId, DEPOSIT_LIABILITY_CODES]),
      pool.query(commissionQuery, [companyId, COMMISSION_INCOME_CODE]),
    ]);

    // ---------------------------
    // Response
    // ---------------------------
    res.json({
      status: "success",
      data: {
        totalCustomers: parseInt(customers[0].count, 10),
        totalTransactions: parseInt(transactionsCount[0].count, 10),

        totalBalance: parseFloat(balances[0].total_balance),

        totalDeposits: parseFloat(deposits[0].total),
        totalApprovedWithdrawals: parseFloat(withdrawals[0].total),
        totalPendingWithdrawals: parseFloat(pendingW[0].total),

        totalCommissions: parseFloat(commissions[0].total),
      }
    });

  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({
      status: "error",
      message: "Internal server error"
    });
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

