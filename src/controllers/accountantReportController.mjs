import pool from "../db.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const fmt2 = (n) => parseFloat(parseFloat(n || 0).toFixed(2));

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
 * Resolves period boundaries from a named range OR explicit start/end.
 * Returns { startDate: ISO string, endDate: ISO string, label: string }
 */
const resolvePeriod = (period, startDate, endDate) => {
  const now = new Date();

  if (period === "custom" && startDate && endDate) {
    return {
      startDate: formatStartDate(startDate),
      endDate:   formatEndDate(endDate),
      label:     `${startDate} to ${endDate}`,
    };
  }

  switch (period) {
    case "today": {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Today" };
    }
    case "yesterday": {
      const s = new Date(now); s.setDate(s.getDate() - 1); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setDate(e.getDate() - 1); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Yesterday" };
    }
    case "this_week": {
      const day = now.getDay();
      const s = new Date(now); s.setDate(now.getDate() - day); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "This Week" };
    }
    case "last_week": {
      const day = now.getDay();
      const s = new Date(now); s.setDate(now.getDate() - day - 7); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setDate(now.getDate() - day - 1); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Last Week" };
    }
    case "this_month": {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "This Month" };
    }
    case "last_month": {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Last Month" };
    }
    case "this_quarter": {
      const q = Math.floor(now.getMonth() / 3);
      const s = new Date(now.getFullYear(), q * 3, 1);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "This Quarter" };
    }
    case "last_quarter": {
      const q = Math.floor(now.getMonth() / 3);
      const s = new Date(now.getFullYear(), (q - 1) * 3, 1);
      const e = new Date(now.getFullYear(), q * 3, 0); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Last Quarter" };
    }
    case "this_year": {
      const s = new Date(now.getFullYear(), 0, 1);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "This Year" };
    }
    case "last_year": {
      const s = new Date(now.getFullYear() - 1, 0, 1);
      const e = new Date(now.getFullYear() - 1, 11, 31); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Last Year" };
    }
    case "last_7_days": {
      const s = new Date(now); s.setDate(s.getDate() - 6); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Last 7 Days" };
    }
    case "last_30_days": {
      const s = new Date(now); s.setDate(s.getDate() - 29); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Last 30 Days" };
    }
    case "last_90_days": {
      const s = new Date(now); s.setDate(s.getDate() - 89); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      return { startDate: s.toISOString(), endDate: e.toISOString(), label: "Last 90 Days" };
    }
    default: {
      // fallback: all time
      return { startDate: null, endDate: null, label: "All Time" };
    }
  }
};

/**
 * Builds a parameterised WHERE fragment for transaction_date.
 * Returns { clause, values, nextIndex }
 */
const buildTxDateFilter = (startDate, endDate, startIdx, dateColumn = "t.transaction_date") => {
  if (!startDate && !endDate) return { clause: "", values: [], nextIndex: startIdx };

  const conditions = [];
  const values = [];
  let idx = startIdx;

  if (startDate) {
    conditions.push(`${dateColumn} >= $${idx++}`);
    values.push(startDate);
  }
  if (endDate) {
    conditions.push(`${dateColumn} <= $${idx++}`);
    values.push(endDate);
  }

  return { clause: conditions.join(" AND "), values, nextIndex: idx };
};

/** Same but for loan columns (created_at / disbursementdate etc.) */
const buildLoanDateFilter = (startDate, endDate, startIdx, dateColumn = "l.created_at") => {
  return buildTxDateFilter(startDate, endDate, startIdx, dateColumn);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1.  DAILY REPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/accountant/:companyId/daily
 *
 * Query: ?date=YYYY-MM-DD   (defaults to today)
 *
 * Returns:
 *   - Deposits collected today (count + total)
 *   - Withdrawals processed today
 *   - Loan repayments received today
 *   - New loan applications today
 *   - Hourly breakdown of transactions
 *   - List of all transactions that day
 *   - Cash-flow summary (net)
 */
export const getDailyReport = async (req, res) => {
  const { companyId } = req.params;
  const targetDate = req.query.date || new Date().toISOString().split("T")[0];

  const dayStart = formatStartDate(targetDate);
  const dayEnd   = formatEndDate(targetDate);

  try {
    // ── Core transaction summary ──
    const summary = await pool.query(
      `SELECT
         COUNT(*)                                                                            AS total_transactions,
         COUNT(*) FILTER (WHERE type = 'deposit' AND is_deleted = false)                    AS deposit_count,
         COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND is_deleted = false), 0)   AS total_deposits,
         COUNT(*) FILTER (WHERE type = 'withdrawal' AND is_deleted = false)                 AS withdrawal_count,
         COALESCE(SUM(amount) FILTER (
           WHERE type = 'withdrawal'
             AND (status = 'completed' OR status = 'approved')
             AND is_deleted = false
         ), 0)                                                                               AS total_withdrawals,
         COUNT(*) FILTER (WHERE status = 'pending' AND is_deleted = false)                  AS pending_count,
         COUNT(*) FILTER (WHERE status = 'failed'  AND is_deleted = false)                  AS failed_count
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3`,
      [companyId, dayStart, dayEnd]
    );

    // ── Loan repayments received today ──
    const repayments = await pool.query(
      `SELECT
         COUNT(*)                     AS repayment_count,
         COALESCE(SUM(lr.amount), 0)  AS total_repaid
       FROM loan_repayments lr
       JOIN loans l ON lr.loan_id = l.id
       WHERE l.company_id = $1
         AND lr.payment_date BETWEEN $2 AND $3`,
      [companyId, dayStart, dayEnd]
    );

    // ── New loan applications today ──
    const newLoans = await pool.query(
      `SELECT
         COUNT(*)                             AS new_applications,
         COALESCE(SUM(loanamount), 0)         AS total_applied,
         COUNT(*) FILTER (WHERE status = 'active'   OR status = 'approved') AS approved_today,
         COUNT(*) FILTER (WHERE status = 'rejected')                        AS rejected_today
       FROM loans
       WHERE company_id = $1
         AND created_at BETWEEN $2 AND $3
         AND loantype != 'group_member'`,
      [companyId, dayStart, dayEnd]
    );

    // ── Hourly transaction breakdown ──
    const hourly = await pool.query(
      `SELECT
         EXTRACT(HOUR FROM transaction_date)::int   AS hour,
         COUNT(*)                                   AS count,
         COALESCE(SUM(CASE WHEN type='deposit'    THEN amount ELSE 0 END), 0) AS deposits,
         COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE 0 END), 0) AS withdrawals
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       GROUP BY hour
       ORDER BY hour ASC`,
      [companyId, dayStart, dayEnd]
    );

    // ── Full transaction list for the day ──
    const transactions = await pool.query(
      `SELECT
         t.id, t.type, t.amount, t.status, t.transaction_date, t.reference,
         c.name AS customer_name, c.phone_number AS customer_phone,
         a.account_type
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN customers c ON a.customer_id = c.id
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       ORDER BY t.transaction_date DESC`,
      [companyId, dayStart, dayEnd]
    );

    // ── New customers registered today ──
    const newCustomers = await pool.query(
      `SELECT COUNT(*) AS count
       FROM customers
       WHERE company_id = $1
         AND date_of_registration BETWEEN $2 AND $3
         AND is_deleted = false`,
      [companyId, dayStart, dayEnd]
    );

    const s  = summary.rows[0];
    const r  = repayments.rows[0];
    const nl = newLoans.rows[0];

    const netCashFlow = fmt2(s.total_deposits) + fmt2(r.total_repaid) - fmt2(s.total_withdrawals);

    return res.status(200).json({
      status: "success",
      reportType: "daily",
      date: targetDate,
      generatedAt: new Date().toISOString(),
      data: {
        summary: {
          date: targetDate,
          total_transactions:  parseInt(s.total_transactions),
          deposit_count:       parseInt(s.deposit_count),
          total_deposits:      fmt2(s.total_deposits),
          withdrawal_count:    parseInt(s.withdrawal_count),
          total_withdrawals:   fmt2(s.total_withdrawals),
          net_cash_flow:       fmt2(netCashFlow),
          pending_count:       parseInt(s.pending_count),
          failed_count:        parseInt(s.failed_count),
          repayment_count:     parseInt(r.repayment_count),
          total_repaid:        fmt2(r.total_repaid),
          new_loan_applications: parseInt(nl.new_applications),
          total_applied:       fmt2(nl.total_applied),
          loans_approved_today: parseInt(nl.approved_today),
          loans_rejected_today: parseInt(nl.rejected_today),
          new_customers:       parseInt(newCustomers.rows[0].count),
        },
        hourlyBreakdown: hourly.rows,
        transactions:    transactions.rows,
      },
    });
  } catch (err) {
    console.error("getDailyReport error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to generate daily report", detail: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 2.  WEEKLY REPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/accountant/:companyId/weekly
 *
 * Query: ?period=this_week|last_week   OR   ?startDate=&endDate=
 */
export const getWeeklyReport = async (req, res) => {
  const { companyId } = req.params;
  const period = req.query.period || "this_week";

  const { startDate, endDate, label } = resolvePeriod(
    period,
    req.query.startDate,
    req.query.endDate
  );

  const { clause: txClause, values: txVals, nextIndex } = buildTxDateFilter(startDate, endDate, 2);
  const txWhere = txClause ? `AND ${txClause}` : "";

  const loanFilter = buildLoanDateFilter(startDate, endDate, 2);
  const loanWhere  = loanFilter.clause ? `AND ${loanFilter.clause}` : "";

  try {
    // ── Summary ──
    const summary = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE type='deposit'    AND is_deleted=false ${txWhere}) AS deposit_count,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND is_deleted=false ${txWhere}), 0) AS total_deposits,
         COUNT(*) FILTER (WHERE type='withdrawal' AND is_deleted=false ${txWhere}) AS withdrawal_count,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false ${txWhere}
         ), 0) AS total_withdrawals
       FROM transactions t
       WHERE t.company_id = $1`,
      [companyId, ...txVals]
    );

    // ── Daily breakdown for each day in the week ──
    const daily = await pool.query(
      `SELECT
         DATE(transaction_date)                                                  AS day,
         TO_CHAR(transaction_date, 'Dy DD Mon')                                  AS day_label,
         COUNT(*) FILTER (WHERE is_deleted=false)                                AS tx_count,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND is_deleted=false), 0)  AS deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false
         ), 0)                                                                   AS withdrawals
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       GROUP BY day, day_label
       ORDER BY day ASC`,
      [companyId, startDate, endDate]
    );

    // ── Loan repayments for the week ──
    const repayments = await pool.query(
      `SELECT
         DATE(lr.payment_date)               AS day,
         COUNT(*)                            AS count,
         COALESCE(SUM(lr.amount), 0)         AS amount
       FROM loan_repayments lr
       JOIN loans l ON lr.loan_id = l.id
       WHERE l.company_id = $1
         AND lr.payment_date BETWEEN $2 AND $3
       GROUP BY day
       ORDER BY day ASC`,
      [companyId, startDate, endDate]
    );

    // ── New loans this week ──
    const newLoans = await pool.query(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM(loanamount), 0) AS total_amount,
         COUNT(*) FILTER (WHERE status='active' OR status='approved') AS approved
       FROM loans l
       WHERE l.company_id = $1
         AND l.created_at BETWEEN $2 AND $3
         AND l.loantype != 'group_member'`,
      [companyId, startDate, endDate]
    );

    // ── Top performing collectors / agents this week ──
    const topAgents = await pool.query(
      `SELECT
         t.created_by,
         COUNT(*) AS transaction_count,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit'), 0) AS deposits_collected
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       GROUP BY t.created_by
       ORDER BY deposits_collected DESC
       LIMIT 10`,
      [companyId, startDate, endDate]
    );

    // ── Comparison: same period last week ──
    const prevEnd   = new Date(startDate); prevEnd.setMilliseconds(prevEnd.getMilliseconds() - 1);
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6); prevStart.setHours(0, 0, 0, 0);

    const prevSummary = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND is_deleted=false), 0)    AS total_deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false
         ), 0) AS total_withdrawals
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3`,
      [companyId, prevStart.toISOString(), prevEnd.toISOString()]
    );

    const curr = summary.rows[0];
    const prev = prevSummary.rows[0];
    const depositChange = prev.total_deposits > 0
      ? (((curr.total_deposits - prev.total_deposits) / prev.total_deposits) * 100).toFixed(1)
      : null;

    return res.status(200).json({
      status: "success",
      reportType: "weekly",
      period: label,
      dateRange: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      data: {
        summary: {
          deposit_count:     parseInt(curr.deposit_count),
          total_deposits:    fmt2(curr.total_deposits),
          withdrawal_count:  parseInt(curr.withdrawal_count),
          total_withdrawals: fmt2(curr.total_withdrawals),
          net_flow:          fmt2(curr.total_deposits - curr.total_withdrawals),
          new_loans:         parseInt(newLoans.rows[0].count),
          loans_amount:      fmt2(newLoans.rows[0].total_amount),
          loans_approved:    parseInt(newLoans.rows[0].approved),
        },
        comparison: {
          prev_deposits:      fmt2(prev.total_deposits),
          prev_withdrawals:   fmt2(prev.total_withdrawals),
          deposit_change_pct: depositChange,
        },
        dailyBreakdown: daily.rows,
        repaymentsByDay: repayments.rows,
        topAgents:       topAgents.rows,
      },
    });
  } catch (err) {
    console.error("getWeeklyReport error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to generate weekly report", detail: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 3.  MONTHLY REPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/accountant/:companyId/monthly
 *
 * Query: ?period=this_month|last_month|custom  &startDate=&endDate=
 */
export const getMonthlyReport = async (req, res) => {
  const { companyId } = req.params;
  const period = req.query.period || "this_month";

  const { startDate, endDate, label } = resolvePeriod(
    period,
    req.query.startDate,
    req.query.endDate
  );

  const { clause: txClause, values: txVals } = buildTxDateFilter(startDate, endDate, 2);
  const txWhere   = txClause ? `AND ${txClause}` : "";
  const loanVals  = [companyId, startDate, endDate];

  try {
    // ── Transaction summary ──
    const summary = await pool.query(
      `SELECT
         COUNT(*)                                                          AS total_transactions,
         COUNT(*)  FILTER (WHERE type='deposit'    AND is_deleted=false ${txWhere}) AS deposit_count,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND is_deleted=false ${txWhere}), 0) AS total_deposits,
         COUNT(*)  FILTER (WHERE type='withdrawal' AND is_deleted=false ${txWhere}) AS withdrawal_count,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false ${txWhere}
         ), 0)                                                             AS total_withdrawals,
         COALESCE(AVG(amount) FILTER (WHERE type='deposit' AND is_deleted=false ${txWhere}), 0) AS avg_deposit
       FROM transactions t
       WHERE t.company_id = $1`,
      [companyId, ...txVals]
    );

    // ── Weekly breakdown within the month ──
    const weeklyBreakdown = await pool.query(
      `SELECT
         DATE_TRUNC('week', transaction_date)::date           AS week_start,
         TO_CHAR(DATE_TRUNC('week', transaction_date), 'DD Mon') AS week_label,
         COUNT(*) FILTER (WHERE is_deleted=false)             AS tx_count,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND is_deleted=false), 0)  AS deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false
         ), 0)                                                 AS withdrawals
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       GROUP BY week_start, week_label
       ORDER BY week_start ASC`,
      [companyId, startDate, endDate]
    );

    // ── Loan portfolio snapshot ──
    const loanSnapshot = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE loantype != 'group_member')                                    AS total_loans,
         COALESCE(SUM(loanamount) FILTER (WHERE loantype != 'group_member'), 0)                AS total_loan_amount,
         COALESCE(SUM(disbursedamount) FILTER (
           WHERE loantype != 'group_member' AND (status='active' OR status='approved')
         ), 0)                                                                                  AS total_disbursed,
         COALESCE(SUM(outstandingbalance) FILTER (WHERE loantype != 'group_member'), 0)        AS total_outstanding,
         COUNT(*) FILTER (WHERE status='overdue' AND loantype != 'group_member')               AS overdue_count,
         COALESCE(SUM(outstandingbalance) FILTER (WHERE status='overdue'), 0)                  AS overdue_amount,
         COUNT(*) FILTER (WHERE status='pending' AND loantype != 'group_member')               AS pending_applications
       FROM loans
       WHERE company_id = $1`,
      [companyId]
    );

    // ── New loans created this month ──
    const newLoansMonth = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE loantype != 'group_member')                                 AS new_applications,
         COALESCE(SUM(loanamount) FILTER (WHERE loantype != 'group_member'), 0)            AS amount_applied,
         COUNT(*) FILTER (WHERE (status='active' OR status='approved') AND loantype != 'group_member') AS approved,
         COUNT(*) FILTER (WHERE status='rejected' AND loantype != 'group_member')          AS rejected
       FROM loans l
       WHERE l.company_id = $1
         AND l.created_at BETWEEN $2 AND $3`,
      loanVals
    );

    // ── Repayments received this month ──
    const repaymentSummary = await pool.query(
      `SELECT
         COUNT(*)                    AS count,
         COALESCE(SUM(lr.amount), 0) AS total_collected,
         COALESCE(AVG(lr.amount), 0) AS avg_repayment
       FROM loan_repayments lr
       JOIN loans l ON lr.loan_id = l.id
       WHERE l.company_id = $1
         AND lr.payment_date BETWEEN $2 AND $3`,
      loanVals
    );

    // ── Top 10 depositors this month ──
    const topDepositors = await pool.query(
      `SELECT
         c.id, c.name, c.phone_number,
         COUNT(t.id)                  AS deposit_count,
         COALESCE(SUM(t.amount), 0)   AS total_deposited
       FROM transactions t
       JOIN accounts a ON t.account_id = a.id
       JOIN customers c ON a.customer_id = c.id
       WHERE t.company_id = $1
         AND t.type = 'deposit'
         AND t.is_deleted = false
         AND t.transaction_date BETWEEN $2 AND $3
       GROUP BY c.id, c.name, c.phone_number
       ORDER BY total_deposited DESC
       LIMIT 10`,
      loanVals
    );

    // ── Top overdue borrowers ──
    const overdueLoans = await pool.query(
      `SELECT
         l.id, l.group_name,
         c.name AS customer_name, c.phone_number,
         l.outstandingbalance, l.days_overdue,
         l.nextpaymentdate, l.loantype, l.disbursedamount
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.company_id = $1
         AND l.status = 'overdue'
         AND l.loantype != 'group_member'
       ORDER BY l.outstandingbalance DESC
       LIMIT 10`,
      [companyId]
    );

    // ── Account balance totals by type ──
    const accountBalances = await pool.query(
      `SELECT
         LOWER(a.account_type) AS account_type,
         COUNT(*)               AS account_count,
         COALESCE(SUM(a.balance), 0) AS total_balance
       FROM accounts a
       JOIN customers c ON a.customer_id = c.id
       WHERE c.company_id = $1 AND c.is_deleted = false
       GROUP BY LOWER(a.account_type)
       ORDER BY total_balance DESC`,
      [companyId]
    );

    // ── New customers this month ──
    const newCustomers = await pool.query(
      `SELECT
         COUNT(*) AS count
       FROM customers
       WHERE company_id = $1
         AND date_of_registration BETWEEN $2 AND $3
         AND is_deleted = false`,
      loanVals
    );

    // ── Commission totals this month ──
    const commissions = await pool.query(
      `SELECT
         COALESCE(SUM(amount), 0) AS total,
         COUNT(*)                 AS count
       FROM commissions
       WHERE company_id = $1
         AND created_at BETWEEN $2 AND $3`,
      loanVals
    );

    const s  = summary.rows[0];
    const ls = loanSnapshot.rows[0];
    const rs = repaymentSummary.rows[0];
    const nl = newLoansMonth.rows[0];

    return res.status(200).json({
      status: "success",
      reportType: "monthly",
      period: label,
      dateRange: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      data: {
        summary: {
          total_transactions:   parseInt(s.total_transactions),
          deposit_count:        parseInt(s.deposit_count),
          total_deposits:       fmt2(s.total_deposits),
          avg_deposit:          fmt2(s.avg_deposit),
          withdrawal_count:     parseInt(s.withdrawal_count),
          total_withdrawals:    fmt2(s.total_withdrawals),
          net_cash_flow:        fmt2(s.total_deposits - s.total_withdrawals),
          new_customers:        parseInt(newCustomers.rows[0].count),
          total_commissions:    fmt2(commissions.rows[0].total),
        },
        loans: {
          total_in_portfolio:   parseInt(ls.total_loans),
          total_loan_amount:    fmt2(ls.total_loan_amount),
          total_disbursed:      fmt2(ls.total_disbursed),
          total_outstanding:    fmt2(ls.total_outstanding),
          overdue_count:        parseInt(ls.overdue_count),
          overdue_amount:       fmt2(ls.overdue_amount),
          pending_applications: parseInt(ls.pending_applications),
          new_this_period:      parseInt(nl.new_applications),
          amount_applied:       fmt2(nl.amount_applied),
          approved_this_period: parseInt(nl.approved),
          rejected_this_period: parseInt(nl.rejected),
          repayments_collected: fmt2(rs.total_collected),
          repayment_count:      parseInt(rs.count),
        },
        weeklyBreakdown,
        topDepositors:    topDepositors.rows,
        overdueLoans:     overdueLoans.rows,
        accountBalances:  accountBalances.rows,
      },
    });
  } catch (err) {
    console.error("getMonthlyReport error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to generate monthly report", detail: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 4.  QUARTERLY REPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/accountant/:companyId/quarterly
 *
 * Query: ?period=this_quarter|last_quarter|custom  &startDate=&endDate=
 */
export const getQuarterlyReport = async (req, res) => {
  const { companyId } = req.params;
  const period = req.query.period || "this_quarter";

  const { startDate, endDate, label } = resolvePeriod(
    period,
    req.query.startDate,
    req.query.endDate
  );

  const baseVals = [companyId, startDate, endDate];
  const { clause: txClause, values: txVals } = buildTxDateFilter(startDate, endDate, 2);
  const txWhere = txClause ? `AND ${txClause}` : "";

  try {
    // ── Transaction summary ──
    const summary = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='deposit'    AND is_deleted=false ${txWhere}), 0) AS total_deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false ${txWhere}
         ), 0) AS total_withdrawals,
         COUNT(*) FILTER (WHERE is_deleted=false ${txWhere})  AS total_transactions
       FROM transactions t
       WHERE t.company_id = $1`,
      [companyId, ...txVals]
    );

    // ── Monthly breakdown within the quarter ──
    const monthlyBreakdown = await pool.query(
      `SELECT
         TO_CHAR(transaction_date, 'Mon YYYY') AS month,
         MIN(transaction_date)                 AS sort_date,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit'    AND is_deleted=false), 0) AS deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false
         ), 0)                                                                          AS withdrawals,
         COUNT(*) FILTER (WHERE is_deleted=false)                                      AS tx_count
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       GROUP BY TO_CHAR(transaction_date, 'Mon YYYY')
       ORDER BY sort_date ASC`,
      baseVals
    );

    // ── Loan origination & performance ──
    const loanOrigination = await pool.query(
      `SELECT
         TO_CHAR(l.created_at, 'Mon YYYY')     AS month,
         MIN(l.created_at)                      AS sort_date,
         COUNT(*) FILTER (WHERE loantype != 'group_member') AS loan_count,
         COALESCE(SUM(loanamount) FILTER (WHERE loantype != 'group_member'), 0) AS amount
       FROM loans l
       WHERE l.company_id = $1
         AND l.created_at BETWEEN $2 AND $3
       GROUP BY TO_CHAR(l.created_at, 'Mon YYYY')
       ORDER BY sort_date ASC`,
      baseVals
    );

    // ── Loan repayments per month ──
    const repaymentsByMonth = await pool.query(
      `SELECT
         TO_CHAR(lr.payment_date, 'Mon YYYY') AS month,
         MIN(lr.payment_date)                  AS sort_date,
         COUNT(*)                              AS count,
         COALESCE(SUM(lr.amount), 0)           AS total
       FROM loan_repayments lr
       JOIN loans l ON lr.loan_id = l.id
       WHERE l.company_id = $1
         AND lr.payment_date BETWEEN $2 AND $3
       GROUP BY TO_CHAR(lr.payment_date, 'Mon YYYY')
       ORDER BY sort_date ASC`,
      baseVals
    );

    // ── Portfolio at risk (PAR) ──
    const par = await pool.query(
      `SELECT
         COALESCE(SUM(outstandingbalance), 0) AS total_outstanding,
         COALESCE(SUM(outstandingbalance) FILTER (WHERE status='overdue'), 0) AS overdue_outstanding,
         COUNT(*) FILTER (WHERE status='overdue') AS overdue_count,
         COUNT(*) FILTER (WHERE status='defaulted') AS defaulted_count
       FROM loans
       WHERE company_id = $1
         AND loantype != 'group_member'`,
      [companyId]
    );

    // ── New vs churned customers ──
    const customerGrowth = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE date_of_registration BETWEEN $2 AND $3) AS new_customers,
         COUNT(*) FILTER (WHERE status = 'Active')    AS active_customers,
         COUNT(*) FILTER (WHERE status != 'Active')   AS inactive_customers
       FROM customers
       WHERE company_id = $1 AND is_deleted = false`,
      baseVals
    );

    // ── Top loan types ──
    const loanTypeBreakdown = await pool.query(
      `SELECT
         loantype,
         COUNT(*)                               AS count,
         COALESCE(SUM(loanamount), 0)           AS total_amount,
         COALESCE(SUM(outstandingbalance), 0)   AS outstanding
       FROM loans
       WHERE company_id = $1 AND loantype != 'group_member'
       GROUP BY loantype
       ORDER BY total_amount DESC`,
      [companyId]
    );

    // ── Commissions for the quarter ──
    const commissions = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM commissions
       WHERE company_id = $1 AND created_at BETWEEN $2 AND $3`,
      baseVals
    );

    const s   = summary.rows[0];
    const p   = par.rows[0];
    const cg  = customerGrowth.rows[0];
    const parRate = p.total_outstanding > 0
      ? fmt2((p.overdue_outstanding / p.total_outstanding) * 100)
      : 0;

    return res.status(200).json({
      status: "success",
      reportType: "quarterly",
      period: label,
      dateRange: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      data: {
        summary: {
          total_deposits:      fmt2(s.total_deposits),
          total_withdrawals:   fmt2(s.total_withdrawals),
          net_flow:            fmt2(s.total_deposits - s.total_withdrawals),
          total_transactions:  parseInt(s.total_transactions),
          total_commissions:   fmt2(commissions.rows[0].total),
        },
        portfolio: {
          total_outstanding:   fmt2(p.total_outstanding),
          overdue_outstanding: fmt2(p.overdue_outstanding),
          overdue_count:       parseInt(p.overdue_count),
          defaulted_count:     parseInt(p.defaulted_count),
          par_rate:            parRate,
        },
        customers: {
          new_this_period: parseInt(cg.new_customers),
          active:          parseInt(cg.active_customers),
          inactive:        parseInt(cg.inactive_customers),
        },
        monthlyBreakdown:   monthlyBreakdown.rows,
        loanOrigination:    loanOrigination.rows,
        repaymentsByMonth:  repaymentsByMonth.rows,
        loanTypeBreakdown:  loanTypeBreakdown.rows,
      },
    });
  } catch (err) {
    console.error("getQuarterlyReport error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to generate quarterly report", detail: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 5.  ANNUAL REPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/accountant/:companyId/annual
 *
 * Query: ?period=this_year|last_year|custom  &startDate=&endDate=
 */
export const getAnnualReport = async (req, res) => {
  const { companyId } = req.params;
  const period = req.query.period || "this_year";

  const { startDate, endDate, label } = resolvePeriod(
    period,
    req.query.startDate,
    req.query.endDate
  );

  const baseVals = [companyId, startDate, endDate];
  const { clause: txClause, values: txVals } = buildTxDateFilter(startDate, endDate, 2);
  const txWhere = txClause ? `AND ${txClause}` : "";

  try {
    // ── Annual transaction totals ──
    const summary = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='deposit'    AND is_deleted=false ${txWhere}), 0)  AS total_deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false ${txWhere}
         ), 0)                                                                                       AS total_withdrawals,
         COUNT(*) FILTER (WHERE type='deposit'    AND is_deleted=false ${txWhere})                  AS deposit_count,
         COUNT(*) FILTER (WHERE type='withdrawal' AND is_deleted=false ${txWhere})                  AS withdrawal_count,
         COUNT(*) FILTER (WHERE is_deleted=false ${txWhere})                                        AS total_transactions,
         COALESCE(AVG(amount) FILTER (WHERE type='deposit' AND is_deleted=false ${txWhere}), 0)     AS avg_deposit
       FROM transactions t
       WHERE t.company_id = $1`,
      [companyId, ...txVals]
    );

    // ── Month-by-month breakdown (12 rows) ──
    const monthly = await pool.query(
      `SELECT
         TO_CHAR(transaction_date, 'Mon YYYY')  AS month,
         EXTRACT(MONTH FROM transaction_date)::int AS month_num,
         MIN(transaction_date)                  AS sort_date,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit'    AND is_deleted=false), 0) AS deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false
         ), 0)                                                                          AS withdrawals,
         COUNT(*) FILTER (WHERE is_deleted=false)                                      AS tx_count
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       GROUP BY TO_CHAR(transaction_date, 'Mon YYYY'), month_num
       ORDER BY sort_date ASC`,
      baseVals
    );

    // ── Annual loan stats ──
    const loanStats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE loantype != 'group_member')                                     AS total_loans,
         COUNT(*) FILTER (WHERE loantype = 'group')                                             AS group_loans,
         COUNT(*) FILTER (WHERE loantype = 'individual')                                        AS individual_loans,
         COUNT(*) FILTER (WHERE loantype = 'p2p')                                               AS p2p_loans,
         COALESCE(SUM(loanamount) FILTER (WHERE loantype != 'group_member'), 0)                 AS total_originated,
         COALESCE(SUM(disbursedamount) FILTER (WHERE loantype != 'group_member'), 0)            AS total_disbursed,
         COALESCE(SUM(amountpaid) FILTER (WHERE loantype != 'group_member'), 0)                 AS total_collected,
         COALESCE(SUM(outstandingbalance) FILTER (WHERE loantype != 'group_member'), 0)         AS total_outstanding,
         COUNT(*) FILTER (WHERE status='completed' AND loantype != 'group_member')              AS completed_count,
         COUNT(*) FILTER (WHERE status='defaulted' AND loantype != 'group_member')              AS defaulted_count,
         COUNT(*) FILTER (WHERE status='overdue'   AND loantype != 'group_member')              AS overdue_count
       FROM loans
       WHERE company_id = $1`,
      [companyId]
    );

    // ── Quarterly comparison ──
    const quarterly = await pool.query(
      `SELECT
         'Q' || EXTRACT(QUARTER FROM transaction_date)::text AS quarter,
         MIN(transaction_date)                              AS sort_date,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND is_deleted=false), 0)  AS deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false
         ), 0)                                                                         AS withdrawals
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       GROUP BY quarter
       ORDER BY sort_date ASC`,
      baseVals
    );

    // ── Loan repayments month-by-month ──
    const repaymentMonthly = await pool.query(
      `SELECT
         TO_CHAR(lr.payment_date, 'Mon YYYY') AS month,
         MIN(lr.payment_date)                  AS sort_date,
         COUNT(*)                              AS count,
         COALESCE(SUM(lr.amount), 0)           AS total
       FROM loan_repayments lr
       JOIN loans l ON lr.loan_id = l.id
       WHERE l.company_id = $1
         AND lr.payment_date BETWEEN $2 AND $3
       GROUP BY TO_CHAR(lr.payment_date, 'Mon YYYY')
       ORDER BY sort_date ASC`,
      baseVals
    );

    // ── Customer growth by month ──
    const customerGrowth = await pool.query(
      `SELECT
         TO_CHAR(date_of_registration, 'Mon YYYY') AS month,
         MIN(date_of_registration)                  AS sort_date,
         COUNT(*)                                   AS new_customers
       FROM customers
       WHERE company_id = $1
         AND date_of_registration BETWEEN $2 AND $3
         AND is_deleted = false
       GROUP BY TO_CHAR(date_of_registration, 'Mon YYYY')
       ORDER BY sort_date ASC`,
      baseVals
    );

    // ── Commissions by month ──
    const commissionMonthly = await pool.query(
      `SELECT
         TO_CHAR(created_at, 'Mon YYYY') AS month,
         MIN(created_at)                  AS sort_date,
         COUNT(*)                         AS count,
         COALESCE(SUM(amount), 0)         AS total
       FROM commissions
       WHERE company_id = $1
         AND created_at BETWEEN $2 AND $3
       GROUP BY TO_CHAR(created_at, 'Mon YYYY')
       ORDER BY sort_date ASC`,
      baseVals
    );

    // ── Year-over-year: fetch previous year for comparison ──
    const prevYearStart = new Date(startDate); prevYearStart.setFullYear(prevYearStart.getFullYear() - 1);
    const prevYearEnd   = new Date(endDate);   prevYearEnd.setFullYear(prevYearEnd.getFullYear() - 1);
    const { clause: prevClause, values: prevVals } = buildTxDateFilter(
      prevYearStart.toISOString(), prevYearEnd.toISOString(), 2
    );
    const prevWhere = prevClause ? `AND ${prevClause}` : "";

    const prevYear = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='deposit'    AND is_deleted=false ${prevWhere}), 0) AS total_deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false ${prevWhere}
         ), 0) AS total_withdrawals
       FROM transactions t
       WHERE t.company_id = $1`,
      [companyId, ...prevVals]
    );

    const s  = summary.rows[0];
    const ls = loanStats.rows[0];
    const py = prevYear.rows[0];

    const yoyDepositChange = py.total_deposits > 0
      ? fmt2(((s.total_deposits - py.total_deposits) / py.total_deposits) * 100)
      : null;

    const loanRepaymentRate = ls.total_originated > 0
      ? fmt2((ls.total_collected / ls.total_originated) * 100)
      : 0;

    const totalCommissions = commissionMonthly.rows.reduce((sum, r) => sum + parseFloat(r.total || 0), 0);

    return res.status(200).json({
      status: "success",
      reportType: "annual",
      period: label,
      dateRange: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      data: {
        summary: {
          total_deposits:       fmt2(s.total_deposits),
          total_withdrawals:    fmt2(s.total_withdrawals),
          net_cash_flow:        fmt2(s.total_deposits - s.total_withdrawals),
          total_transactions:   parseInt(s.total_transactions),
          deposit_count:        parseInt(s.deposit_count),
          withdrawal_count:     parseInt(s.withdrawal_count),
          avg_deposit:          fmt2(s.avg_deposit),
          total_commissions:    fmt2(totalCommissions),
        },
        yearOverYear: {
          prev_deposits:         fmt2(py.total_deposits),
          prev_withdrawals:      fmt2(py.total_withdrawals),
          deposit_change_pct:    yoyDepositChange,
        },
        loans: {
          total_loans:           parseInt(ls.total_loans),
          group_loans:           parseInt(ls.group_loans),
          individual_loans:      parseInt(ls.individual_loans),
          p2p_loans:             parseInt(ls.p2p_loans),
          total_originated:      fmt2(ls.total_originated),
          total_disbursed:       fmt2(ls.total_disbursed),
          total_collected:       fmt2(ls.total_collected),
          total_outstanding:     fmt2(ls.total_outstanding),
          completed_loans:       parseInt(ls.completed_count),
          defaulted_loans:       parseInt(ls.defaulted_count),
          overdue_loans:         parseInt(ls.overdue_count),
          repayment_rate_pct:    loanRepaymentRate,
        },
        monthlyBreakdown:     monthly.rows,
        quarterlyBreakdown:   quarterly.rows,
        loanRepayments:       repaymentMonthly.rows,
        customerGrowth:       customerGrowth.rows,
        commissionsByMonth:   commissionMonthly.rows,
      },
    });
  } catch (err) {
    console.error("getAnnualReport error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to generate annual report", detail: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 6.  LOAN PORTFOLIO REPORT  (accountant deep-dive)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/accountant/:companyId/loans
 *
 * Query: ?period=this_month|last_month|this_year|...  &startDate=&endDate=
 *        &loanType=individual|group|p2p|all
 *        &status=active|overdue|completed|defaulted|all
 */
export const getLoanPortfolioReport = async (req, res) => {
  const { companyId } = req.params;
  const period    = req.query.period || "this_month";
  const loanType  = req.query.loanType || "all";
  const statusFilter = req.query.status || "all";

  const { startDate, endDate, label } = resolvePeriod(
    period,
    req.query.startDate,
    req.query.endDate
  );

  // Build loan WHERE conditions
  const conditions = ["l.company_id = $1", "l.loantype != 'group_member'"];
  const vals = [companyId];
  let idx = 2;

  if (loanType !== "all") {
    conditions.push(`l.loantype = $${idx++}`);
    vals.push(loanType);
  }
  if (statusFilter !== "all") {
    conditions.push(`l.status = $${idx++}`);
    vals.push(statusFilter);
  }

  const whereClause = conditions.join(" AND ");

  try {
    // ── Full portfolio snapshot ──
    const snapshot = await pool.query(
      `SELECT
         COUNT(*)                                                                        AS total_loans,
         COALESCE(SUM(loanamount), 0)                                                   AS total_originated,
         COALESCE(SUM(disbursedamount), 0)                                              AS total_disbursed,
         COALESCE(SUM(amountpaid), 0)                                                   AS total_collected,
         COALESCE(SUM(outstandingbalance), 0)                                           AS total_outstanding,
         COALESCE(AVG(interestrateloan), 0)                                             AS avg_interest_rate,
         COALESCE(AVG(loanterm), 0)                                                     AS avg_loan_term,
         COALESCE(AVG(loanamount), 0)                                                   AS avg_loan_amount,
         COUNT(*) FILTER (WHERE status='active'    OR status='approved')                AS active_count,
         COUNT(*) FILTER (WHERE status='pending')                                       AS pending_count,
         COUNT(*) FILTER (WHERE status='overdue')                                       AS overdue_count,
         COUNT(*) FILTER (WHERE status='completed')                                     AS completed_count,
         COUNT(*) FILTER (WHERE status='defaulted')                                     AS defaulted_count,
         COUNT(*) FILTER (WHERE status='rejected')                                      AS rejected_count
       FROM loans l
       WHERE ${whereClause}`,
      vals
    );

    // ── Loans by type breakdown ──
    const byType = await pool.query(
      `SELECT
         loantype,
         COUNT(*)                             AS count,
         COALESCE(SUM(loanamount), 0)         AS total_amount,
         COALESCE(SUM(outstandingbalance), 0) AS outstanding,
         COALESCE(SUM(amountpaid), 0)         AS collected
       FROM loans
       WHERE company_id = $1 AND loantype != 'group_member'
       GROUP BY loantype`,
      [companyId]
    );

    // ── PAR (Portfolio at Risk) ageing buckets ──
    const parAgeing = await pool.query(
      `SELECT
         CASE
           WHEN days_overdue BETWEEN 1  AND 30  THEN '1–30 days'
           WHEN days_overdue BETWEEN 31 AND 60  THEN '31–60 days'
           WHEN days_overdue BETWEEN 61 AND 90  THEN '61–90 days'
           WHEN days_overdue > 90               THEN '90+ days'
           ELSE 'Current'
         END                                         AS bucket,
         COUNT(*)                                     AS loan_count,
         COALESCE(SUM(outstandingbalance), 0)         AS outstanding
       FROM loans l
       WHERE l.company_id = $1 AND l.loantype != 'group_member'
       GROUP BY bucket
       ORDER BY outstanding DESC`,
      [companyId]
    );

    // ── Loans created in the period ──
    const newInPeriod = await pool.query(
      `SELECT
         l.id, l.loantype, l.group_name, l.loanamount, l.interestrateloan,
         l.loanterm, l.status, l.created_at, l.disbursementdate,
         c.name AS customer_name, c.phone_number AS customer_phone
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.company_id = $1
         AND l.loantype != 'group_member'
         AND l.created_at BETWEEN $2 AND $3
       ORDER BY l.created_at DESC`,
      [companyId, startDate, endDate]
    );

    // ── Repayments received in the period ──
    const repayments = await pool.query(
      `SELECT
         lr.id, lr.loan_id, lr.amount, lr.payment_date, lr.note, lr.balance_after,
         l.loantype, l.group_name,
         c.name AS customer_name
       FROM loan_repayments lr
       JOIN loans l ON lr.loan_id = l.id
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.company_id = $1
         AND lr.payment_date BETWEEN $2 AND $3
       ORDER BY lr.payment_date DESC`,
      [companyId, startDate, endDate]
    );

    // ── Top borrowers by outstanding balance ──
    const topBorrowers = await pool.query(
      `SELECT
         l.id, l.loantype, l.group_name,
         c.name AS customer_name, c.phone_number,
         l.disbursedamount, l.outstandingbalance, l.amountpaid, l.status, l.days_overdue
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE ${whereClause}
       ORDER BY l.outstandingbalance DESC
       LIMIT 20`,
      vals
    );

    // ── Interest income earned ──
    const interestIncome = await pool.query(
      `SELECT
         COALESCE(SUM(totalpayable - loanamount) FILTER (
           WHERE status IN ('active','approved','completed')
         ), 0) AS projected_interest,
         COALESCE(SUM(amountpaid - loanamount)   FILTER (
           WHERE amountpaid > loanamount AND status = 'completed'
         ), 0) AS realised_interest
       FROM loans l
       WHERE ${whereClause}`,
      vals
    );

    const snap = snapshot.rows[0];
    const ii   = interestIncome.rows[0];
    const repayRate = snap.total_disbursed > 0
      ? fmt2((snap.total_collected / snap.total_disbursed) * 100)
      : 0;
    const parRate = snap.total_outstanding > 0
      ? fmt2(
          (parseFloat(parAgeing.rows.find(r => r.bucket !== 'Current')?.outstanding || 0) /
            snap.total_outstanding) * 100
        )
      : 0;

    return res.status(200).json({
      status: "success",
      reportType: "loan_portfolio",
      period: label,
      dateRange: { startDate, endDate },
      filters: { loanType, status: statusFilter },
      generatedAt: new Date().toISOString(),
      data: {
        snapshot: {
          total_loans:         parseInt(snap.total_loans),
          total_originated:    fmt2(snap.total_originated),
          total_disbursed:     fmt2(snap.total_disbursed),
          total_collected:     fmt2(snap.total_collected),
          total_outstanding:   fmt2(snap.total_outstanding),
          avg_interest_rate:   fmt2(snap.avg_interest_rate),
          avg_loan_term:       fmt2(snap.avg_loan_term),
          avg_loan_amount:     fmt2(snap.avg_loan_amount),
          repayment_rate_pct:  repayRate,
          par_rate_pct:        parRate,
          projected_interest:  fmt2(ii.projected_interest),
          realised_interest:   fmt2(ii.realised_interest),
          active_count:        parseInt(snap.active_count),
          pending_count:       parseInt(snap.pending_count),
          overdue_count:       parseInt(snap.overdue_count),
          completed_count:     parseInt(snap.completed_count),
          defaulted_count:     parseInt(snap.defaulted_count),
          rejected_count:      parseInt(snap.rejected_count),
        },
        byType:       byType.rows,
        parAgeing:    parAgeing.rows,
        newInPeriod:  newInPeriod.rows,
        repayments:   repayments.rows,
        topBorrowers: topBorrowers.rows,
      },
    });
  } catch (err) {
    console.error("getLoanPortfolioReport error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to generate loan portfolio report", detail: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 7.  CASH FLOW STATEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/accountant/:companyId/cashflow
 *
 * Query: ?period=this_month|last_month|this_year|...  &startDate=&endDate=
 *
 * Returns a structured cash-flow statement:
 *   Operating (deposits collected, withdrawals paid)
 *   Financing  (loans disbursed, repayments received)
 *   Net position
 */
export const getCashFlowReport = async (req, res) => {
  const { companyId } = req.params;
  const period = req.query.period || "this_month";

  const { startDate, endDate, label } = resolvePeriod(
    period,
    req.query.startDate,
    req.query.endDate
  );

  const baseVals = [companyId, startDate, endDate];

  try {
    // ── Operating activities ──
    const operating = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='deposit'    AND is_deleted=false), 0) AS cash_inflow_deposits,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false
         ), 0)                                                                           AS cash_outflow_withdrawals,
         COALESCE(SUM(amount) FILTER (WHERE type='fee'        AND is_deleted=false), 0) AS fees_collected
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3`,
      baseVals
    );

    // ── Financing activities ──
    const financing = await pool.query(
      `SELECT
         COALESCE(SUM(disbursedamount) FILTER (
           WHERE disbursementdate BETWEEN $2 AND $3 AND loantype != 'group_member'
         ), 0) AS cash_out_disbursements,
         (
           SELECT COALESCE(SUM(lr.amount), 0)
           FROM loan_repayments lr
           JOIN loans l ON lr.loan_id = l.id
           WHERE l.company_id = $1 AND lr.payment_date BETWEEN $2 AND $3
         )     AS cash_in_repayments,
         (
           SELECT COALESCE(SUM(amount), 0)
           FROM commissions
           WHERE company_id = $1 AND created_at BETWEEN $2 AND $3
         )     AS commission_income
       FROM loans
       WHERE company_id = $1`,
      baseVals
    );

    // ── Daily net cash flow ──
    const dailyFlow = await pool.query(
      `SELECT
         DATE(transaction_date)                                                       AS day,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit'    AND is_deleted=false), 0) AS inflow,
         COALESCE(SUM(amount) FILTER (
           WHERE type='withdrawal' AND (status='completed' OR status='approved') AND is_deleted=false
         ), 0)                                                                          AS outflow
       FROM transactions t
       WHERE t.company_id = $1
         AND t.transaction_date BETWEEN $2 AND $3
         AND t.is_deleted = false
       GROUP BY day
       ORDER BY day ASC`,
      baseVals
    );

    // ── Account total balances (end-of-period snapshot) ──
    const balanceSnapshot = await pool.query(
      `SELECT
         COALESCE(SUM(a.balance) FILTER (WHERE a.account_type NOT ILIKE '%loan%'), 0) AS total_savings_balance,
         COALESCE(SUM(l.outstandingbalance), 0)                                       AS total_loan_outstanding
       FROM customers c
       LEFT JOIN accounts a ON c.id = a.customer_id
       LEFT JOIN loans l ON l.customer_id = c.id AND l.loantype != 'group_member' AND l.status IN ('active','approved','overdue')
       WHERE c.company_id = $1 AND c.is_deleted = false`,
      [companyId]
    );

    const op = operating.rows[0];
    const fi = financing.rows[0];
    const bs = balanceSnapshot.rows[0];

    const operatingNet  = fmt2(op.cash_inflow_deposits + op.fees_collected - op.cash_outflow_withdrawals);
    const financingNet  = fmt2(fi.cash_in_repayments  + fi.commission_income - fi.cash_out_disbursements);
    const netPosition   = fmt2(operatingNet + financingNet);

    return res.status(200).json({
      status: "success",
      reportType: "cash_flow",
      period: label,
      dateRange: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      data: {
        operating: {
          cash_inflow_deposits:     fmt2(op.cash_inflow_deposits),
          cash_outflow_withdrawals: fmt2(op.cash_outflow_withdrawals),
          fees_collected:           fmt2(op.fees_collected),
          net_operating:            operatingNet,
        },
        financing: {
          cash_out_disbursements:   fmt2(fi.cash_out_disbursements),
          cash_in_repayments:       fmt2(fi.cash_in_repayments),
          commission_income:        fmt2(fi.commission_income),
          net_financing:            financingNet,
        },
        netPosition,
        balanceSnapshot: {
          total_savings_balance:    fmt2(bs.total_savings_balance),
          total_loan_outstanding:   fmt2(bs.total_loan_outstanding),
        },
        dailyCashFlow: dailyFlow.rows,
      },
    });
  } catch (err) {
    console.error("getCashFlowReport error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to generate cash flow report", detail: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 8.  UNIVERSAL DISPATCHER  (single endpoint for all report types)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/accountant/:companyId
 *
 * Query: ?type=daily|weekly|monthly|quarterly|annual|loan_portfolio|cash_flow
 *        + type-specific params (period, date, startDate, endDate, etc.)
 *
 * Convenience endpoint — routes to the correct handler internally.
 */
export const getAccountantReport = async (req, res) => {
  const type = req.query.type || "monthly";

  switch (type) {
    case "daily":          return getDailyReport(req, res);
    case "weekly":         return getWeeklyReport(req, res);
    case "monthly":        return getMonthlyReport(req, res);
    case "quarterly":      return getQuarterlyReport(req, res);
    case "annual":         return getAnnualReport(req, res);
    case "loan_portfolio": return getLoanPortfolioReport(req, res);
    case "cash_flow":      return getCashFlowReport(req, res);
    default:
      return res.status(400).json({
        status: "fail",
        message: `Unknown report type '${type}'. Valid types: daily, weekly, monthly, quarterly, annual, loan_portfolio, cash_flow`,
      });
  }
};
