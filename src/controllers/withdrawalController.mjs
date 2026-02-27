import pool from '../db.mjs';
import { buildDateRangeFilter } from '../utils/dateRangeSafeParser.mjs';

export const getWithdrawals = async (req, res) => {
  try {
    const { company_id } = req.params;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const { search, status, staff, startDate, endDate } = req.query;

    let whereConditions = [
      "t.company_id = $1",
      "t.type = 'withdrawal'"
    ];

    const values = [company_id];
    let paramIndex = 2;

    // 🔎 Search
    if (search) {
      whereConditions.push(`(
        c.name ILIKE $${paramIndex} OR
        c.phone_number ILIKE $${paramIndex} OR
        t.unique_code ILIKE $${paramIndex} OR
        a.account_number ILIKE $${paramIndex}
      )`);
      values.push(`%${search}%`);
      paramIndex++;
    }

    // 📌 Status filter
    if (status && status !== "all") {
      whereConditions.push(`t.status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    // 👤 Staff filter
    if (staff && staff !== "all") {
      whereConditions.push(`rs.id = $${paramIndex}`);
      values.push(staff);
      paramIndex++;
    }

    // 📅 Date range filter
    paramIndex = buildDateRangeFilter(
      startDate,
      endDate,
      paramIndex,
      values,
      whereConditions
    );

    const whereClause = "WHERE " + whereConditions.join(" AND ");

    const isSearching = !!(
      search ||
      (status && status !== "all") ||
      (staff && staff !== "all") ||
      startDate ||
      endDate
    );

    // ---------------- COUNT QUERY ----------------
    const countQuery = `
      SELECT COUNT(DISTINCT t.id) as total
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      JOIN customers c ON a.customer_id = c.id
      LEFT JOIN staff rs ON t.staff_id = rs.id
      ${whereClause}
    `;

    const countResult = await pool.query(countQuery, values);
    const total = parseInt(countResult.rows[0].total, 10);

    // ---------------- MAIN QUERY ----------------
    let mainQuery = `
      SELECT 
        t.id AS transaction_id,
        t.amount,
        t.description,
        t.status,
        t.unique_code,
        t.transaction_date,
        t.reversed_at,
        t.reversal_reason,
        t.withdrawal_type,

        a.id AS account_id,
        a.account_type,
        a.account_number,

        c.id AS customer_id,
        c.name AS customer_name,
        c.phone_number AS customer_phone,

        rs.id AS recorded_staff_id,
        rs.full_name AS recorded_staff_name,

        str.full_name AS reversed_by_name

      FROM transactions t

      LEFT JOIN staff str ON t.reversed_by = str.id
      LEFT JOIN staff rs ON t.staff_id = rs.id

      JOIN accounts a ON t.account_id = a.id
      JOIN customers c ON a.customer_id = c.id

      ${whereClause}

      ORDER BY t.transaction_date DESC
    `;

    const queryValues = [...values];

    if (!isSearching) {
      mainQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      queryValues.push(limit, offset);
    }

    const result = await pool.query({
      text: mainQuery,
      values: queryValues,
      statement_timeout: 120000,
    });

    const responsePage = isSearching ? 1 : page;
    const responseLimit = isSearching ? total : limit;
    const totalPages = isSearching ? 1 : Math.ceil(total / limit);

    res.status(200).json({
      status: "success",
      page: responsePage,
      limit: responseLimit,
      total,
      totalPages,
      isSearching,
      data: result.rows,
    });

  } catch (error) {
    console.error("Error fetching withdrawals:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to fetch withdrawals",
    });
  }
};