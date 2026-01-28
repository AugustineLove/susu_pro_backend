import pool from "../db.mjs";

export const getCommissionStat = async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const statsRes = await client.query(
      `
      SELECT
        COUNT(*)::int AS total_commissions,

        -- TOTAL REVENUE (ONLY APPROVED)
        COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)
          AS total_amount,

        COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)
          AS approved_amount,

        COALESCE(SUM(amount) FILTER (WHERE status = 'reversed'), 0)
          AS reversed_amount,

        COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)
          AS pending_amount,

        COUNT(*) FILTER (WHERE status = 'paid')::int
          AS approved_count,

        COUNT(*) FILTER (WHERE status = 'reversed')::int
          AS reversed_count,

        COUNT(*) FILTER (WHERE status = 'pending')::int
          AS pending_count,

        -- TIME-BASED (ONLY APPROVED)
        COALESCE(SUM(amount) FILTER (
          WHERE status = 'paid'
          AND created_at::date = CURRENT_DATE
        ), 0) AS today_amount,

        COALESCE(SUM(amount) FILTER (
          WHERE status = 'paid'
          AND date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)
        ), 0) AS this_month_amount

      FROM commissions
      WHERE company_id = $1
      `,
      [companyId]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      data: {
        stats: statsRes.rows[0],
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");

    return res.status(500).json({
      status: "error",
      message: "Failed to fetch commission statistics",
      error: error.message,
    });
  } finally {
    client.release();
  }
};


export const getAllCommissions = async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();

  try {
    const result = await client.query(
      `
      SELECT
        c.id                    AS commission_id,
        c.amount                AS commission_amount,
        c.status                AS commission_status,
        c.created_at            AS commission_date,
        c.reversed_at,

        cu.id                   AS customer_id,
        cu.name            AS customer_name,
        cu.phone_number                AS customer_phone,

        t.id                    AS transaction_id,
        t.amount                AS transaction_amount,
        t.transaction_date,

        s.id                    AS staff_id,
        s.full_name             AS staff_name

      FROM commissions c
      LEFT JOIN customers cu ON cu.id = c.customer_id
      LEFT JOIN transactions t ON t.id = c.transaction_id
      LEFT JOIN staff s ON s.id = t.created_by
      WHERE c.company_id = $1
      ORDER BY c.created_at DESC`,
      [companyId]
    );

    return res.status(200).json({
      status: "success",
      data: {
        commissions: result.rows,
      },
    });
  } catch (error) {
    console.error("Error fetching commissions:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch commissions",
    });
  } finally {
    client.release();
  }
};
