import pool from "../db.mjs";

export const getAllCustomersForReport = async (req, res) => {
  try {
    const customers = await pool.query(
      `SELECT * FROM customers ORDER BY created_at DESC`
    );

    return res.status(200).json({
      status: 'success',
      results: customers.rowCount,
      data: customers.rows,
    });

  } catch (error) {
    console.error('Error fetching all customers:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getDashboardReport = async (req, res) => {
    const { companyId } = req.params;
  try {
    // Total & Active Customers
    const customers = await pool.query(`
      SELECT 
        COUNT(*) AS total_clients,
        COUNT(*) FILTER (WHERE status = 'Active') AS active_clients
      FROM customers
      WHERE company_id = $1 AND is_deleted = false
    `, [companyId]);

    // Transactions Summary
    const transactions = await pool.query(`
      SELECT
        SUM(CASE WHEN type = 'deposit' AND is_deleted = false THEN amount ELSE 0 END) AS total_contributions,
        SUM(CASE WHEN type = 'withdrawal' AND (status = 'completed' OR status = 'approved')  AND is_deleted = false THEN amount ELSE 0 END) AS total_withdrawals
      FROM transactions
      WHERE company_id = $1
    `, [companyId]);

    // Monthly Contributions (last 6 months)
   const monthly = await pool.query(`
    SELECT 
        TO_CHAR(transaction_date, 'Mon YYYY') AS month,
        SUM(amount) AS amount
    FROM transactions
    WHERE type = 'deposit' AND status = 'completed'
        AND company_id = $1
    GROUP BY month
    ORDER BY MIN(transaction_date) DESC
    LIMIT 6
    `, [companyId]);

    // Transaction Status
    const status = await pool.query(`
      SELECT status, COUNT(*) 
      FROM transactions
      WHERE company_id = $1 
      GROUP BY status
    `, [companyId]);

    // Top Customers
    const topCustomers = await pool.query(`
    SELECT 
        c.id,
        c.name, 
        c.email, 
        c.phone_number,
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
    WHERE c.company_id = $1
    GROUP BY c.id, c.name, c.email, c.phone_number
    ORDER BY total_balance_across_all_accounts DESC
    LIMIT 5
    `, [companyId]);

    return res.status(200).json({
      status: 'success',
      data: {
        summary: {
          totalClients: customers.rows[0].total_clients,
          activeClients: customers.rows[0].active_clients,
          totalContributions: transactions.rows[0].total_contributions,
          totalWithdrawals: transactions.rows[0].total_withdrawals,
        },
        monthly: monthly.rows,
        status: status.rows,
        topCustomers: topCustomers.rows
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch report data'
    });
  }
};