import pool from "../db.mjs";

export const createAccount = async (req, res) => {

  const { 
    customer_id, 
    account_type, 
    created_by, 
    company_id, 
    created_by_type,

    // general
    initial_deposit = 0,
    daily_rate, 
    frequency, 
    minimum_balance, 
    interest_rate, 

    // loan payload from form
    interestRateLoan,
    interestRate,          // you said you’ll use this one
    loanTerm,
    duration,
    collateral,
    guarantor,
    guarantorPhone,
    loanType,
    loanAmount,
    purpose,
    disbursedAmount,
    disbursementDate,
    maturityDate,
    monthlypayment,
    totalpayable,
    amountpaid,
    outstandingbalance,
    interestmethod
  } = req.body;


  console.log(req.body);

  if (!customer_id || !account_type || !created_by || !company_id || !created_by_type) {
    return res.status(400).json({
      status: 'fail',
      message: 'customer_id, account_type, created_by, company_id, and created_by_type are required',
    });
  }


  // ===== START PROCESS =====

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    let normalAccount;

    // force creation of normal account when loan
    if (account_type === 'loan') {

      const normalFields = [
        "customer_id",
        "account_type",
        "created_by",
        "company_id",
        "created_by_type",
        "balance"
      ];

      const normalValues = [
        customer_id,
        'Normal',               
        created_by,
        company_id,
        created_by_type,
        0 
      ];

      const normalPlaceholders = normalValues.map((_, i) => `$${i + 1}`);

      const normalQuery = `
        INSERT INTO accounts (${normalFields.join(", ")})
        VALUES (${normalPlaceholders.join(", ")})
        RETURNING *
      `;

      const normalResult = await client.query(normalQuery, normalValues);

      normalAccount = normalResult.rows[0];

      normalAccount = normalAccount;

    } else {

      // if not loan → create account dynamically like you had
      const fields = [
        "customer_id",
        "account_type",
        "created_by",
        "company_id",
        "created_by_type",
        "interest_rate",
        "description",
        "balance"
      ];

      const values = [
        customer_id,
        account_type,
        created_by,
        company_id,
        created_by_type,
        interestRate || 0,
        purpose || '',
        initial_deposit
      ];

      const placeholders = values.map((_, i) => `$${i + 1}`);
      if (daily_rate !== undefined) {
        fields.push("daily_rate");
        values.push(daily_rate);
        placeholders.push(`$${values.length}`);
      }

      if (frequency !== undefined) {
        fields.push("frequency");
        values.push(frequency);
        placeholders.push(`$${values.length}`);
      }

      if (minimum_balance !== undefined) {
        fields.push("minimum_balance");
        values.push(minimum_balance);
        placeholders.push(`$${values.length}`);
      }

      if (interest_rate !== undefined) {
        fields.push("interest_rate");
        values.push(interest_rate);
        placeholders.push(`$${values.length}`);
      }


      const query = `
        INSERT INTO accounts (${fields.join(", ")})
        VALUES (${placeholders.join(", ")})
        RETURNING *
      `;

      const result = await client.query(query, values);

      normalAccount = result.rows[0];
    }

    let loanRecord = null;

    if (account_type === 'loan') {

      if (!loanAmount || !duration) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 'fail',
          message: 'loanAmount and loanTerm are required for loan accounts',
        });
      }



      const loanQuery = `
        INSERT INTO loans (
          id,
          customer_id,
          loanType,
          loanAmount,
          disbursedAmount,
          interestRateLoan,
          loanTerm,
          collateral,
          guarantor,
          guarantorPhone,
          mobile_banker,
          purpose,
          disbursementDate,
          maturityDate,
          company_id,
          created_by,
          created_by_type,
          status,
          monthlypayment,
          totalpayable,
          amountpaid,
          outstandingbalance,
          interestmethod
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
        )
        RETURNING *
      `;


      const params = [
        `LN-${Date.now()}`,        // loan id
        customer_id,
        loanType,
        parseFloat(loanAmount),
        disbursedAmount ? parseFloat(disbursedAmount) : parseFloat(loanAmount),
        interestRate ? parseFloat(interestRate) : null,
        duration,
        collateral || null,
        guarantor || null,
        guarantorPhone || null,
        created_by,              
        purpose || null,
        disbursementDate || null,
        maturityDate || null,
        company_id,
        created_by,
        created_by_type,
        'requested',
        monthlypayment,
        totalpayable,
        amountpaid,
        outstandingbalance,
        interestmethod
      ];


      const loanResult = await client.query(loanQuery, params);

      loanRecord = loanResult.rows[0];
    }



    await client.query("COMMIT");

    return res.status(201).json({
      status: 'success',
      message: 'Process completed successfully',
      data: {
        account: normalAccount,
        loan: loanRecord
      }
    });



  } catch (error) {

    await client.query("ROLLBACK");

    console.error('Error creating account:', error.message);

    return res.status(500).json({
      status: 'error',
      message: error.message,
    });

  } finally {
    client.release();
  }
};


export const getAccountsByCustomer = async (req, res) => {

  const { customerId } = req.params;

  try {

    const accounts = await pool.query(
      `
      SELECT 
        a.*,

        -- loan fields (if they exist)
        l.id              AS loan_id,
        l.loanType,
        l.loanAmount,
        l.disbursedAmount,
        l.interestRateLoan,
        l.loanTerm,
        l.collateral,
        l.guarantor,
        l.guarantorPhone,
        l.mobile_banker,
        l.purpose,
        l.disbursementDate,
        l.maturityDate,
        l.status          AS loan_status,
        l.outstandingBalance,
        l.amountPaid,
        l.monthlyPayment,
        l.totalPayable,
        l.days_overdue

      FROM accounts a

      LEFT JOIN loans l
        ON a.customer_id = l.customer_id

      WHERE a.customer_id = $1
        AND a.is_deleted = false
      `,
      [customerId]
    );



    if (accounts.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No accounts or loans found for this customer.',
      });
    }

    const accountList = [];
    const loanList = [];

    for (const row of accounts.rows) {

      // push account only once
      accountList.push(row);


      if (row.loan_id) {

        loanList.push({
          id: row.loan_id,
          loanType: row.loantype,
          loanAmount: row.loanamount,
          disbursedAmount: row.disbursedamount,
          interestRateLoan: row.interestrateloan,
          loanTerm: row.loanterm,
          collateral: row.collateral,
          guarantor: row.guarantor,
          guarantorPhone: row.guarantorphone,
          mobile_banker: row.mobile_banker,
          purpose: row.purpose,
          disbursementDate: row.disbursementdate,
          maturityDate: row.maturitydate,
          status: row.loan_status,
          outstandingBalance: row.outstandingbalance,
          amountPaid: row.amountpaid,
          monthlyPayment: row.monthlypayment,
          totalPayable: row.totalpayable,
          daysOverdue: row.days_overdue
        });
      }
    }



    return res.status(200).json({
      status: 'success',
      results: accountList.length,
      data: {
        accounts: accountList,
        loans: loanList
      }
    });



  } catch (error) {

    console.error('Error fetching customer accounts:', error.message);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};