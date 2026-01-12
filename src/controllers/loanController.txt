import pool from '../db.mjs';

export const createLoan = async (req, res) => {
  const {
    id,
    customer_id,
    loan_type,
    amount,
    disbursed_amount,
    interest_rate,
    tenure,
    monthly_payment,
    total_payable,
    amount_paid,
    outstanding_balance,
    status,
    disbursement_date,
    maturity_date,
    next_payment_date,
    days_overdue,
    collateral,
    purpose,
    guarantor,
    mobile_banker,
    credit_score,
    risk_level,
    company_id,
    created_by,
    created_by_type
  } = req.body;

  if (!customer_id || !amount || !company_id || !created_by || !created_by_type) {
    return res.status(400).json({
      status: "fail",
      message: "customer_id, amount, company_id, created_by, and created_by_type are required"
    });
  }

  try {
    const insertQuery = `
      INSERT INTO loans (
        id, customer_id, loan_type, amount, disbursed_amount,
        interest_rate, tenure, monthly_payment, total_payable,
        amount_paid, outstanding_balance, status, disbursement_date,
        maturity_date, next_payment_date, days_overdue, collateral,
        purpose, guarantor, mobile_banker, credit_score, risk_level,
        company_id, created_by, created_by_type
      )
      VALUES (
        $1, $2, $3, $4, $5, 
        $6, $7, $8, $9, $10, 
        $11, $12, $13, $14, $15, 
        $16, $17, $18, $19, $20, 
        $21, $22, $23, $24, $25
      )
      RETURNING *;
    `;

    const values = [
      id,
      customer_id,
      loan_type,
      amount,
      disbursed_amount,
      interest_rate,
      tenure,
      monthly_payment,
      total_payable,
      amount_paid,
      outstanding_balance,
      status,
      disbursement_date,
      maturity_date,
      next_payment_date,
      days_overdue,
      collateral,
      purpose,
      guarantor,
      mobile_banker,
      credit_score,
      risk_level,
      company_id,
      created_by,
      created_by_type
    ];

    const result = await pool.query(insertQuery, values);

    return res.status(201).json({
      status: "success",
      message: "Loan created successfully",
      data: result.rows[0]
    });
  } catch (error) {
    console.error("Error creating loan:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error"
    });
  }
};
