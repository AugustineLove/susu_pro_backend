export const checkDayNotClosed = async (req, res, next) => {
  const { company_id } = req.body;

  if (!company_id) {
    return res.status(400).json({
      status: "fail",
      message: "company_id is required",
    });
  }

  try {
    // 🧠 Detect date from multiple possible fields
    const possibleDates = [
      req.body.transaction_date,
      req.body.registration_date,
      req.body.date_sent,
      req.body.disbursement_date,
      req.body.start_date,
    ];

    // pick the first valid one
    const rawDate = possibleDates.find((d) => d);

    // fallback to today if none provided
    const date = new Date(rawDate || new Date()).toLocaleDateString('en-CA');

    const result = await pool.query(
      `SELECT 1 FROM day_end_logs
       WHERE company_id = $1
       AND report_date = $2
       LIMIT 1`,
      [company_id, date]
    );

    if (result.rowCount > 0) {
      return res.status(403).json({
        status: "fail",
        message: `Day is closed for ${date}. Action not allowed.`,
      });
    }

    next();
  } catch (error) {
    console.error("checkDayNotClosed error:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal validation error",
    });
  }
};