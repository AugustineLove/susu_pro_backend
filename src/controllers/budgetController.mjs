import pool from "../db.mjs";

export const getFloatActivity = async (req, res) => {
  const { id } = req.params;
    console.log("Fetching float activity for budget ID:", id);
  const { rows } = await pool.query(
    `
    SELECT
  fm.id AS movement_id,
  fm.source_type,
  fm.amount,
  fm.created_at,

  /* =========================
     WITHDRAWAL DATA
  ========================== */
  t.id AS transaction_id,
  t.status AS transaction_status,
  t.amount AS withdrawal_amount,

  c.name AS customer_name,
  c.account_number,

  -- Mobile banker (who initiated it)
  mb.id AS mobile_banker_id,
  mb.full_name AS mobile_banker_name,

  -- Staff who recorded / approved it
  rs.id AS recorded_staff_id,
  rs.full_name AS recorded_staff_name,

  /* =========================
     EXPENSE DATA
  ========================== */
  e.id AS expense_id,
  e.description AS expense_description,
  e.amount AS expense_amount,

  es.id AS expense_staff_id,
  es.full_name AS expense_staff_name

FROM float_movements fm

/* =========================
   WITHDRAWALS
========================= */
LEFT JOIN transactions t
  ON fm.source_type = 'withdrawal'
 AND fm.source_id = t.id

LEFT JOIN accounts a 
  ON t.account_id = a.id

LEFT JOIN customers c 
  ON a.customer_id = c.id

-- Mobile banker
LEFT JOIN staff mb 
  ON t.created_by = mb.id

-- Recording staff
LEFT JOIN staff rs 
  ON t.staff_id = rs.id

/* =========================
   EXPENSES
========================= */
LEFT JOIN expenses e
  ON fm.source_type = 'expense'
 AND fm.source_id = e.id

LEFT JOIN staff es 
  ON e.recorded_by = es.id

WHERE fm.budget_id = $1
ORDER BY fm.created_at DESC;
    `,
    [id]
  );

  res.json({
    status: "success",
    data: rows,
  });
};
