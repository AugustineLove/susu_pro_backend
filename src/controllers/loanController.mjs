import pool from "../db.mjs";
import { calculateLoan } from "./calculations.mjs";

export const getAllLoans = async (req, res) => {
    const { companyId } = req.params;
    console.log(companyId)

  try {

    const result = await pool.query(
       `
        SELECT 
            l.*, 
            c.name AS customer_name, 
            c.phone_number AS customer_phone, 
            c.email AS customer_email
        FROM loans l
        LEFT JOIN customers c 
            ON l.customer_id = c.id
        WHERE l.company_id = $1
        ORDER BY l.created_at DESC
        `,
        [companyId]
    );


    return res.status(200).json({
      status: 'success',
      results: result.rowCount,
      data: result.rows
    });


  } catch (error) {

    console.error('Error fetching loans:', error.message);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

export const approveLoan = async (req, res) => {
  console.log("Approving loan:", req.body);

  const {
    loanId,
    approvedby,
    created_by_type,
    disbursedamount,
    interestrateloan,
    loanterm,
    disbursementdate,
    interestmethod
  } = req.body;

  const finalDisbursementDate =
    disbursementdate && disbursementdate.trim() !== ""
      ? disbursementdate
      : new Date().toISOString().split("T")[0];
    
      const totalpayable = calculateLoan(disbursedAmount, interestrateloan, loanterm, disbursementdate, interestmethod)


  if (
    !loanId ||
    !approvedby ||
    !created_by_type ||
    !disbursedamount ||
    !interestrateloan ||
    !loanterm
  ) {
    return res.status(400).json({
      status: "fail",
      message: "Missing required approval fields",
    });
  }

  const disbursedAmount = Number(disbursedamount);
  const interestRate = Number(interestrateloan);
  const loanTerm = Number(loanterm);

  if (
    disbursedAmount <= 0 ||
    interestRate <= 0 ||
    loanTerm <= 0
  ) {
    return res.status(400).json({
      status: "fail",
      message: "Invalid loan approval values",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ===== FETCH & LOCK LOAN =====
    const loanRes = await client.query(
      `SELECT * FROM loans WHERE id = $1 FOR UPDATE`,
      [loanId]
    );

    if (loanRes.rows.length === 0) {
      throw new Error("Loan not found");
    }

    const loan = loanRes.rows[0];

    if (loan.status === "approved" || loan.status === "active") {
      throw new Error("Loan already approved");
    }

    // ===== FETCH CUSTOMER NORMAL ACCOUNT =====
    const accountRes = await client.query(
      `
      SELECT * FROM accounts
      WHERE customer_id = $1
        AND account_type = 'Normal'
        AND is_deleted = false
      LIMIT 1
      FOR UPDATE
      `,
      [loan.customer_id]
    );

    if (accountRes.rows.length === 0) {
      throw new Error("Customer normal account not found");
    }

    const normalAccount = accountRes.rows[0];

    // ===== UPDATE LOAN (ACTIVATE & SET BALANCE) =====
    const updatedLoanRes = await client.query(
      `
      UPDATE loans
      SET
        status = 'active',
        disbursedamount = $1,
        interestrateloan = $2,
        loanterm = $3,
        disbursementdate = $4,
        balance = $1,
        approved_by = $5,
        approved_by_type = $6,
        approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP,
        totalpayable = $7
      WHERE id = $8
      RETURNING *
      `,
      [
        disbursedAmount,
        interestRate,
        loanTerm,
        finalDisbursementDate,
        approvedby,
        created_by_type,
        totalpayable,
        loanId,
      ]
    );

    const updatedAccountRes = await client.query(
      `
      UPDATE accounts
      SET
        balance = balance + $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [disbursedAmount, normalAccount.id]
    );

    // ===== LOAN TRANSACTION LOG =====
    await client.query(
      `
      INSERT INTO loan_transactions (
        loan_id,
        amount,
        type,
        created_by,
        created_by_type,
        created_at,
        account_id,
        customer_id
      )
      VALUES ($1, $2, 'disbursement', $3, $4, CURRENT_TIMESTAMP, $5, $6)
      `,
      [
        loanId,
        disbursedAmount,
        approvedby,
        created_by_type,
        normalAccount.id,
        normalAccount.customer_id
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Loan approved and disbursed successfully",
      data: {
        loan: updatedLoanRes.rows[0],
        account: updatedAccountRes.rows[0],
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("Error approving loan:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });

  } finally {
    client.release();
  }
};
