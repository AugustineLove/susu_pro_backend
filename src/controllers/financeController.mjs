import pool from "../db.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getDateRange = (range, startDate, endDate) => {
  const now = new Date();

  if (range === "custom" && startDate && endDate) {
    return {
      start: new Date(startDate + "T00:00:00"),
      end: new Date(endDate + "T23:59:59"),
    };
  }

  switch (range) {
    case "this-month":
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
      };
    case "last-month": {
      const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      const m = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      return {
        start: new Date(y, m, 1),
        end: new Date(y, m + 1, 0, 23, 59, 59),
      };
    }
    case "quarter": {
      const q = Math.floor(now.getMonth() / 3);
      return {
        start: new Date(now.getFullYear(), q * 3, 1),
        end: new Date(now.getFullYear(), q * 3 + 3, 0, 23, 59, 59),
      };
    }
    case "year":
      return {
        start: new Date(now.getFullYear(), 0, 1),
        end: new Date(now.getFullYear(), 11, 31, 23, 59, 59),
      };
    default: // this-month fallback
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
      };
  }
};

// ─── Main Controller ──────────────────────────────────────────────────────────

export const getCompanyFinancials = async (req, res) => {
  const { companyId } = req.params;
  console.log(`Fetching finance`)
  const {
    range = "this-month",
    startDate,
    endDate,
  } = req.query;

  try {
    const { start, end } = getDateRange(range, startDate, endDate);

    const [
      expensesRes,
      paymentsRes,
      assetsRes,
      budgetsRes,
      // All commissions in range
      commissionsInRangeRes,
      // Commission stats (this month always, for KPI cards)
      commissionThisMonthRes,
      // Monthly trend — last 6 months
      monthlyTrendRes,
      // Expense breakdown by category (in range)
      expenseByCategoryRes,
    ] = await Promise.all([

      // ── Expenses in range ──
      pool.query(
        `SELECT id, description, amount, category, expense_date, created_at
         FROM expenses
         WHERE company_id = $1
           AND expense_date BETWEEN $2 AND $3
         ORDER BY expense_date DESC`,
        [companyId, start, end]
      ),

      // ── Revenue in range ──
      pool.query(
        `SELECT id, description, amount, category, payment_date, created_at, source, status, notes
         FROM revenue
         WHERE company_id = $1
           AND payment_date BETWEEN $2 AND $3
         ORDER BY payment_date DESC`,
        [companyId, start, end]
      ),

      // ── Assets (all — not date-filtered, assets are persistent) ──
      pool.query(
        `SELECT id, name, value, status, purchase_date, depreciation_rate, useful_life, created_at
         FROM assets
         WHERE company_id = $1
         ORDER BY purchase_date DESC`,
        [companyId]
      ),

      // ── Budgets in range ──
      pool.query(
        `SELECT id, allocated, spent, date, remaining, status
         FROM budgets
         WHERE company_id = $1
           AND date BETWEEN $2 AND $3
         ORDER BY date DESC`,
        [companyId, start, end]
      ),

      // ── Commissions in range (sum + count) ──
      pool.query(
        `SELECT
           COALESCE(SUM(amount), 0) AS total_amount,
           COUNT(*) AS total_count
         FROM commissions
         WHERE company_id = $1
           AND created_at BETWEEN $2 AND $3`,
        [companyId, start, end]
      ),

      // ── Commission this month (always, for KPI card) ──
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS this_month_amount
         FROM commissions
         WHERE company_id = $1
           AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`,
        [companyId]
      ),

      // ── Monthly trend — last 6 full months ──
      pool.query(
        `WITH months AS (
           SELECT generate_series(
             DATE_TRUNC('month', NOW()) - INTERVAL '5 months',
             DATE_TRUNC('month', NOW()),
             '1 month'
           ) AS month_start
         )
         SELECT
           TO_CHAR(m.month_start, 'Mon YYYY') AS month,
           m.month_start,
           COALESCE(r.revenue, 0) AS revenue,
           COALESCE(e.expenses, 0) AS expenses,
           COALESCE(c.commissions, 0) AS commissions,
           COALESCE(r.revenue, 0) + COALESCE(c.commissions, 0) - COALESCE(e.expenses, 0) AS profit
         FROM months m
         LEFT JOIN (
           SELECT DATE_TRUNC('month', payment_date) AS mo, SUM(amount) AS revenue
           FROM revenue WHERE company_id = $1
           GROUP BY mo
         ) r ON r.mo = m.month_start
         LEFT JOIN (
           SELECT DATE_TRUNC('month', expense_date) AS mo, SUM(amount) AS expenses
           FROM expenses WHERE company_id = $1
           GROUP BY mo
         ) e ON e.mo = m.month_start
         LEFT JOIN (
           SELECT DATE_TRUNC('month', created_at) AS mo, SUM(amount) AS commissions
           FROM commissions WHERE company_id = $1
           GROUP BY mo
         ) c ON c.mo = m.month_start
         ORDER BY m.month_start DESC`,
        [companyId]
      ),

      // ── Expense by category in range ──
      pool.query(
        `SELECT
           category,
           COALESCE(SUM(amount), 0) AS amount,
           COUNT(*) AS count
         FROM expenses
         WHERE company_id = $1
           AND expense_date BETWEEN $2 AND $3
         GROUP BY category
         ORDER BY amount DESC`,
        [companyId, start, end]
      ),
    ]);

    // ── Compute aggregates ──
    const totalRevenue = paymentsRes.rows.reduce((s, r) => s + Number(r.amount), 0);
    const totalExpenses = expensesRes.rows.reduce((s, e) => s + Number(e.amount), 0);
    const totalCommissionInRange = Number(commissionsInRangeRes.rows[0]?.total_amount || 0);
    const totalIncome = totalRevenue + totalCommissionInRange;
    const grossProfit = totalIncome - totalExpenses;
    const profitMargin = totalIncome > 0 ? (grossProfit / totalIncome) * 100 : 0;
    const totalAssets = assetsRes.rows.reduce((s, a) => s + Number(a.value), 0);
    const roi = totalAssets > 0 ? (grossProfit / totalAssets) * 100 : 0;

    const budgetAllocated = budgetsRes.rows.reduce((s, b) => s + Number(b.allocated), 0);
    const budgetSpent = budgetsRes.rows.reduce((s, b) => s + Number(b.spent), 0);

    // Burn rate = avg monthly expenses over trend period
    const trendExpenses = monthlyTrendRes.rows.map((r) => Number(r.expenses));
    const burnRate =
      trendExpenses.length > 0
        ? trendExpenses.reduce((s, v) => s + v, 0) / trendExpenses.length
        : totalExpenses;
    const runway = burnRate > 0 ? totalAssets / burnRate : 0;

    // Expense to revenue ratio
    const expenseToRevenueRatio = totalIncome > 0 ? (totalExpenses / totalIncome) * 100 : 0;

    res.json({
      status: "success",
      range,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      data: {
        // Raw rows
        expenses: expensesRes.rows,
        revenue: paymentsRes.rows,
        assets: assetsRes.rows,
        budgets: budgetsRes.rows,

        // Trend + breakdowns
        monthlyTrend: monthlyTrendRes.rows,
        expenseByCategory: expenseByCategoryRes.rows,

        // Aggregated operational metrics
        operationalMetrics: {
          monthlyRevenue: totalRevenue,
          monthlyExpenses: totalExpenses,
          grossProfit,
          profitMargin,
          roi,
          burnRate,
          runway,
          operatingExpenseRatio: expenseToRevenueRatio,
          budgetAllocated,
          budgetSpent,
          budgetUtilization: budgetAllocated > 0 ? (budgetSpent / budgetAllocated) * 100 : 0,
        },

        // Commission stats
        commissionStats: {
          total_amount: totalCommissionInRange,
          total_count: Number(commissionsInRangeRes.rows[0]?.total_count || 0),
          this_month_amount: Number(commissionThisMonthRes.rows[0]?.this_month_amount || 0),
        },

        // Summary for P&L
        plSummary: {
          totalRevenue,
          totalCommission: totalCommissionInRange,
          totalIncome,
          totalExpenses,
          grossProfit,
          profitMargin,
          expenseToRevenueRatio,
          breakEvenPoint: totalExpenses,
          topExpenseCategory: expenseByCategoryRes.rows[0]?.category || "N/A",
          topExpenseCategoryAmount: Number(expenseByCategoryRes.rows[0]?.amount || 0),
          topExpenseCategoryPct:
            totalExpenses > 0
              ? (Number(expenseByCategoryRes.rows[0]?.amount || 0) / totalExpenses) * 100
              : 0,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching financials:", error.message);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  }
};
