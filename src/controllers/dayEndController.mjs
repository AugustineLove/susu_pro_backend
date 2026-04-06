/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DAY-END CONTROLLER  —  Susu Microfinance Platform
 *  Handles all end-of-day reconciliation, summaries, and closure activities
 *  Roles covered: CEO, Manager, Accountant, Sales Manager, HR, IT,
 *                 Data Entry, Teller, Loan Officer
 * ═══════════════════════════════════════════════════════════════════════════
 */

import pool from "../db.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const todayRange = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
};

const targetDateRange = (dateStr) => {
  const d = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { 
    start: start.toISOString(), 
    end: end.toISOString(), 
    label: d.toISOString().split("T")[0] 
  };
};

/**
 * MASTER DAY-END SUMMARY
 * GET /api/day-end/:companyId/summary?date=YYYY-MM-DD
 */
export const getDayEndSummary = async (req, res) => {
  const { companyId } = req.params;
  const { date } = req.query;
  const { start, end, label } = targetDateRange(date);

  if (!companyId) {
    return res.status(400).json({ status: "fail", message: "companyId is required" });
  }

  try {
    const queries = [
      // ── 1a. Transaction totals ──
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE type = 'deposit' AND is_deleted = false)::int AS deposit_count,
           COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND is_deleted = false), 0) AS deposit_total,
           COUNT(*) FILTER (WHERE type = 'withdrawal' AND status IN ('approved','completed') AND is_deleted = false)::int AS withdrawal_count,
           COALESCE(SUM(amount) FILTER (WHERE type = 'withdrawal' AND status IN ('approved','completed') AND is_deleted = false), 0) AS withdrawal_total,
           COUNT(*) FILTER (WHERE type = 'transfer_out' AND is_deleted = false)::int AS transfer_count,
           COALESCE(SUM(amount) FILTER (WHERE type = 'transfer_out' AND is_deleted = false), 0) AS transfer_total,
           COUNT(*) FILTER (WHERE status = 'reversed' AND is_deleted = false)::int AS reversal_count,
           COALESCE(SUM(amount) FILTER (WHERE status = 'reversed' AND is_deleted = false), 0) AS reversal_total,
           COUNT(*) FILTER (WHERE type = 'withdrawal' AND status = 'pending' AND is_deleted = false)::int AS pending_withdrawal_count,
           COUNT(*) FILTER (WHERE is_deleted = false)::int AS total_transactions,
           COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND is_deleted = false), 0)
             - COALESCE(SUM(amount) FILTER (WHERE type = 'withdrawal' AND status IN ('approved','completed') AND is_deleted = false), 0) AS net_flow
         FROM transactions
         WHERE company_id = $1 AND transaction_date BETWEEN $2 AND $3`,
        [companyId, start, end]
      ),

      // ── 1b. Float / budget summary ──
      pool.query(
        `SELECT
           COUNT(*)::int AS teller_count,
           COALESCE(SUM(b.allocated), 0) AS total_allocated,
           COALESCE(SUM(b.spent), 0) AS total_spent,
           COALESCE(SUM(b.allocated - b.spent), 0) AS total_remaining,
           COUNT(*) FILTER (WHERE b.status = 'Active')::int AS active_floats,
           COUNT(*) FILTER (WHERE b.status = 'Closed')::int AS closed_floats,
           JSON_AGG(JSON_BUILD_OBJECT(
             'budget_id', b.id,
             'teller_id', b.teller_id,
             'teller_name', s.full_name,
             'allocated', b.allocated,
             'spent', b.spent,
             'remaining', b.allocated - b.spent,
             'status', b.status
           ) ORDER BY b.allocated DESC) AS teller_floats
         FROM budgets b
         LEFT JOIN staff s ON b.teller_id = s.id
         WHERE b.company_id = $1 AND b.date = $2`,
        [companyId, label]
      ),

      // ── 1c. Loan activity (Fixed ambiguity) ──
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending' AND created_at BETWEEN $2 AND $3)::int AS new_applications,
           COUNT(*) FILTER (WHERE status = 'active' AND approved_at BETWEEN $2 AND $3)::int AS approved_today,
           COUNT(*) FILTER (WHERE status = 'rejected' AND updated_at BETWEEN $2 AND $3)::int AS rejected_today,
           COUNT(*) FILTER (WHERE status = 'completed' AND updated_at BETWEEN $2 AND $3)::int AS completed_today,
           COALESCE(SUM(loanamount) FILTER (WHERE approved_at BETWEEN $2 AND $3), 0) AS disbursed_today,
           COUNT(*) FILTER (WHERE days_overdue > 0 AND status = 'active')::int AS total_overdue
         FROM loans
         WHERE company_id = $1 AND loantype != 'group_member'`,
        [companyId, start, end]
      ),

      // ── 1d. Commissions ──
      pool.query(
        `SELECT
           COUNT(*)::int AS count,
           COALESCE(SUM(amount), 0) AS total_earned,
           COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid_amount,
           COALESCE(SUM(amount) FILTER (WHERE status = 'reversed'), 0) AS reversed_amount
         FROM commissions
         WHERE company_id = $1 AND created_at BETWEEN $2 AND $3`,
        [companyId, start, end]
      ),

      // ── 1e. Revenue & Expenses ──
      pool.query(
        `SELECT 
          (SELECT COALESCE(SUM(amount), 0) FROM revenue WHERE company_id = $1 AND payment_date BETWEEN $2 AND $3) AS revenue_today,
          (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE company_id = $1 AND expense_date BETWEEN $2 AND $3) AS expenses_today,
          (SELECT COUNT(*)::int FROM revenue WHERE company_id = $1 AND payment_date BETWEEN $2 AND $3) AS revenue_entries,
          (SELECT COUNT(*)::int FROM expenses WHERE company_id = $1 AND expense_date BETWEEN $2 AND $3) AS expense_entries`,
        [companyId, start, end]
      ),

      // ── 1f. New Customers ──
      pool.query(
        `SELECT
           COUNT(*)::int AS new_customers,
           COUNT(*) FILTER (WHERE c.status = 'Active')::int AS active_new,
           JSON_AGG(JSON_BUILD_OBJECT(
             'id', c.id, 'name', c.name, 'phone', c.phone_number,
             'registered_by', s.full_name, 'created_at', c.date_of_registration
           ) ORDER BY c.date_of_registration DESC) AS customers_list
         FROM customers c
         LEFT JOIN staff s ON c.registered_by = s.id
         WHERE c.company_id = $1 
           AND c.date_of_registration BETWEEN $2 AND $3
           AND c.is_deleted = false`,
        [companyId, start, end]
      ),

      // ── 1g. Staff Activity (Fixed ambiguous status/id) ──
      pool.query(
        `SELECT
           s.id, s.full_name AS name, s.role,
           COUNT(t.id) FILTER (WHERE t.type = 'deposit')::int AS deposits_recorded,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0) AS deposit_value,
           COUNT(t.id) FILTER (WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed'))::int AS withdrawals_processed,
           (SELECT COUNT(*)::int FROM customers WHERE registered_by = s.id AND date_of_registration BETWEEN $2 AND $3) AS customers_registered,
           MAX(t.transaction_date) AS last_activity
         FROM staff s
         LEFT JOIN transactions t ON (t.staff_id = s.id OR t.created_by = s.id) 
           AND t.transaction_date BETWEEN $2 AND $3 
           AND t.is_deleted = false
         WHERE s.company_id = $1
         GROUP BY s.id, s.full_name, s.role
         ORDER BY deposit_value DESC`,
        [companyId, start, end]
      ),

      // ── 1h. Pending Withdrawals ──
      pool.query(
        `SELECT t.id, t.amount, t.transaction_date, c.name AS customer_name, s.full_name AS requested_by
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         JOIN customers c ON a.customer_id = c.id
         LEFT JOIN staff s ON t.created_by = s.id
         WHERE t.company_id = $1 AND t.type = 'withdrawal' AND t.status = 'pending' AND t.is_deleted = false
         ORDER BY t.transaction_date ASC`,
        [companyId]
      ),

      // ── 1i. Overdue Loans ──
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE days_overdue BETWEEN 1 AND 7)::int AS overdue_1_7_days,
           COUNT(*) FILTER (WHERE days_overdue BETWEEN 8 AND 30)::int AS overdue_8_30_days,
           COUNT(*) FILTER (WHERE days_overdue > 30)::int AS overdue_30_plus_days,
           COALESCE(SUM(outstandingbalance), 0) AS total_overdue_balance
         FROM loans
         WHERE company_id = $1 AND days_overdue > 0 AND status = 'active' AND loantype != 'group_member'`,
        [companyId]
      ),

      // ── 1j. Loan Repayments ──
      pool.query(
        `SELECT COUNT(*)::int AS repayment_count, COALESCE(SUM(lr.amount), 0) AS repayment_total
         FROM loan_repayments lr
         JOIN loans l ON lr.loan_id = l.id
         WHERE l.company_id = $1 AND lr.payment_date BETWEEN $2 AND $3`,
        [companyId, start, end]
      )
    ];

    const results = await Promise.all(queries);

    // Destructure results
    const [tx, float, loans, comm, fin, cust, staff, pending, overdue, repay] = results.map(r => r.rows[0] || {});
    
    // Manual adjustment for the Pending/Staff lists which return arrays
    const pendingList = results[7].rows;
    const staffList = results[6].rows;

    const netCashPosition = 
      Number(fin.revenue_today || 0) + 
      Number(comm.paid_amount || 0) - 
      Number(fin.expenses_today || 0);

    return res.status(200).json({
      status: "success",
      report_date: label,
      data: {
        transactions: {
          total: tx.total_transactions,
          net_flow: Number(tx.net_flow),
          deposits: { count: tx.deposit_count, total: Number(tx.deposit_total) },
          withdrawals: { count: tx.withdrawal_count, total: Number(tx.withdrawal_total) },
          pending_count: tx.pending_withdrawal_count
        },
        float: { ...float, teller_floats: float.teller_floats || [] },
        loans: {
          ...loans,
          disbursed_today: Number(loans.disbursed_today),
          repayments: { count: repay.repayment_count, total: Number(repay.repayment_total) }
        },
        financials: {
          ...fin,
          net_cash_position: netCashPosition
        },
        customers: {
          new_today: cust.new_customers,
          list: cust.customers_list || []
        },
        staff_activity: staffList,
        alerts: {
          pending_withdrawals: pendingList,
          overdue_loans: overdue
        }
      }
    });

  } catch (error) {
    console.error("getDayEndSummary error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 2. TELLER DAY-END RECONCILIATION  (Teller / Manager view)
//    GET /api/day-end/:companyId/teller-reconciliation?date=YYYY-MM-DD&teller_id=
//
//  Per-teller: float opened, disbursed for withdrawals + expenses,
//  deposits received, cash balance expected vs actual float
// ─────────────────────────────────────────────────────────────────────────────

export const getTellerReconciliation = async (req, res) => {
  const { companyId } = req.params;
  const { date, teller_id } = req.query;
  const { start, end, label } = targetDateRange(date);

  if (!companyId) {
    return res.status(400).json({ status: "fail", message: "companyId is required" });
  }

  try {
    // Base budget query
    let budgetParams = [companyId, label];
    let budgetWhere = "b.company_id = $1 AND b.date = $2";

    if (teller_id) {
      budgetWhere += " AND b.teller_id = $3";
      budgetParams.push(teller_id);
    }

    const budgets = await pool.query(
      `SELECT
         b.id             AS budget_id,
         b.teller_id,
         s.full_name      AS teller_name,
         b.allocated,
         b.spent,
         b.allocated - b.spent AS remaining,
         b.status,
         -- top-ups during the day
         COALESCE(tu.total_topups, 0) AS total_topups,
         -- sales during the day
         COALESCE(sal.total_sales, 0)  AS total_sales
       FROM budgets b
       LEFT JOIN staff s ON b.teller_id = s.id
       LEFT JOIN (
         SELECT budget_id, SUM(amount) AS total_topups
         FROM budget_topups
         GROUP BY budget_id
       ) tu ON tu.budget_id = b.id
       LEFT JOIN (
         SELECT budget_id, SUM(amount) AS total_sales
         FROM budget_sales
         GROUP BY budget_id
       ) sal ON sal.budget_id = b.id
       WHERE ${budgetWhere}
       ORDER BY b.allocated DESC`,
      budgetParams
    );

    // Per-budget float movements breakdown
    const budgetIds = budgets.rows.map((b) => b.budget_id);

    let movements = [];
    if (budgetIds.length > 0) {
      const mvRes = await pool.query(
        `SELECT
           fm.budget_id,
           fm.source_type,
           fm.direction,
           COUNT(*)::int   AS count,
           COALESCE(SUM(fm.amount), 0) AS total
         FROM float_movements fm
         WHERE fm.budget_id = ANY($1::uuid[])
         GROUP BY fm.budget_id, fm.source_type, fm.direction`,
        [budgetIds]
      );
      movements = mvRes.rows;
    }

    // Transactions processed by each teller today
    let txParams = [companyId, start, end];
    let txWhere = "t.company_id = $1 AND t.transaction_date BETWEEN $2 AND $3 AND t.is_deleted = false";
    if (teller_id) {
      txWhere += " AND t.staff_id = $4";
      txParams.push(teller_id);
    }

    const tellerTx = await pool.query(
      `SELECT
         t.staff_id,
         s.full_name AS teller_name,
         COUNT(*) FILTER (WHERE t.type = 'deposit')::int            AS deposits_count,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0) AS deposits_total,
         COUNT(*) FILTER (WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed'))::int AS withdrawals_count,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed')), 0) AS withdrawals_total,
         COUNT(*) FILTER (WHERE t.status = 'reversed')::int         AS reversals_count,
         MAX(t.transaction_date)                                     AS last_transaction
       FROM transactions t
       LEFT JOIN staff s ON t.staff_id = s.id
       WHERE ${txWhere}
       GROUP BY t.staff_id, s.full_name
       ORDER BY deposits_total DESC`,
      txParams
    );

    // Attach movements to each budget row
    const enrichedBudgets = budgets.rows.map((b) => {
      const bMovements = movements.filter((m) => m.budget_id === b.budget_id);
      const withdrawalDebit = bMovements.find((m) => m.source_type === "withdrawal" && m.direction === "debit");
      const expenseDebit    = bMovements.find((m) => m.source_type === "expense"    && m.direction === "debit");
      const creditTotal     = bMovements.filter((m) => m.direction === "credit").reduce((s, m) => s + Number(m.total), 0);

      return {
        ...b,
        movements_breakdown: {
          withdrawal_debit: { count: withdrawalDebit?.count || 0, total: Number(withdrawalDebit?.total || 0) },
          expense_debit:    { count: expenseDebit?.count    || 0, total: Number(expenseDebit?.total    || 0) },
          total_credits:    creditTotal,
        },
        // Expected closing balance = allocated - spent
        expected_closing_balance: Number(b.allocated) - Number(b.spent),
      };
    });

    return res.status(200).json({
      status: "success",
      report_date: label,
      generated_at: new Date().toISOString(),
      data: {
        teller_floats:     enrichedBudgets,
        teller_transactions: tellerTx.rows,
        summary: {
          total_floats:    budgets.rows.length,
          total_allocated: budgets.rows.reduce((s, b) => s + Number(b.allocated), 0),
          total_spent:     budgets.rows.reduce((s, b) => s + Number(b.spent), 0),
          total_remaining: budgets.rows.reduce((s, b) => s + (Number(b.allocated) - Number(b.spent)), 0),
          open_floats:     budgets.rows.filter((b) => b.status === "Active").length,
          closed_floats:   budgets.rows.filter((b) => b.status === "Closed").length,
        },
      },
    });
  } catch (error) {
    console.error("getTellerReconciliation error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error", detail: error.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 3. LOAN OFFICER DAY-END REPORT
//    GET /api/day-end/:companyId/loan-report?date=YYYY-MM-DD&officer_id=
//
//  Covers: new applications, approvals, rejections, repayments,
//          overdue loans, P2P activity, group loan activity
// ─────────────────────────────────────────────────────────────────────────────

export const getLoanOfficerDayEnd = async (req, res) => {
  const { companyId } = req.params;
  const { date, officer_id } = req.query;
  const { start, end, label } = targetDateRange(date);

  try {
    const [
      loanSummary,
      newLoansToday,
      repaymentDetails,
      overdueDetail,
      loansByOfficer,
    ] = await Promise.all([

      // Overall loan summary for the day
      pool.query(
        `SELECT
           loantype,
           COUNT(*) FILTER (WHERE created_at BETWEEN $2 AND $3)::int     AS new_today,
           COUNT(*) FILTER (WHERE approved_at BETWEEN $2 AND $3)::int    AS approved_today,
           COUNT(*) FILTER (WHERE updated_at BETWEEN $2 AND $3 AND status = 'rejected')::int AS rejected_today,
           COALESCE(SUM(loanamount) FILTER (WHERE approved_at BETWEEN $2 AND $3), 0) AS disbursed_today,
           COUNT(*) FILTER (WHERE status = 'active')::int                AS active_loans,
           COALESCE(SUM(outstandingbalance) FILTER (WHERE status = 'active'), 0) AS total_outstanding
         FROM loans
         WHERE company_id = $1
           AND loantype != 'group_member'
         GROUP BY loantype`,
        [companyId, start, end]
      ),

      // Full list of loans created today
      pool.query(
        `SELECT
           l.id, l.loantype, l.loanamount, l.interestrateloan, l.loanterm,
           l.interestmethod, l.status, l.created_at, l.loan_category,
           l.purpose, l.guarantor,
           c.name AS customer_name, c.phone_number AS customer_phone,
           s.full_name AS created_by_name
         FROM loans l
         LEFT JOIN customers c ON l.customer_id = c.id
         LEFT JOIN staff s ON l.created_by = s.id
         WHERE l.company_id = $1
           AND l.created_at BETWEEN $2 AND $3
           AND l.loantype != 'group_member'
         ORDER BY l.created_at DESC`,
        [companyId, start, end]
      ),

      // Repayments made today
      pool.query(
        `SELECT
           lr.id AS repayment_id,
           lr.amount, lr.payment_date, lr.note, lr.balance_after,
           l.loantype, l.loanamount,
           c.name AS customer_name, c.phone_number,
           s.full_name AS recorded_by_name
         FROM loan_repayments lr
         JOIN loans l ON lr.loan_id = l.id
         LEFT JOIN customers c ON l.customer_id = c.id
         LEFT JOIN staff s ON lr.created_by = s.id
         WHERE l.company_id = $1
           AND lr.payment_date = $2
         ORDER BY lr.payment_date DESC`,
        [companyId, label]
      ),

      // Overdue loans detail
      pool.query(
        `SELECT
           l.id, l.loantype, l.loanamount, l.outstandingbalance,
           l.days_overdue, l.nextpaymentdate, l.monthlypayment,
           c.name AS customer_name, c.phone_number,
           s.full_name AS officer_name
         FROM loans l
         LEFT JOIN customers c ON l.customer_id = c.id
         LEFT JOIN staff s ON l.created_by = s.id
         WHERE l.company_id = $1
           AND l.days_overdue > 0
           AND l.status = 'active'
           AND l.loantype != 'group_member'
         ORDER BY l.days_overdue DESC
         LIMIT 50`,
        [companyId]
      ),

      // Loans per officer today
      pool.query(
        `SELECT
           s.id AS officer_id,
           s.full_name AS officer_name,
           COUNT(l.id) FILTER (WHERE l.created_at BETWEEN $2 AND $3)::int      AS new_applications,
           COUNT(l.id) FILTER (WHERE l.approved_at BETWEEN $2 AND $3)::int     AS approvals,
           COALESCE(SUM(l.loanamount) FILTER (WHERE l.approved_at BETWEEN $2 AND $3), 0) AS total_disbursed
         FROM staff s
         LEFT JOIN loans l ON l.created_by = s.id AND l.company_id = $1
         WHERE s.company_id = $1
           AND s.role ILIKE '%loan%'
         GROUP BY s.id, s.full_name
         ORDER BY total_disbursed DESC`,
        [companyId, start, end]
      ),
    ]);

    return res.status(200).json({
      status: "success",
      report_date: label,
      generated_at: new Date().toISOString(),
      data: {
        loan_summary_by_type: loanSummary.rows,
        new_loans_today:      newLoansToday.rows,
        repayments_today:     repaymentDetails.rows,
        overdue_loans:        overdueDetail.rows,
        officer_performance:  loansByOfficer.rows,
        totals: {
          new_applications: newLoansToday.rows.length,
          total_repayments: repaymentDetails.rows.reduce((s, r) => s + Number(r.amount), 0),
          repayment_count:  repaymentDetails.rows.length,
          total_overdue:    overdueDetail.rows.length,
        },
      },
    });
  } catch (error) {
    console.error("getLoanOfficerDayEnd error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error", detail: error.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 4. ACCOUNTANT / FINANCIAL DAY-END
//    GET /api/day-end/:companyId/financial-close?date=YYYY-MM-DD
//
//  Full P&L snapshot for the day, budget utilisation, commission payables,
//  asset changes, revenue vs expenses reconciliation
// ─────────────────────────────────────────────────────────────────────────────

export const getFinancialDayEnd = async (req, res) => {
  const { companyId } = req.params;
  const { date } = req.query;
  const { start, end, label } = targetDateRange(date);

  try {
    const [
      incomeStatement,
      expenseBreakdown,
      revenueBreakdown,
      budgetReconciliation,
      commissionPayables,
      assetsSnapshot,
      accountBalances,
    ] = await Promise.all([

      // Day P&L
      pool.query(
        `SELECT
           (SELECT COALESCE(SUM(amount), 0) FROM revenue  WHERE company_id = $1 AND payment_date BETWEEN $2 AND $3)  AS total_revenue,
           (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE company_id = $1 AND expense_date BETWEEN $2 AND $3)  AS total_expenses,
           (SELECT COALESCE(SUM(amount), 0) FROM commissions WHERE company_id = $1 AND status = 'paid' AND created_at BETWEEN $2 AND $3) AS total_commission_paid,
           (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE company_id = $1 AND type = 'withdrawal' AND is_deleted = false AND created_at BETWEEN $2 AND $3) AS total_withdrawals,
           (SELECT COALESCE(SUM(amount), 0) FROM loan_repayments lr JOIN loans l ON lr.loan_id = l.id WHERE l.company_id = $1 AND lr.payment_date = $4) AS loan_repayment_income`,
        [companyId, start, end, label]
      ),

      // Expenses by category
      pool.query(
        `SELECT
           category,
           COUNT(*)::int           AS count,
           COALESCE(SUM(amount), 0) AS total,
           JSON_AGG(JSON_BUILD_OBJECT('description', description, 'amount', amount, 'date', expense_date) ORDER BY expense_date DESC) AS items
         FROM expenses
         WHERE company_id = $1
           AND expense_date BETWEEN $2 AND $3
         GROUP BY category
         ORDER BY total DESC`,
        [companyId, start, end]
      ),

      // Revenue by category
      pool.query(
        `SELECT
           category,
           COUNT(*)::int           AS count,
           COALESCE(SUM(amount), 0) AS total,
           JSON_AGG(JSON_BUILD_OBJECT('description', description, 'amount', amount, 'source', source) ORDER BY payment_date DESC) AS items
         FROM revenue
         WHERE company_id = $1
           AND payment_date BETWEEN $2 AND $3
         GROUP BY category
         ORDER BY total DESC`,
        [companyId, start, end]
      ),

      // Budget reconciliation for the day
      pool.query(
        `SELECT
           b.id, b.teller_id, s.full_name AS teller_name,
           b.allocated, b.spent,
           b.allocated - b.spent AS variance,
           b.status,
           COALESCE(tu.topup_total, 0) AS topups,
           COALESCE(sal.sales_total, 0) AS cash_sold
         FROM budgets b
         LEFT JOIN staff s ON b.teller_id = s.id
         LEFT JOIN (
           SELECT budget_id, SUM(amount) AS topup_total FROM budget_topups GROUP BY budget_id
         ) tu ON tu.budget_id = b.id
         LEFT JOIN (
           SELECT budget_id, SUM(amount) AS sales_total FROM budget_sales GROUP BY budget_id
         ) sal ON sal.budget_id = b.id
         WHERE b.company_id = $1
           AND b.date = $2
         ORDER BY b.allocated DESC`,
        [companyId, label]
      ),

      // Outstanding commission payables
      pool.query(
        `SELECT
           c.id, c.amount, c.status, c.created_at,
           cu.name AS customer_name,
           s.full_name AS staff_name,
           t.amount AS transaction_amount, t.type AS transaction_type
         FROM commissions c
         LEFT JOIN customers cu ON cu.id = c.customer_id
         LEFT JOIN transactions t ON t.id = c.transaction_id
         LEFT JOIN staff s ON s.id = t.created_by
         WHERE c.company_id = $1
           AND c.status = 'pending'
         ORDER BY c.created_at DESC`,
        [companyId]
      ),

      // Total asset value snapshot
      pool.query(
        `SELECT
           category,
           COUNT(*)::int           AS count,
           COALESCE(SUM(value), 0) AS total_value
         FROM assets
         WHERE company_id = $1
         GROUP BY category
         ORDER BY total_value DESC`,
        [companyId]
      ),

      // Account type balances
      pool.query(
        `SELECT
           LOWER(a.account_type) AS account_type,
           COUNT(*)::int              AS account_count,
           COALESCE(SUM(a.balance), 0) AS total_balance
         FROM accounts a
         JOIN customers c ON a.customer_id = c.id
         WHERE c.company_id = $1 AND c.is_deleted = false
         GROUP BY LOWER(a.account_type)
         ORDER BY total_balance DESC`,
        [companyId]
      ),
    ]);

    const pl = incomeStatement.rows[0];
    const totalIncome   = Number(pl.total_revenue) + Number(pl.total_commission_paid) + Number(pl.loan_repayment_income);
    const totalWithdrawals = Number(pl.total_withdrawals);
    const totalExpenses = Number(pl.total_expenses);
    const netProfit     = totalIncome - totalExpenses;

    const budgetAllocated = budgetReconciliation.rows.reduce((s, b) => s + Number(b.allocated), 0);
    const budgetSpent     = budgetReconciliation.rows.reduce((s, b) => s + Number(b.spent), 0);

    return res.status(200).json({
      status: "success",
      report_date: label,
      generated_at: new Date().toISOString(),
      data: {
        income_statement: {
          total_revenue:          Number(pl.total_revenue),
          total_commission_paid:  Number(pl.total_commission_paid),
          loan_repayment_income:  Number(pl.loan_repayment_income),
          total_income:           totalIncome,
          total_withdrawals:      totalWithdrawals,
          total_expenses:         totalExpenses,
          net_profit:             netProfit,
          profit_margin_pct:      totalIncome > 0 ? ((netProfit / totalIncome) * 100).toFixed(2) : "0.00",
        },
        expense_breakdown:    expenseBreakdown.rows,
        revenue_breakdown:    revenueBreakdown.rows,
        budget_reconciliation: {
          records:         budgetReconciliation.rows,
          total_allocated: budgetAllocated,
          total_spent:     budgetSpent,
          total_variance:  budgetAllocated - budgetSpent,
          utilisation_pct: budgetAllocated > 0 ? ((budgetSpent / budgetAllocated) * 100).toFixed(2) : "0.00",
        },
        commission_payables: {
          count:  commissionPayables.rows.length,
          total:  commissionPayables.rows.reduce((s, c) => s + Number(c.amount), 0),
          items:  commissionPayables.rows,
        },
        assets_snapshot:  assetsSnapshot.rows,
        account_balances: accountBalances.rows,
        total_assets_value: assetsSnapshot.rows.reduce((s, a) => s + Number(a.total_value), 0),
      },
    });
  } catch (error) {
    console.error("getFinancialDayEnd error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error", detail: error.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 5. SALES MANAGER DAY-END
//    GET /api/day-end/:companyId/sales-report?date=YYYY-MM-DD
//
//  Focus: new customer acquisitions, deposits by agent,
//         target vs actual, top performers
// ─────────────────────────────────────────────────────────────────────────────

export const getSalesDayEnd = async (req, res) => {
  const { companyId } = req.params;
  const { date } = req.query;
  const { start, end, label } = targetDateRange(date);

  try {
    const [agentPerformance, newAccounts, depositTrend, topCustomers] = await Promise.all([

      // Agent (mobile banker / sales) performance today
      pool.query(
        `SELECT
           s.id AS agent_id,
           s.full_name AS agent_name,
           s.role,
           COUNT(DISTINCT cust.id) FILTER (WHERE cust.date_of_registration BETWEEN $2 AND $3)::int AS new_customers,
           COUNT(t.id)  FILTER (WHERE t.type = 'deposit' AND t.transaction_date BETWEEN $2 AND $3)::int AS deposit_count,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit' AND t.transaction_date BETWEEN $2 AND $3), 0) AS deposit_total,
           COUNT(t.id)  FILTER (WHERE t.type = 'deposit' AND t.transaction_date BETWEEN $2 AND $3 AND t.status = 'completed')::int AS completed_deposits,
           MAX(t.transaction_date) AS last_activity
         FROM staff s
         LEFT JOIN transactions t ON (t.created_by = s.id OR t.staff_id = s.id) AND t.company_id = $1 AND t.is_deleted = false
         LEFT JOIN customers cust ON cust.registered_by = s.id AND cust.company_id = $1
         WHERE s.company_id = $1
         GROUP BY s.id, s.full_name, s.role
         ORDER BY deposit_total DESC`,
        [companyId, start, end]
      ),

      // New accounts opened today
      pool.query(
        `SELECT
           a.account_type,
           COUNT(*)::int AS count,
           COALESCE(SUM(a.balance), 0) AS total_opening_balance
         FROM accounts a
         JOIN customers c ON a.customer_id = c.id
         WHERE c.company_id = $1
           AND a.created_at BETWEEN $2 AND $3
         GROUP BY a.account_type
         ORDER BY count DESC`,
        [companyId, start, end]
      ),

      // Hourly deposit trend for today
      pool.query(
        `SELECT
           EXTRACT(HOUR FROM t.transaction_date)::int AS hour,
           COUNT(*)::int           AS count,
           COALESCE(SUM(t.amount), 0) AS total
         FROM transactions t
         WHERE t.company_id = $1
           AND t.type = 'deposit'
           AND t.is_deleted = false
           AND t.transaction_date BETWEEN $2 AND $3
         GROUP BY hour
         ORDER BY hour ASC`,
        [companyId, start, end]
      ),

      // Top contributing customers today
      pool.query(
        `SELECT
           c.id, c.name, c.phone_number,
           COUNT(t.id)::int           AS deposit_count,
           COALESCE(SUM(t.amount), 0)  AS total_deposited
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
        [companyId, start, end]
      ),
    ]);

    const totalDepositsToday = agentPerformance.rows.reduce((s, a) => s + Number(a.deposit_total), 0);
    const totalNewCustomers  = agentPerformance.rows.reduce((s, a) => s + Number(a.new_customers), 0);

    return res.status(200).json({
      status: "success",
      report_date: label,
      generated_at: new Date().toISOString(),
      data: {
        agent_performance:  agentPerformance.rows,
        new_accounts_today: newAccounts.rows,
        hourly_trend:       depositTrend.rows,
        top_customers:      topCustomers.rows,
        summary: {
          total_deposits_today: totalDepositsToday,
          total_new_customers:  totalNewCustomers,
          active_agents:        agentPerformance.rows.filter((a) => a.deposit_count > 0).length,
          best_agent:           agentPerformance.rows[0]?.agent_name || "N/A",
          best_agent_total:     Number(agentPerformance.rows[0]?.deposit_total || 0),
        },
      },
    });
  } catch (error) {
    console.error("getSalesDayEnd error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error", detail: error.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 6. HR DAY-END  (attendance / staff activity summary)
//    GET /api/day-end/:companyId/hr-report?date=YYYY-MM-DD
//
//  Who was active, transaction count per staff, idle staff,
//  new hires, float assignments
// ─────────────────────────────────────────────────────────────────────────────

export const getHRDayEnd = async (req, res) => {
  const { companyId } = req.params;
  const { date } = req.query;
  const { start, end, label } = targetDateRange(date);

  try {
    const [staffSummary, newStaff, floatAssignment] = await Promise.all([

      // Full staff activity report for the day
      pool.query(
        `SELECT
           s.id,
           s.full_name,
           s.role,
           s.status,
           s.created_at AS hire_date,

           -- transaction activity
           COUNT(t.id) FILTER (WHERE t.transaction_date BETWEEN $2 AND $3)::int AS transactions_today,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit' AND t.transaction_date BETWEEN $2 AND $3), 0) AS deposits_today,

           -- customers registered
           COUNT(DISTINCT cust.id) FILTER (WHERE cust.date_of_registration BETWEEN $2 AND $3)::int AS customers_registered,

           -- loan actions
           COUNT(DISTINCT l.id) FILTER (WHERE l.created_at BETWEEN $2 AND $3)::int AS loans_created,

           GREATEST(
              MAX(t.transaction_date),
              MAX(cust.created_at),
              MAX(l.created_at),
              MAX(s.created_at)
          ) AS last_seen,

           CASE
             WHEN MAX(t.transaction_date) BETWEEN $2 AND $3 THEN 'Active'
             WHEN COUNT(t.id) FILTER (WHERE t.transaction_date BETWEEN $2 AND $3) = 0 THEN 'Idle'
             ELSE 'Active'
           END AS day_status

         FROM staff s
         LEFT JOIN transactions t ON (t.created_by = s.id OR t.staff_id = s.id) AND t.company_id = $1 AND t.is_deleted = false
         LEFT JOIN customers cust ON cust.registered_by = s.id AND cust.company_id = $1
         LEFT JOIN loans l ON l.created_by = s.id AND l.company_id = $1
         WHERE s.company_id = $1
         GROUP BY s.id, s.full_name, s.role, s.status, s.created_at
         ORDER BY transactions_today DESC`,
        [companyId, start, end]
      ),

      // New staff added today
      pool.query(
        `SELECT id, full_name, role, email, phone, created_at
         FROM staff
         WHERE company_id = $1
           AND created_at BETWEEN $2 AND $3
         ORDER BY created_at DESC`,
        [companyId, start, end]
      ),

      // Float assigned to staff today
      pool.query(
        `SELECT
           b.teller_id, s.full_name AS teller_name, s.role,
           b.allocated, b.spent, b.allocated - b.spent AS remaining, b.status
         FROM budgets b
         JOIN staff s ON b.teller_id = s.id
         WHERE b.company_id = $1
           AND b.date = $2`,
        [companyId, label]
      ),
    ]);

    const active = staffSummary.rows.filter((s) => s.day_status === "Active").length;
    const idle   = staffSummary.rows.filter((s) => s.day_status === "Idle").length;

    return res.status(200).json({
      status: "success",
      report_date: label,
      generated_at: new Date().toISOString(),
      data: {
        staff_activity:   staffSummary.rows,
        new_staff_today:  newStaff.rows,
        float_assignments: floatAssignment.rows,
        summary: {
          total_staff:  staffSummary.rows.length,
          active_today: active,
          idle_today:   idle,
          new_hires:    newStaff.rows.length,
        },
      },
    });
  } catch (error) {
    console.error("getHRDayEnd error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error", detail: error.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 7. CLOSE DAY (MANAGER / ACCOUNTANT action)
//    POST /api/day-end/:companyId/close
//    Body: { closed_by, closed_by_name, date? }
//
//  • Closes all active floats for the given date
//  • Saves a day_end_logs record (if table exists) or returns closure payload
//  • Marks pending withdrawals for escalation (does NOT auto-reject)
//  • Returns full closure receipt
// ─────────────────────────────────────────────────────────────────────────────

export const closeDay = async (req, res) => {
  const { companyId } = req.params;
  const { closed_by, closed_by_name, date } = req.body;
  const { label } = targetDateRange(date);

  if (!companyId || !closed_by) {
    return res.status(400).json({ status: "fail", message: "companyId and closed_by are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Fetch all open floats for the day
    const floatRes = await client.query(
      `SELECT id, teller_id, allocated, spent, allocated - spent AS remaining, status
       FROM budgets
       WHERE company_id = $1 AND date = $2
       FOR UPDATE`,
      [companyId, label]
    );

    const openFloats   = floatRes.rows.filter((b) => b.status === "Active");
    const closedFloats = floatRes.rows.filter((b) => b.status === "Closed");

    // 2. Close all active floats
    let closedCount = 0;
    if (openFloats.length > 0) {
      const ids = openFloats.map((b) => b.id);
      await client.query(
        `UPDATE budgets SET status = 'Closed' WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      closedCount = openFloats.length;
    }

    // 3. Snapshot financials for the day
    const { start, end } = targetDateRange(date);
    const snapRes = await client.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND is_deleted = false), 0)                          AS total_deposits,
         COALESCE(SUM(amount) FILTER (WHERE type = 'withdrawal' AND status IN ('approved','completed') AND is_deleted = false), 0) AS total_withdrawals,
         COUNT(*) FILTER (WHERE type = 'withdrawal' AND status = 'pending' AND is_deleted = false)::int           AS pending_withdrawals,
         COUNT(*) FILTER (WHERE is_deleted = false)::int                                                           AS total_transactions
       FROM transactions
       WHERE company_id = $1
         AND transaction_date BETWEEN $2 AND $3`,
      [companyId, start, end]
    );

    const loanSnapRes = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE approved_at BETWEEN $2 AND $3)::int AS loans_approved,
         COALESCE(SUM(loanamount) FILTER (WHERE approved_at BETWEEN $2 AND $3), 0) AS disbursed
       FROM loans
       WHERE company_id = $1 AND loantype != 'group_member'`,
      [companyId, start, end]
    );

    const commSnapRes = await client.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS commissions_paid
       FROM commissions
       WHERE company_id = $1
         AND created_at BETWEEN $2 AND $3`,
      [companyId, start, end]
    );

    const snap  = snapRes.rows[0];
    const lsnap = loanSnapRes.rows[0];
    const csnap = commSnapRes.rows[0];

    // 4. Try to log in day_end_logs (gracefully skip if table doesn't exist)
    let logId = null;
    try {
      const logRes = await client.query(
        `INSERT INTO day_end_logs (
           company_id, report_date, closed_by, closed_by_name,
           total_deposits, total_withdrawals, pending_withdrawals,
           total_transactions, loans_approved, disbursed_today,
           commissions_paid, floats_closed
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          companyId, label, closed_by, closed_by_name || null,
          snap.total_deposits, snap.total_withdrawals, snap.pending_withdrawals,
          snap.total_transactions, lsnap.loans_approved, lsnap.disbursed,
          csnap.commissions_paid, closedCount + closedFloats.length,
        ]
      );
      logId = logRes.rows[0]?.id;
    } catch (_) {
      // day_end_logs table may not exist yet — non-fatal
    }

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: `Day closed successfully for ${label}`,
      data: {
        report_date:         label,
        closed_by,
        closed_by_name:      closed_by_name || null,
        closed_at:           new Date().toISOString(),
        log_id:              logId,
        floats_closed_now:   closedCount,
        floats_already_closed: closedFloats.length,
        total_floats:        floatRes.rows.length,
        snapshot: {
          total_deposits:       Number(snap.total_deposits),
          total_withdrawals:    Number(snap.total_withdrawals),
          pending_withdrawals:  snap.pending_withdrawals,
          total_transactions:   snap.total_transactions,
          loans_approved:       lsnap.loans_approved,
          disbursed_today:      Number(lsnap.disbursed),
          commissions_paid:     Number(csnap.commissions_paid),
        },
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("closeDay error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error", detail: error.message });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 8. DAY-END AUDIT TRAIL  (IT / Manager / CEO)
//    GET /api/day-end/:companyId/audit-trail?date=YYYY-MM-DD&staff_id=
//
//  Every significant action in the system for the day:
//  reversals, rejections, loan approvals, budget changes, deletions
// ─────────────────────────────────────────────────────────────────────────────

export const getDayEndAuditTrail = async (req, res) => {
  const { companyId } = req.params;
  const { date, staff_id } = req.query;
  const { start, end, label } = targetDateRange(date);

  try {
    let staffFilter = "";
    const baseParams = [companyId, start, end];

    if (staff_id) {
      staffFilter = " AND (t.created_by = $4 OR t.reversed_by = $4 OR t.staff_id = $4)";
      baseParams.push(staff_id);
    }

    const [reversals, rejectedLoans, approvedLoans, deletedTx, budgetChanges] = await Promise.all([

      // All reversals today
      pool.query(
        `SELECT
           t.id, t.type, t.amount, t.status,
           t.reversed_at, t.reversal_reason,
           c.name AS customer_name, c.phone_number,
           sr.full_name AS reversed_by_name,
           si.full_name AS initiated_by_name
         FROM transactions t
         LEFT JOIN accounts a ON t.account_id = a.id
         LEFT JOIN customers c ON a.customer_id = c.id
         LEFT JOIN staff sr ON t.reversed_by = sr.id
         LEFT JOIN staff si ON t.created_by = si.id
         WHERE t.company_id = $1
           AND t.status = 'reversed'
           AND t.reversed_at BETWEEN $2 AND $3
           ${staff_id ? `AND (t.created_by = $4 OR t.reversed_by = $4)` : ""}
         ORDER BY t.reversed_at DESC`,
        staff_id ? [companyId, start, end, staff_id] : [companyId, start, end]
      ),

      // Rejected loans today
      pool.query(
        `SELECT
           l.id, l.loantype, l.loanamount, l.status, l.updated_at,
           l.description,
           c.name AS customer_name, c.phone_number,
           s.full_name AS handled_by
         FROM loans l
         LEFT JOIN customers c ON l.customer_id = c.id
         LEFT JOIN staff s ON l.created_by = s.id
         WHERE l.company_id = $1
           AND l.status = 'rejected'
           AND l.updated_at BETWEEN $2 AND $3
           AND l.loantype != 'group_member'
         ORDER BY l.updated_at DESC`,
        [companyId, start, end]
      ),

      // Approved loans today
      pool.query(
        `SELECT
           l.id, l.loantype, l.loanamount, l.status, l.approved_at,
           c.name AS customer_name,
           s.full_name AS approved_by_name
         FROM loans l
         LEFT JOIN customers c ON l.customer_id = c.id
         LEFT JOIN staff s ON l.approved_by = s.id
         WHERE l.company_id = $1
           AND l.status = 'active'
           AND l.approved_at BETWEEN $2 AND $3
           AND l.loantype != 'group_member'
         ORDER BY l.approved_at DESC`,
        [companyId, start, end]
      ),

      // Deleted (soft-deleted) transactions today
      pool.query(
        `SELECT
           t.id, t.type, t.amount, t.deleted_at,
           c.name AS customer_name,
           s.full_name AS created_by_name,
           a.account_type
         FROM transactions t
         LEFT JOIN accounts a ON t.account_id = a.id
         LEFT JOIN customers c ON a.customer_id = c.id
         LEFT JOIN staff s ON t.created_by = s.id
         WHERE t.company_id = $1
           AND t.is_deleted = true
           AND t.deleted_at BETWEEN $2 AND $3
         ORDER BY t.deleted_at DESC`,
        [companyId, start, end]
      ),

      // Budget top-ups and sales today (money movement audit)
      pool.query(
        `SELECT
           'topup' AS event_type,
           bt.id, bt.amount, bt.source, bt.created_at,
           s.full_name AS recorded_by_name,
           b.teller_id, ts.full_name AS teller_name
         FROM budget_topups bt
         JOIN budgets b ON bt.budget_id = b.id
         LEFT JOIN staff s ON bt.recorded_by = s.id
         LEFT JOIN staff ts ON b.teller_id = ts.id
         WHERE b.company_id = $1
           AND bt.created_at BETWEEN $2 AND $3

         UNION ALL

         SELECT
           'cash_sale' AS event_type,
           bs.id, bs.amount, bs.destination AS source, bs.created_at,
           s.full_name AS recorded_by_name,
           b.teller_id, ts.full_name AS teller_name
         FROM budget_sales bs
         JOIN budgets b ON bs.budget_id = b.id
         LEFT JOIN staff s ON bs.recorded_by = s.id
         LEFT JOIN staff ts ON b.teller_id = ts.id
         WHERE b.company_id = $1
           AND bs.created_at BETWEEN $2 AND $3

         ORDER BY created_at DESC`,
        [companyId, start, end]
      ),
    ]);

    return res.status(200).json({
      status: "success",
      report_date: label,
      generated_at: new Date().toISOString(),
      data: {
        reversals:        reversals.rows,
        rejected_loans:   rejectedLoans.rows,
        approved_loans:   approvedLoans.rows,
        deleted_transactions: deletedTx.rows,
        budget_events:    budgetChanges.rows,
        summary: {
          total_reversals:    reversals.rows.length,
          total_rejections:   rejectedLoans.rows.length,
          total_approvals:    approvedLoans.rows.length,
          total_deletions:    deletedTx.rows.length,
          total_budget_events: budgetChanges.rows.length,
        },
      },
    });
  } catch (error) {
    console.error("getDayEndAuditTrail error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error", detail: error.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 9.  QUICK STATUS CHECK  (any role — lightweight ping)
//     GET /api/day-end/:companyId/status
//
//  Returns live counts for dashboard widgets:
//  pending withdrawals, open floats, active loans, unread alerts
// ─────────────────────────────────────────────────────────────────────────────

export const getDayEndStatus = async (req, res) => {
  const { companyId } = req.params;
  const { date } = req.query;
  const { label } = targetDateRange(date);
  console.log(companyId);

  try {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM transactions
          WHERE company_id = $1 AND type = 'withdrawal' AND status = 'pending' AND is_deleted = false)::int
          AS pending_withdrawals,

         (SELECT COUNT(*) FROM budgets
          WHERE company_id = $1 AND date = $2 AND status = 'Active')::int
          AS open_floats,

         (SELECT COUNT(*) FROM budgets
          WHERE company_id = $1 AND date = $2 AND status = 'Closed')::int
          AS closed_floats,

         (SELECT COUNT(*) FROM loans
          WHERE company_id = $1 AND status = 'active' AND loantype != 'group_member')::int
          AS active_loans,

         (SELECT COUNT(*) FROM loans
          WHERE company_id = $1 AND days_overdue > 0 AND status = 'active' AND loantype != 'group_member')::int
          AS overdue_loans,

         (SELECT COUNT(*) FROM loans
          WHERE company_id = $1 AND status = 'pending' AND loantype != 'group_member')::int
          AS pending_loan_applications,

         (SELECT COUNT(*) FROM commissions
          WHERE company_id = $1 AND status = 'pending')::int
          AS pending_commissions,

         (SELECT COALESCE(SUM(amount), 0) FROM transactions
          WHERE company_id = $1 AND type = 'deposit' AND is_deleted = false
            AND transaction_date::date = $2::date)
          AS today_deposits,

         (SELECT COALESCE(SUM(amount), 0) FROM transactions
          WHERE company_id = $1 AND type = 'withdrawal' AND status IN ('approved','completed') AND is_deleted = false
            AND transaction_date::date = $2::date)
          AS today_withdrawals`,
      [companyId, label]
    );

    const s = result.rows[0];

    return res.status(200).json({
      status: "success",
      as_of:  new Date().toISOString(),
      data: {
        pending_withdrawals:      s.pending_withdrawals,
        open_floats:              s.open_floats,
        closed_floats:            s.closed_floats,
        active_loans:             s.active_loans,
        overdue_loans:            s.overdue_loans,
        pending_loan_applications: s.pending_loan_applications,
        pending_commissions:      s.pending_commissions,
        today_deposits:           Number(s.today_deposits),
        today_withdrawals:        Number(s.today_withdrawals),
        net_today:                Number(s.today_deposits) - Number(s.today_withdrawals),
        alerts: {
          has_pending_withdrawals: s.pending_withdrawals > 0,
          has_open_floats:        s.open_floats > 0,
          has_overdue_loans:      s.overdue_loans > 0,
          has_pending_loans:      s.pending_loan_applications > 0,
        },
      },
    });
  } catch (error) {
    console.error("getDayEndStatus error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error", detail: error.message });
  }
};
