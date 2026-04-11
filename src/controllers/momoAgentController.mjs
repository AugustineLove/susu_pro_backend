export const getPendingMomoWithdrawals = async (req, res) => {
  const { company_id } = req.query;

  if (!company_id) {
    return res.status(400).json({ status: "fail", message: "company_id is required" });
  }

  try {
    const result = await pool.query(
      `SELECT 
        t.id AS transaction_id,
        t.amount,
        t.status,
        t.processing_status,
        t.withdrawal_type,
        t.payment_method,
        t.transaction_date,
        t.unique_code,

        a.id AS account_id,
        a.account_number,
        a.account_type,

        c.name AS customer_name,
        c.phone_number AS customer_phone

       FROM transactions t
       JOIN accounts a ON t.account_id = a.id
       JOIN customers c ON a.customer_id = c.id
       WHERE t.company_id = $1
         AND t.type = 'withdrawal'
         AND t.status = 'pending'
         AND t.payment_method = 'momo'
         AND t.is_deleted = false
       ORDER BY t.transaction_date ASC`,
      [company_id]
    );

    return res.status(200).json({
      status: "success",
      results: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error("Error fetching pending momo withdrawals:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};


export const updateWithdrawalProcessingStatus = async (req, res) => {
  const { transactionId } = req.params;
  const { processing_status, agent_note, agent_id } = req.body;

  const allowed = ["sent", "failed"];
  if (!processing_status || !allowed.includes(processing_status)) {
    return res.status(400).json({
      status: "fail",
      message: `processing_status must be one of: ${allowed.join(", ")}`,
    });
  }

  if (!agent_id) {
    return res.status(400).json({ status: "fail", message: "agent_id is required" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const txRes = await client.query(
      `SELECT id, type, status, payment_method
       FROM transactions WHERE id = $1`,
      [transactionId]
    );

    if (txRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "Transaction not found" });
    }

    const tx = txRes.rows[0];

    if (tx.type !== "withdrawal" || tx.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Only pending withdrawals can be updated",
      });
    }

    if (tx.payment_method !== "momo") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "This endpoint is only for momo withdrawals",
      });
    }

    await client.query(
      `UPDATE transactions
       SET processing_status = $1,
           agent_note = $2,
           processed_by = $3,
           processed_at = NOW()
       WHERE id = $4`,
      [processing_status, agent_note || null, agent_id, transactionId]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: `Withdrawal marked as ${processing_status}`,
      transaction_id: transactionId,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating processing status:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  } finally {
    client.release();
  }
};

export const getWithdrawalById = async (req, res) => {
  const { transactionId } = req.params;
  const { company_id } = req.query;

  try {
    const result = await pool.query(
      `SELECT 
        t.id AS transaction_id,
        t.amount,
        t.status,
        t.processing_status,
        t.payment_method,
        t.withdrawal_type,
        t.transaction_date,
        t.agent_note,
        t.processed_at,

        a.account_number,
        a.account_type,

        c.name AS customer_name,
        c.phone_number AS customer_phone

       FROM transactions t
       JOIN accounts a ON t.account_id = a.id
       JOIN customers c ON a.customer_id = c.id
       WHERE t.id = $1
         AND t.company_id = $2
         AND t.type = 'withdrawal'
         AND t.is_deleted = false`,
      [transactionId, company_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ status: "fail", message: "Withdrawal not found" });
    }

    return res.status(200).json({ status: "success", data: result.rows[0] });
  } catch (error) {
    console.error("Error fetching withdrawal:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};