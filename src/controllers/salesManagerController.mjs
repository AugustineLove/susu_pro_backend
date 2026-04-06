// controllers/salesManagerController.mjs
import pool from "../db.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
 * Resolves a named date range into an ISO start-date string.
 * Range keys: today | yesterday | last_week | last_month | last_3_months | this_year
 */
const resolveDateRange = (dateRange) => {
  const now = new Date();
  switch (dateRange) {
    case "today":
      return formatStartDate(now);
    case "yesterday": {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return formatStartDate(d);
    }
    case "last_week":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "last_month":
      return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).toISOString();
    case "last_3_months":
      return new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()).toISOString();
    case "this_year":
      return new Date(now.getFullYear(), 0, 1).toISOString();
    default:
      return null;
  }
};

/**
 * Builds WHERE fragments + values for date-range filtering on a given column.
 * Returns { clause, values, nextIndex }
 */
const buildDateFilter = (dateRange, startDate, endDate, startIndex, column) => {
  const conditions = [];
  const values = [];
  let idx = startIndex;

  if (dateRange === "custom") {
    if (startDate && endDate) {
      conditions.push(`${column} BETWEEN $${idx} AND $${idx + 1}`);
      values.push(formatStartDate(startDate), formatEndDate(endDate));
      idx += 2;
    } else if (startDate) {
      conditions.push(`${column} >= $${idx}`);
      values.push(formatStartDate(startDate));
      idx++;
    } else if (endDate) {
      conditions.push(`${column} <= $${idx}`);
      values.push(formatEndDate(endDate));
      idx++;
    }
  } else if (dateRange && dateRange !== "all") {
    const from = resolveDateRange(dateRange);
    if (from) {
      conditions.push(`${column} >= $${idx}`);
      values.push(from);
      idx++;
    }
  }

  return {
    clause: conditions.join(" AND "),
    values,
    nextIndex: idx,
  };
};


// ─── 1. Field Report (Core Sales Manager View) ───────────────────────────────
//
// GET /api/sales-manager/:companyId/field-report
//
// Query params:
//   staffId       – filter by a specific mobile banker (optional)
//   location      – filter by customer location (optional)
//   dateRange     – named range OR "custom"
//   startDate     – ISO / YYYY-MM-DD  (used when dateRange = "custom")
//   endDate       – ISO / YYYY-MM-DD  (used when dateRange = "custom")
//
// Returns:
//   • summaryStats         – headline numbers
//   • collectionsByLocation – total deposits grouped by location
//   • collectionsByStaff    – total deposits grouped by mobile banker
//   • customerList          – every matching customer with their period balance + deposit
//   • dailyTrend            – day-by-day deposit total within the date window

export const getFieldReport = async (req, res) => {
  const { companyId } = req.params;
  const {
    staffId,
    location,
    dateRange = "last_month",
    startDate,
    endDate,
  } = req.query;

  try {
    // ── Build shared date filter on t.transaction_date ──────────────────────
    const df = buildDateFilter(dateRange, startDate, endDate, 2, "t.transaction_date");
    const baseDateWhere = df.clause ? `AND ${df.clause}` : "";

    // Base values always start with companyId
    let baseValues = [companyId, ...df.values];
    let nextIdx = df.nextIndex;

    // ── Optional staff filter ────────────────────────────────────────────────
    let staffFilter = "";
    if (staffId && staffId !== "all") {
      staffFilter = `AND t.staff_id = $${nextIdx}`;
      baseValues.push(staffId);
      nextIdx++;
    }

    // ── Optional location filter ─────────────────────────────────────────────
    let locationFilter = "";
    if (location && location !== "all") {
      locationFilter = `AND c.location = $${nextIdx}`;
      baseValues.push(location);
      nextIdx++;
    }

    // ════════════════════════════════════════════════════════════════════════
    // A) SUMMARY STATS
    // ════════════════════════════════════════════════════════════════════════
    const summaryRes = await pool.query(
      `
      SELECT
        COUNT(DISTINCT c.id)::int                                        AS total_customers,
        COUNT(DISTINCT t.id) FILTER (WHERE t.type = 'deposit')::int     AS total_deposit_transactions,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)    AS total_collected,
        COALESCE(AVG(t.amount) FILTER (WHERE t.type = 'deposit'), 0)    AS avg_deposit,
        COALESCE(MAX(t.amount) FILTER (WHERE t.type = 'deposit'), 0)    AS highest_single_deposit,
        COUNT(DISTINCT t.id) FILTER (WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed'))::int
                                                                         AS total_withdrawal_transactions,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed')), 0)
                                                                         AS total_withdrawn,
        COUNT(DISTINCT c.location)::int                                 AS locations_covered,
        COUNT(DISTINCT t.staff_id)::int                                 AS active_bankers
      FROM customers c
      JOIN accounts a   ON a.customer_id = c.id
      LEFT JOIN transactions t ON t.account_id = a.id
                              AND t.is_deleted = false
                              ${baseDateWhere}
                              ${staffFilter}
      WHERE c.company_id = $1
        AND c.is_deleted = false
        ${locationFilter}
      `,
      baseValues
    );

    // ════════════════════════════════════════════════════════════════════════
    // B) COLLECTIONS BY LOCATION
    // ════════════════════════════════════════════════════════════════════════
    const locationRes = await pool.query(
      `
      SELECT
        COALESCE(c.location, 'Unknown')                                AS location,
        COUNT(DISTINCT c.id)::int                                      AS customer_count,
        COUNT(t.id) FILTER (WHERE t.type = 'deposit')::int            AS deposit_count,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)  AS total_collected,
        COALESCE(AVG(t.amount) FILTER (WHERE t.type = 'deposit'), 0)  AS avg_deposit
      FROM customers c
      JOIN accounts a   ON a.customer_id = c.id
      LEFT JOIN transactions t ON t.account_id = a.id
                              AND t.is_deleted = false
                              ${baseDateWhere}
                              ${staffFilter}
      WHERE c.company_id = $1
        AND c.is_deleted = false
        ${locationFilter}
      GROUP BY c.location
      ORDER BY total_collected DESC
      `,
      baseValues
    );

    // ════════════════════════════════════════════════════════════════════════
    // C) COLLECTIONS BY STAFF (mobile banker)
    // ════════════════════════════════════════════════════════════════════════
    const staffRes = await pool.query(
      `
      SELECT
        s.id                                                              AS staff_id,
        s.full_name                                                       AS staff_name,
        s.phone                                                           AS staff_phone,
        COUNT(DISTINCT c.id)::int                                         AS customers_served,
        COUNT(t.id) FILTER (WHERE t.type = 'deposit')::int               AS deposit_count,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)     AS total_collected,
        COALESCE(AVG(t.amount) FILTER (WHERE t.type = 'deposit'), 0)     AS avg_deposit,
        COUNT(DISTINCT c.location)::int                                   AS locations_covered,
        MAX(t.transaction_date)                                           AS last_activity
      FROM staff s
      JOIN transactions t ON t.staff_id = s.id
                         AND t.is_deleted = false
                         ${baseDateWhere}
      JOIN accounts a    ON a.id = t.account_id
      JOIN customers c   ON c.id = a.customer_id
                         AND c.company_id = $1
                         AND c.is_deleted = false
                         ${locationFilter}
      WHERE s.company_id = $1
        ${staffFilter}
      GROUP BY s.id, s.full_name, s.phone
      ORDER BY total_collected DESC
      `,
      baseValues
    );

    // ════════════════════════════════════════════════════════════════════════
    // D) CUSTOMER LIST (detailed rows for export)
    // ════════════════════════════════════════════════════════════════════════
    const customerRes = await pool.query(
      `
      SELECT
        c.id                                                                        AS customer_id,
        c.name                                                                      AS customer_name,
        c.phone_number,
        c.account_number,
        c.location,
        c.date_of_registration,
        c.status,
        s.full_name                                                                 AS registered_by_name,

        -- Period totals
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)               AS period_deposits,
        COUNT(t.id) FILTER (WHERE t.type = 'deposit')::int                         AS deposit_count,
        COALESCE(SUM(t.amount) FILTER (
          WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed')
        ), 0)                                                                       AS period_withdrawals,

        -- Current account balance (all non-loan accounts)
        COALESCE(SUM(DISTINCT
          CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END
        ), 0)                                                                       AS current_balance,

        MAX(t.transaction_date)                                                     AS last_transaction_date
      FROM customers c
      JOIN staff s       ON s.id = c.registered_by
      JOIN accounts a    ON a.customer_id = c.id
      LEFT JOIN transactions t ON t.account_id = a.id
                              AND t.is_deleted = false
                              ${baseDateWhere}
                              ${staffFilter}
      WHERE c.company_id = $1
        AND c.is_deleted = false
        ${locationFilter}
      GROUP BY c.id, c.name, c.phone_number, c.account_number,
               c.location, c.date_of_registration, c.status, s.full_name
      ORDER BY c.location ASC, period_deposits DESC
      `,
      baseValues
    );

    // ════════════════════════════════════════════════════════════════════════
    // E) DAILY TREND (within the date window)
    // ════════════════════════════════════════════════════════════════════════
    const dailyRes = await pool.query(
      `
      SELECT
        t.transaction_date::date                                          AS day,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)     AS deposits,
        COALESCE(SUM(t.amount) FILTER (
          WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed')
        ), 0)                                                             AS withdrawals,
        COUNT(t.id) FILTER (WHERE t.type = 'deposit')::int               AS deposit_count
      FROM transactions t
      JOIN accounts a  ON a.id = t.account_id
      JOIN customers c ON c.id = a.customer_id
                      AND c.company_id = $1
                      AND c.is_deleted = false
                      ${locationFilter}
      WHERE t.is_deleted = false
        ${baseDateWhere}
        ${staffFilter}
      GROUP BY t.transaction_date::date
      ORDER BY day ASC
      `,
      baseValues
    );

    return res.status(200).json({
      status: "success",
      meta: {
        companyId,
        filters: { staffId, location, dateRange, startDate, endDate },
        generatedAt: new Date().toISOString(),
      },
      data: {
        summaryStats: summaryRes.rows[0],
        collectionsByLocation: locationRes.rows,
        collectionsByStaff: staffRes.rows,
        customerList: customerRes.rows,
        dailyTrend: dailyRes.rows,
      },
    });
  } catch (error) {
    console.error("Sales manager field report error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to generate field report",
      detail: error.message,
    });
  }
};


// ─── 2. Staff Performance Leaderboard ────────────────────────────────────────
//
// GET /api/sales-manager/:companyId/staff-performance
//
// Returns rankings of mobile bankers within a period — useful for the sales
// manager to track who is hitting targets, who is lagging, and who has the
// most active customer base.

export const getStaffPerformance = async (req, res) => {
  const { companyId } = req.params;
  const { dateRange = "last_month", startDate, endDate } = req.query;

  try {
    const df = buildDateFilter(dateRange, startDate, endDate, 2, "t.transaction_date");
    const dateWhere = df.clause ? `AND ${df.clause}` : "";

    const result = await pool.query(
      `
      SELECT
        s.id                                                                         AS staff_id,
        s.full_name,
        s.phone,
        s.role,
        s.status,

        -- Customer base
        COUNT(DISTINCT c.id)::int                                                    AS total_customers,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'Active')::int                AS active_customers,

        -- Deposits
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)                AS total_deposits,
        COUNT(t.id) FILTER (WHERE t.type = 'deposit')::int                          AS deposit_count,
        COALESCE(AVG(t.amount) FILTER (WHERE t.type = 'deposit'), 0)                AS avg_deposit,

        -- Withdrawals processed
        COALESCE(SUM(t.amount) FILTER (
          WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed')
        ), 0)                                                                        AS total_withdrawals_processed,

        -- New customer registrations in period
        COUNT(DISTINCT c2.id) FILTER (
          WHERE c2.date_of_registration::date
            BETWEEN COALESCE($${df.nextIndex}::date, '1900-01-01')
                AND COALESCE($${df.nextIndex + 1}::date, CURRENT_DATE)
        )::int                                                                       AS new_registrations_in_period,

        -- Location coverage
        COUNT(DISTINCT c.location)::int                                              AS locations_covered,

        -- Activity
        MAX(t.transaction_date)                                                      AS last_activity,
        DENSE_RANK() OVER (ORDER BY
          COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0) DESC
        )::int                                                                       AS deposit_rank

      FROM staff s
      LEFT JOIN customers c  ON c.registered_by = s.id AND c.is_deleted = false
      LEFT JOIN customers c2 ON c2.registered_by = s.id AND c2.is_deleted = false
      LEFT JOIN accounts a   ON a.customer_id = c.id
      LEFT JOIN transactions t ON t.account_id = a.id
                               AND t.is_deleted = false
                               ${dateWhere}
      WHERE s.company_id = $1
      GROUP BY s.id, s.full_name, s.phone, s.role, s.status
      ORDER BY total_deposits DESC
      `,
      [
        companyId,
        ...df.values,
        // Start/end for registrations window — mirror the transaction window
        startDate
          ? formatStartDate(startDate)
          : df.values[0] ?? null,
        endDate
          ? formatEndDate(endDate)
          : new Date().toISOString(),
      ]
    );

    return res.status(200).json({
      status: "success",
      meta: {
        companyId,
        dateRange,
        startDate,
        endDate,
        generatedAt: new Date().toISOString(),
      },
      data: result.rows,
    });
  } catch (error) {
    console.error("Staff performance error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch staff performance",
      detail: error.message,
    });
  }
};


// ─── 3. Location Summary ──────────────────────────────────────────────────────
//
// GET /api/sales-manager/:companyId/location-summary
//
// Aggregated view per location — total customers, total balance, period
// collections. Great for territory planning.

export const getLocationSummary = async (req, res) => {
  const { companyId } = req.params;
  const { dateRange = "last_month", startDate, endDate } = req.query;

  try {
    const df = buildDateFilter(dateRange, startDate, endDate, 2, "t.transaction_date");
    const dateWhere = df.clause ? `AND ${df.clause}` : "";

    const result = await pool.query(
      `
      SELECT
        COALESCE(c.location, 'Unknown')                                              AS location,
        COUNT(DISTINCT c.id)::int                                                    AS total_customers,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'Active')::int                AS active_customers,
        COUNT(DISTINCT s.id)::int                                                    AS bankers_assigned,

        -- Balances
        COALESCE(SUM(
          CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END
        ), 0)                                                                        AS total_balance,

        -- Period collections
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)                AS period_collected,
        COUNT(t.id) FILTER (WHERE t.type = 'deposit')::int                          AS deposit_count,

        -- Period withdrawals
        COALESCE(SUM(t.amount) FILTER (
          WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed')
        ), 0)                                                                        AS period_withdrawn,

        -- Net flow
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)
          - COALESCE(SUM(t.amount) FILTER (
              WHERE t.type = 'withdrawal' AND t.status IN ('approved','completed')
            ), 0)                                                                    AS net_flow,

        -- New customers in period
        COUNT(DISTINCT c.id) FILTER (
          WHERE c.date_of_registration >= $${df.nextIndex}
        )::int                                                                       AS new_customers_in_period

      FROM customers c
      JOIN staff s    ON s.id = c.registered_by
      JOIN accounts a ON a.customer_id = c.id
      LEFT JOIN transactions t ON t.account_id = a.id
                              AND t.is_deleted = false
                              ${dateWhere}
      WHERE c.company_id = $1
        AND c.is_deleted = false
      GROUP BY c.location
      ORDER BY period_collected DESC
      `,
      [
        companyId,
        ...df.values,
        // For new_customers_in_period: use start of the date window
        df.values[0] ?? new Date(0).toISOString(),
      ]
    );

    return res.status(200).json({
      status: "success",
      meta: {
        companyId,
        dateRange,
        startDate,
        endDate,
        generatedAt: new Date().toISOString(),
      },
      data: result.rows,
    });
  } catch (error) {
    console.error("Location summary error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch location summary",
      detail: error.message,
    });
  }
};


// ─── 4. Customer Retention / Dormancy Report ──────────────────────────────────
//
// GET /api/sales-manager/:companyId/retention
//
// Highlights customers who have gone quiet — no deposits in N days.
// Sales managers can hand this list to mobile bankers as a re-engagement target.

export const getRetentionReport = async (req, res) => {
  const { companyId } = req.params;
  const {
    staffId,
    location,
    dormantDays = 30, // customers with no deposit for this many days
  } = req.query;

  try {
    let conditions = ["c.company_id = $1", "c.is_deleted = false", "c.status = 'Active'"];
    const values = [companyId];
    let idx = 2;

    if (staffId && staffId !== "all") {
      conditions.push(`c.registered_by = $${idx}`);
      values.push(staffId);
      idx++;
    }

    if (location && location !== "all") {
      conditions.push(`c.location = $${idx}`);
      values.push(location);
      idx++;
    }

    const whereClause = "WHERE " + conditions.join(" AND ");

    const result = await pool.query(
      `
      SELECT
        c.id                                   AS customer_id,
        c.name                                 AS customer_name,
        c.phone_number,
        c.account_number,
        c.location,
        c.date_of_registration,
        s.full_name                            AS mobile_banker,
        s.phone                                AS banker_phone,
        MAX(t.transaction_date)                AS last_deposit_date,
        EXTRACT(DAY FROM NOW() - MAX(t.transaction_date))::int
                                               AS days_since_last_deposit,
        COALESCE(SUM(
          CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END
        ), 0)                                  AS current_balance,
        COUNT(t.id)::int                       AS total_lifetime_deposits
      FROM customers c
      JOIN staff s   ON s.id = c.registered_by
      JOIN accounts a ON a.customer_id = c.id
      LEFT JOIN transactions t ON t.account_id = a.id
                               AND t.type = 'deposit'
                               AND t.is_deleted = false
      ${whereClause}
      GROUP BY c.id, c.name, c.phone_number, c.account_number,
               c.location, c.date_of_registration, s.full_name, s.phone
      HAVING MAX(t.transaction_date) < NOW() - ($${idx} || ' days')::interval
          OR MAX(t.transaction_date) IS NULL
      ORDER BY days_since_last_deposit DESC NULLS FIRST
      `,
      [...values, dormantDays]
    );

    return res.status(200).json({
      status: "success",
      meta: {
        companyId,
        filters: { staffId, location, dormantDays },
        generatedAt: new Date().toISOString(),
      },
      data: result.rows,
    });
  } catch (error) {
    console.error("Retention report error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch retention report",
      detail: error.message,
    });
  }
};


// ─── 5. New Customer Acquisition Report ──────────────────────────────────────
//
// GET /api/sales-manager/:companyId/acquisition
//
// How many new customers were registered in the period, by whom, and where.
// Tells the sales manager if the team is growing the book.

export const getAcquisitionReport = async (req, res) => {
  const { companyId } = req.params;
  const {
    staffId,
    location,
    dateRange = "last_month",
    startDate,
    endDate,
  } = req.query;

  try {
    const df = buildDateFilter(dateRange, startDate, endDate, 2, "c.date_of_registration");

    let conditions = [
      "c.company_id = $1",
      "c.is_deleted = false",
      ...(df.clause ? [df.clause] : []),
    ];
    let values = [companyId, ...df.values];
    let idx = df.nextIndex;

    if (staffId && staffId !== "all") {
      conditions.push(`c.registered_by = $${idx}`);
      values.push(staffId);
      idx++;
    }

    if (location && location !== "all") {
      conditions.push(`c.location = $${idx}`);
      values.push(location);
      idx++;
    }

    const whereClause = "WHERE " + conditions.join(" AND ");

    // New customers list
    const newCustomersRes = await pool.query(
      `
      SELECT
        c.id                       AS customer_id,
        c.name                     AS customer_name,
        c.phone_number,
        c.account_number,
        c.location,
        c.date_of_registration,
        c.status,
        s.full_name                AS registered_by_name,
        s.phone                    AS banker_phone,
        COALESCE(
          SUM(CASE WHEN a.account_type NOT ILIKE '%loan%' THEN a.balance ELSE 0 END),
          0
        )                          AS current_balance
      FROM customers c
      JOIN staff s    ON s.id = c.registered_by
      JOIN accounts a ON a.customer_id = c.id
      ${whereClause}
      GROUP BY c.id, c.name, c.phone_number, c.account_number,
               c.location, c.date_of_registration, c.status, s.full_name, s.phone
      ORDER BY c.date_of_registration DESC
      `,
      values
    );

    // Aggregated by staff
    const byStaffRes = await pool.query(
      `
      SELECT
        s.full_name                AS staff_name,
        s.phone                    AS staff_phone,
        COUNT(c.id)::int           AS new_customers,
        COUNT(DISTINCT c.location)::int AS locations
      FROM customers c
      JOIN staff s ON s.id = c.registered_by
      ${whereClause}
      GROUP BY s.full_name, s.phone
      ORDER BY new_customers DESC
      `,
      values
    );

    // Aggregated by location
    const byLocationRes = await pool.query(
      `
      SELECT
        COALESCE(c.location, 'Unknown') AS location,
        COUNT(c.id)::int                AS new_customers
      FROM customers c
      JOIN staff s ON s.id = c.registered_by
      ${whereClause}
      GROUP BY c.location
      ORDER BY new_customers DESC
      `,
      values
    );

    // Daily trend
    const trendRes = await pool.query(
      `
      SELECT
        c.date_of_registration::date AS day,
        COUNT(c.id)::int             AS new_customers
      FROM customers c
      JOIN staff s ON s.id = c.registered_by
      ${whereClause}
      GROUP BY c.date_of_registration::date
      ORDER BY day ASC
      `,
      values
    );

    return res.status(200).json({
      status: "success",
      meta: {
        companyId,
        filters: { staffId, location, dateRange, startDate, endDate },
        generatedAt: new Date().toISOString(),
      },
      data: {
        totalNewCustomers: newCustomersRes.rowCount,
        byStaff: byStaffRes.rows,
        byLocation: byLocationRes.rows,
        dailyTrend: trendRes.rows,
        customers: newCustomersRes.rows,
      },
    });
  } catch (error) {
    console.error("Acquisition report error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch acquisition report",
      detail: error.message,
    });
  }
};


// ─── 6. Target vs Actual (Collection Targets) ────────────────────────────────
//
// GET /api/sales-manager/:companyId/target-vs-actual
//
// Compares what each mobile banker was expected to collect (daily_rate × days)
// against what they actually collected in the period. Highlights who is over /
// under target so the sales manager can act.

export const getTargetVsActual = async (req, res) => {
  const { companyId } = req.params;
  const {
    staffId,
    location,
    dateRange = "last_month",
    startDate,
    endDate,
  } = req.query;

  try {
    // Resolve date window edges for the "expected" calculation
    let windowStart, windowEnd;
    if (dateRange === "custom" && startDate && endDate) {
      windowStart = new Date(startDate);
      windowEnd   = new Date(endDate);
    } else {
      windowEnd   = new Date();
      windowStart = new Date(resolveDateRange(dateRange) ?? windowEnd);
    }
    const periodDays = Math.max(
      1,
      Math.ceil((windowEnd - windowStart) / (1000 * 60 * 60 * 24))
    );

    const df = buildDateFilter(dateRange, startDate, endDate, 2, "t.transaction_date");
    const dateWhere = df.clause ? `AND ${df.clause}` : "";

    let extraConditions = "";
    let values = [companyId, ...df.values];
    let idx = df.nextIndex;

    if (staffId && staffId !== "all") {
      extraConditions += ` AND s.id = $${idx}`;
      values.push(staffId);
      idx++;
    }

    if (location && location !== "all") {
      extraConditions += ` AND c.location = $${idx}`;
      values.push(location);
      idx++;
    }

    const result = await pool.query(
      `
      SELECT
        s.id                                                                        AS staff_id,
        s.full_name                                                                 AS staff_name,
        s.phone                                                                     AS staff_phone,

        -- Expected = sum of all active customers' daily_rate × period days
        COALESCE(SUM(c.daily_rate), 0) * $${idx}                                   AS expected_collection,

        -- Actual collected in period
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)               AS actual_collection,

        -- Achievement %
        CASE
          WHEN COALESCE(SUM(c.daily_rate), 0) * $${idx} = 0 THEN NULL
          ELSE ROUND(
            (COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit'), 0)
              / (COALESCE(SUM(c.daily_rate), 0) * $${idx})
            ) * 100, 2
          )
        END                                                                         AS achievement_pct,

        COUNT(DISTINCT c.id)::int                                                   AS customer_count,
        COUNT(t.id) FILTER (WHERE t.type = 'deposit')::int                         AS deposit_count

      FROM staff s
      JOIN customers c  ON c.registered_by = s.id
                       AND c.is_deleted = false
                       AND c.status = 'Active'
      JOIN accounts a   ON a.customer_id = c.id
      LEFT JOIN transactions t ON t.account_id = a.id
                               AND t.is_deleted = false
                               ${dateWhere}
      WHERE s.company_id = $1
        ${extraConditions}
      GROUP BY s.id, s.full_name, s.phone
      ORDER BY achievement_pct DESC NULLS LAST
      `,
      [...values, periodDays]
    );

    return res.status(200).json({
      status: "success",
      meta: {
        companyId,
        filters: { staffId, location, dateRange, startDate, endDate },
        periodDays,
        generatedAt: new Date().toISOString(),
      },
      data: result.rows,
    });
  } catch (error) {
    console.error("Target vs actual error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch target vs actual",
      detail: error.message,
    });
  }
};


// ─── 7. Dropdown Helper – Distinct Locations ─────────────────────────────────
//
// GET /api/sales-manager/:companyId/locations
//
// Returns a unique list of customer locations for populating the filter
// dropdown on the frontend.

export const getDistinctLocations = async (req, res) => {
  const { companyId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT DISTINCT location
      FROM customers
      WHERE company_id = $1
        AND is_deleted = false
        AND location IS NOT NULL
        AND TRIM(location) != ''
      ORDER BY location ASC
      `,
      [companyId]
    );

    return res.status(200).json({
      status: "success",
      data: result.rows.map((r) => r.location),
    });
  } catch (error) {
    console.error("Distinct locations error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch locations",
      detail: error.message,
    });
  }
};

export const getAllBankers = async (req, res) => {
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
      WHERE company_id = $1 AND role in ('mobile banker', 'mobile_banker', 'Mobile Banker', 'Mobile_Banker', 'accountant', 'Accountant')
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