import pool from "../db.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

const formatStartDate = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const formatEndDate = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
};

/**
 * Returns a JS Date representing the start of the given named range.
 * dateRange: 'week' | 'month' | 'quarter' | 'year'
 */
const getDateFromRange = (dateRange) => {
  const now = new Date();
  switch (dateRange) {
    case "week":
      return new Date(now.setDate(now.getDate() - 7));
    case "month":
      return new Date(now.setMonth(now.getMonth() - 1));
    case "quarter":
      return new Date(now.setMonth(now.getMonth() - 3));
    case "year":
      return new Date(now.setFullYear(now.getFullYear() - 1));
    default:
      return null;
  }
};

/**
 * Builds a WHERE fragment + values array for transaction_date filtering.
 * Returns { clause: string, values: any[], nextIndex: number }
 */
const buildDateFilter = (dateRange, startDate, endDate, startParamIndex, dateColumn = "t.transaction_date") => {
  const conditions = [];
  const values = [];
  let idx = startParamIndex;

  if (dateRange === "custom") {
    if (startDate && endDate) {
      conditions.push(`${dateColumn} BETWEEN $${idx} AND $${idx + 1}`);
      values.push(formatStartDate(startDate), formatEndDate(endDate));
      idx += 2;
    } else if (startDate) {
      conditions.push(`${dateColumn} >= $${idx}`);
      values.push(formatStartDate(startDate));
      idx++;
    } else if (endDate) {
      conditions.push(`${dateColumn} <= $${idx}`);
      values.push(formatEndDate(endDate));
      idx++;
    }
  } else if (dateRange && dateRange !== "all") {
    const fromDate = getDateFromRange(dateRange);
    if (fromDate) {
      conditions.push(`${dateColumn} >= $${idx}`);
      values.push(fromDate.toISOString());
      idx++;
    }
  }

  return { clause: conditions.join(" AND "), values, nextIndex: idx };
};

// ─── Overview Report ─────────────────────────────────────────────────────────

const getOverviewReport = async (companyId, dateFilter) => {
  const { clause, values, nextIndex } = dateFilter;
  const dateWhere = clause ? `AND ${clause}` : "";

  // Summary metrics
  const summary = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM customers WHERE company_id = $1 AND is_deleted = false) AS total_clients,
       (SELECT COUNT(*) FROM customers WHERE company_id = $1 AND is_deleted = false AND status = 'Active') AS active_clients,
       COALESCE(SUM(CASE WHEN type = 'deposit' AND is_deleted = false ${dateWhere} THEN amount ELSE 0 END), 0) AS total_contributions,
       COALESCE(SUM(CASE WHEN type = 'withdrawal' AND (status = 'completed' OR status = 'approved') AND is_deleted = false ${dateWhere} THEN amount ELSE 0 END), 0) AS total_withdrawals,
       COUNT(*) FILTER (WHERE is_deleted = false ${dateWhere}) AS total_transactions
     FROM transactions t
     WHERE t.company_id = $1`,
    [companyId, ...values]
  );

  // Monthly trend (last 12 months for overview)
  const monthly = await pool.query(
    `SELECT
       TO_CHAR(transaction_date, 'Mon YYYY') AS month,
       MIN(transaction_date) AS sort_date,
       COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS contributions,
       COALESCE(SUM(CASE WHEN type = 'withdrawal' AND (status='completed' OR status='approved') THEN amount ELSE 0 END), 0) AS withdrawals,
       COUNT(*) AS transaction_count
     FROM transactions
     WHERE company_id = $1 AND is_deleted = false
       AND transaction_date >= NOW() - INTERVAL '12 months'
     GROUP BY TO_CHAR(transaction_date, 'Mon YYYY')
     ORDER BY sort_date ASC`,
    [companyId]
  );

  // Transaction status breakdown
  const status = await pool.query(
    `SELECT status, COUNT(*) AS count
     FROM transactions t
     WHERE t.company_id = $1 AND is_deleted = false ${dateWhere}
     GROUP BY status
     ORDER BY count DESC`,
    [companyId, ...values]
  );

  // Top 5 customers by balance
  const topCustomers = await pool.query(
    `SELECT
       c.id, c.name, c.email, c.phone_number,
       COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END), 0) AS total_balance
     FROM customers c
     LEFT JOIN accounts a ON c.id = a.customer_id
     WHERE c.company_id = $1 AND c.is_deleted = false
     GROUP BY c.id, c.name, c.email, c.phone_number
     ORDER BY total_balance DESC
     LIMIT 5`,
    [companyId]
  );

  return {
    summary: summary.rows[0],
    monthly: monthly.rows,
    status: status.rows,
    topCustomers: topCustomers.rows,
  };
};

// ─── Contributions Report ────────────────────────────────────────────────────

const getContributionsReport = async (companyId, dateFilter) => {
  const { clause, values, nextIndex } = dateFilter;
  const dateWhere = clause ? `AND ${clause}` : "";

  // Summary
  const summary = await pool.query(
    `SELECT
       COUNT(*) AS total_deposits,
       COALESCE(SUM(amount), 0) AS total_amount,
       COALESCE(AVG(amount), 0) AS average_amount,
       COALESCE(MAX(amount), 0) AS highest_deposit,
       COALESCE(MIN(amount), 0) AS lowest_deposit
     FROM transactions t
     WHERE t.company_id = $1 AND type = 'deposit' AND is_deleted = false ${dateWhere}`,
    [companyId, ...values]
  );

  // Monthly contributions (filtered period)
  const monthly = await pool.query(
    `SELECT
       TO_CHAR(transaction_date, 'Mon YYYY') AS month,
       MIN(transaction_date) AS sort_date,
       COALESCE(SUM(amount), 0) AS amount,
       COUNT(*) AS count
     FROM transactions t
     WHERE t.company_id = $1 AND type = 'deposit' AND is_deleted = false ${dateWhere}
     GROUP BY TO_CHAR(transaction_date, 'Mon YYYY')
     ORDER BY sort_date ASC
     LIMIT 12`,
    [companyId, ...values]
  );

  // Top contributing customers (in the date range)
  const topContributors = await pool.query(
    `SELECT
      c.id,
      c.name,
      c.phone_number,
      c.email,
      COALESCE(SUM(t.amount), 0) AS total_contributed,
      COUNT(t.id) AS deposit_count
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id      -- join transactions → accounts
    JOIN customers c ON a.customer_id = c.id    -- join accounts → customers
    WHERE t.company_id = $1 
      AND t.type = 'deposit' 
      AND t.is_deleted = false
      ${dateWhere}   -- optional date filter
    GROUP BY c.id, c.name, c.phone_number, c.email
    ORDER BY total_contributed DESC
    LIMIT 10`,
    [companyId, ...values]
  );

  // Status breakdown for deposits
  const statusBreakdown = await pool.query(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
     FROM transactions t
     WHERE t.company_id = $1 AND type = 'deposit' AND is_deleted = false ${dateWhere}
     GROUP BY status`,
    [companyId, ...values]
  );

  // Recent deposits
  const recentDeposits = await pool.query(
    `SELECT
  t.id,
  t.amount,
  t.status,
  t.transaction_date,
  t.account_id,
  c.name AS customer_name,
  c.phone_number
FROM transactions t
LEFT JOIN accounts a ON t.account_id = a.id       -- join via accounts
LEFT JOIN customers c ON a.customer_id = c.id    -- get customer info
WHERE t.company_id = $1
  AND t.type = 'deposit'
  AND t.is_deleted = false
  ${dateWhere}  -- optional date filter
ORDER BY t.transaction_date DESC
LIMIT 50`,
    [companyId, ...values]
  );

  return {
    summary: summary.rows[0],
    monthly: monthly.rows,
    topContributors: topContributors.rows,
    statusBreakdown: statusBreakdown.rows,
    recentDeposits: recentDeposits.rows,
  };
};

// ─── Client Analysis Report ──────────────────────────────────────────────────

const getClientsReport = async (companyId, dateFilter) => {
  const { clause: txClause, values: txValues } = dateFilter;
  const txDateWhere = txClause ? `AND ${txClause}` : "";

  // Client registration date filter (uses c.date_of_registration)
  const regFilter = buildDateFilter(
    dateFilter.dateRange,
    dateFilter.startDate,
    dateFilter.endDate,
    2,
    "c.date_of_registration"
  );
  const regDateWhere = regFilter.clause ? `AND ${regFilter.clause}` : "";

  // Summary
  const summary = await pool.query(
    `SELECT
       COUNT(*) AS total_clients,
       COUNT(*) FILTER (WHERE status = 'Active') AS active_clients,
       COUNT(*) FILTER (WHERE status != 'Active') AS inactive_clients,
       COUNT(*) FILTER (WHERE date_of_registration >= NOW() - INTERVAL '30 days') AS new_this_month
     FROM customers
     WHERE company_id = $1 AND is_deleted = false`,
    [companyId]
  );

  // New registrations over time
  const registrationTrend = await pool.query(
    `SELECT
       TO_CHAR(date_of_registration, 'Mon YYYY') AS month,
       MIN(date_of_registration) AS sort_date,
       COUNT(*) AS new_clients
     FROM customers c
     WHERE c.company_id = $1 AND c.is_deleted = false
       AND c.date_of_registration >= NOW() - INTERVAL '12 months'
     GROUP BY TO_CHAR(date_of_registration, 'Mon YYYY')
     ORDER BY sort_date ASC`,
    [companyId]
  );

  // Clients by activity (contribution frequency in range)
  const clientActivity = await pool.query(
    `SELECT
      c.id,
      c.name,
      c.phone_number,
      c.email,
      c.status,
      c.date_of_registration,
      COUNT(t.id) AS transaction_count,
      COALESCE(SUM(CASE WHEN t.type = 'deposit' THEN t.amount ELSE 0 END), 0) AS total_deposits,
      COALESCE(SUM(CASE WHEN t.type = 'withdrawal' AND (t.status='completed' OR t.status='approved') THEN t.amount ELSE 0 END), 0) AS total_withdrawals,
      COALESCE(SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END), 0) AS current_balance
    FROM customers c
    LEFT JOIN accounts a ON c.id = a.customer_id
    LEFT JOIN transactions t ON t.account_id = a.id AND t.is_deleted = false ${txDateWhere}  -- join via account
    WHERE c.company_id = $1 AND c.is_deleted = false
    GROUP BY c.id, c.name, c.phone_number, c.email, c.status, c.date_of_registration
    ORDER BY total_deposits DESC
    LIMIT 20`,
    [companyId, ...txValues]
  );

  // Dormant clients (no transactions in range)
  const dormantClients = await pool.query(
    `SELECT 
    c.id,
    c.name,
    c.phone_number,
    c.email,
    c.date_of_registration,
    MAX(t.transaction_date) AS last_transaction
    FROM customers c
    LEFT JOIN accounts a ON c.id = a.customer_id
    LEFT JOIN transactions t ON t.account_id = a.id AND t.is_deleted = false
    WHERE c.company_id = $1 
      AND c.is_deleted = false 
      AND c.status = 'Active'
    GROUP BY c.id, c.name, c.phone_number, c.email, c.date_of_registration
    HAVING MAX(t.transaction_date) < NOW() - INTERVAL '30 days' 
          OR MAX(t.transaction_date) IS NULL
    ORDER BY last_transaction ASC NULLS FIRST
    LIMIT 10`,
    [companyId]
  );

  return {
    summary: summary.rows[0],
    registrationTrend: registrationTrend.rows,
    clientActivity: clientActivity.rows,
    dormantClients: dormantClients.rows,
  };
};

// ─── Financial Summary Report ────────────────────────────────────────────────

const getFinancialReport = async (companyId, dateFilter) => {
  const { clause, values } = dateFilter;
  const dateWhere = clause ? `AND ${clause}` : "";

  // Core financial summary
  const summary = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'deposit' AND is_deleted = false ${dateWhere} THEN amount ELSE 0 END), 0) AS total_contributions,
       COALESCE(SUM(CASE WHEN type = 'withdrawal' AND (status='completed' OR status='approved') AND is_deleted = false ${dateWhere} THEN amount ELSE 0 END), 0) AS total_withdrawals,
       COALESCE(SUM(CASE WHEN type = 'deposit' AND is_deleted = false ${dateWhere} THEN amount ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN type = 'withdrawal' AND (status='completed' OR status='approved') AND is_deleted = false ${dateWhere} THEN amount ELSE 0 END), 0) AS net_flow,
       COUNT(*) FILTER (WHERE is_deleted = false ${dateWhere}) AS total_transactions
     FROM transactions t
     WHERE t.company_id = $1`,
    [companyId, ...values]
  );

  // Account balances overview
  const accountBalances = await pool.query(
    `SELECT
       a.account_type,
       COUNT(*) AS account_count,
       COALESCE(SUM(a.balance), 0) AS total_balance
     FROM accounts a
     JOIN customers c ON a.customer_id = c.id
     WHERE c.company_id = $1 AND c.is_deleted = false
     GROUP BY a.account_type
     ORDER BY total_balance DESC`,
    [companyId]
  );

  // Monthly net flow
  const monthlyFlow = await pool.query(
    `SELECT
       TO_CHAR(transaction_date, 'Mon YYYY') AS month,
       MIN(transaction_date) AS sort_date,
       COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS deposits,
       COALESCE(SUM(CASE WHEN type = 'withdrawal' AND (status='completed' OR status='approved') THEN amount ELSE 0 END), 0) AS withdrawals
     FROM transactions t
     WHERE t.company_id = $1 AND t.is_deleted = false
       AND t.transaction_date >= NOW() - INTERVAL '12 months'
     GROUP BY TO_CHAR(transaction_date, 'Mon YYYY')
     ORDER BY sort_date ASC`,
    [companyId]
  );

  // Commissions summary
  const commissions = await pool.query(
    `SELECT
       COALESCE(SUM(amount), 0) AS total_commissions,
       COUNT(*) AS commission_count
     FROM commissions
     WHERE company_id = $1`,
    [companyId]
  );

  // Large transactions in range
  const largeTransactions = await pool.query(
    `SELECT
    t.id,
    t.type,
    t.amount,
    t.status,
    t.transaction_date,
    c.name AS customer_name
FROM transactions t
LEFT JOIN accounts a ON t.account_id = a.id           -- join via account
LEFT JOIN customers c ON a.customer_id = c.id        -- then get customer info
WHERE t.company_id = $1
  AND t.is_deleted = false
  ${dateWhere}   -- optional date filter
ORDER BY t.amount DESC
LIMIT 10`,
    [companyId, ...values]
  );

  return {
    summary: summary.rows[0],
    accountBalances: accountBalances.rows,
    monthlyFlow: monthlyFlow.rows,
    commissions: commissions.rows[0],
    largeTransactions: largeTransactions.rows,
  };
};

// ─── Main Controller ─────────────────────────────────────────────────────────

export const getDashboardReport = async (req, res) => {
  const { companyId } = req.params;
  const {
    reportType = "overview",
    dateRange = "month",
    startDate,
    endDate,
  } = req.query;

  try {
    // Build date filter object
    const dateFilter = buildDateFilter(dateRange, startDate, endDate, 2);
    dateFilter.dateRange = dateRange;
    dateFilter.startDate = startDate;
    dateFilter.endDate = endDate;

    let data;

    switch (reportType) {
      case "contributions":
        data = await getContributionsReport(companyId, dateFilter);
        break;
      case "clients":
        data = await getClientsReport(companyId, dateFilter);
        break;
      case "financial":
        data = await getFinancialReport(companyId, dateFilter);
        break;
      case "overview":
      default:
        data = await getOverviewReport(companyId, dateFilter);
        break;
    }

    return res.status(200).json({
      status: "success",
      reportType,
      dateRange,
      generatedAt: new Date().toISOString(),
      data,
    });
  } catch (error) {
    console.error("Report generation error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to generate report",
      detail: error.message,
    });
  }
};

// ─── All Customers (unchanged) ───────────────────────────────────────────────

export const getAllCustomersForReport = async (req, res) => {
  try {
    const customers = await pool.query(
      `SELECT * FROM customers ORDER BY created_at DESC`
    );
    return res.status(200).json({
      status: "success",
      results: customers.rowCount,
      data: customers.rows,
    });
  } catch (error) {
    console.error("Error fetching all customers:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};
