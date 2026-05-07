import pool from "../db.mjs";



export const formatStartDate = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

// Format end date to end of the day
export const formatEndDate = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
};


export const generateAccountStatement = async (req, res) => {
  const { accountNumber } = req.params;
  const {
    startDate,
    endDate,
    includePending = false,
    transactionTypes = 'all' 
  } = req.query;

  // Validate required parameters
  if (!accountNumber) {
    return res.status(400).json({
      status: 'fail',
      message: 'Account number is required',
    });
  }

  // Validate date range
  if (startDate && isNaN(new Date(startDate).getTime())) {
    return res.status(400).json({
      status: 'fail',
      message: 'Invalid start date format',
    });
  }

  if (endDate && isNaN(new Date(endDate).getTime())) {
    return res.status(400).json({
      status: 'fail',
      message: 'Invalid end date format',
    });
  }

  const client = await pool.connect();

  try {
    // 1️⃣ First, get the account ID from the account number
    const accountQuery = `
      SELECT 
        a.id,
        a.account_number,
        a.account_type,
        a.balance AS current_balance,
        a.status,
        a.created_at AS account_opened_date,
        c.id AS customer_id,
        c.name AS customer_name,
        c.phone_number,
        c.email,
        c.location,
        c.account_number AS customer_account_number,
        comp.company_name AS company_name,
        comp.company_email AS company_email,
        comp.company_phone AS company_phone,
        comp.company_address AS company_address
      FROM accounts a
      JOIN customers c ON a.customer_id = c.id
      JOIN companies comp ON a.company_id = comp.id
      WHERE a.account_number = $1 AND a.is_deleted = false
    `;

    const accountResult = await client.query(accountQuery, [accountNumber]);

    if (accountResult.rowCount === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'Account not found',
      });
    }

    const account = accountResult.rows[0];
    const accountId = account.id;

    // Format dates for filtering
    const formattedStartDate = startDate ? formatStartDate(startDate) : null;
    const formattedEndDate = endDate ? formatEndDate(endDate) : null;

    // 2️⃣ Get opening balance (balance before start date)
    let openingBalance = 0;
    let openingBalanceDate = null;

    if (formattedStartDate) {
      // Simple query to sum all transactions BEFORE the start date
      const openingBalanceQuery = `
        SELECT 
          COALESCE(SUM(
            CASE 
              WHEN t.type = 'deposit' THEN t.amount
              WHEN t.type = 'transfer_in' THEN t.amount
              WHEN t.type = 'withdrawal' THEN -t.amount
              WHEN t.type = 'transfer_out' THEN -t.amount
              WHEN t.type = 'commission' THEN -t.amount
              ELSE 0
            END
          ), 0) AS balance
        FROM transactions t
        WHERE t.account_id = $1
          AND t.transaction_date < $2
          AND t.is_deleted = false
          AND t.status IN ('approved', 'completed')
      `;
      
      const openingResult = await client.query(openingBalanceQuery, [accountId, formattedStartDate]);
      openingBalance = parseFloat(openingResult.rows[0].balance);
      openingBalanceDate = formattedStartDate;
      
      console.log(`Opening balance before ${formattedStartDate}: ${openingBalance}`);
    }

    // 3️⃣ Build transaction filter conditions
    let whereConditions = [
      't.account_id = $1',
      't.is_deleted = false'
    ];
    
    const queryParams = [accountId];
    let paramIndex = 2;

    // Date range filtering - IMPORTANT: Use the formatted dates
    if (formattedStartDate && formattedEndDate) {
      whereConditions.push(`t.transaction_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
      queryParams.push(formattedStartDate, formattedEndDate);
      paramIndex += 2;
    } else if (formattedStartDate) {
      whereConditions.push(`t.transaction_date >= $${paramIndex}`);
      queryParams.push(formattedStartDate);
      paramIndex++;
    } else if (formattedEndDate) {
      whereConditions.push(`t.transaction_date <= $${paramIndex}`);
      queryParams.push(formattedEndDate);
      paramIndex++;
    }

    // Status filtering (pending/completed)
    if (!includePending || includePending === 'false') {
      whereConditions.push(`t.status IN ('approved', 'completed')`);
    }

    // Transaction type filtering
    if (transactionTypes !== 'all') {
      switch (transactionTypes) {
        case 'deposits':
          whereConditions.push(`t.type = 'deposit'`);
          break;
        case 'withdrawals':
          whereConditions.push(`t.type = 'withdrawal'`);
          break;
        case 'transfers':
          whereConditions.push(`t.type IN ('transfer_in', 'transfer_out')`);
          break;
        default:
          break;
      }
    }

    const whereClause = whereConditions.join(' AND ');

    // 4️⃣ Get all transactions for the date range
    const transactionsQuery = `
      SELECT 
        t.id,
        t.amount,
        t.type,
        t.description,
        t.status,
        t.unique_code,
        t.transaction_date,
        t.payment_method,
        t.withdrawal_type,
        t.created_at,
        t.reversed_at,
        t.reversal_reason,
        t.reversed_by,
        t.source_transaction_id,
        rs.full_name AS reversed_by_name,
        mb.full_name AS created_by_name,
        COALESCE(t.description, 
          CASE 
            WHEN t.type = 'deposit' THEN 'Deposit'
            WHEN t.type = 'withdrawal' THEN 'Withdrawal'
            WHEN t.type = 'transfer_in' THEN 'Transfer In'
            WHEN t.type = 'transfer_out' THEN 'Transfer Out'
            WHEN t.type = 'commission' THEN 'Commission Fee'
            ELSE t.type
          END
        ) AS transaction_description
      FROM transactions t
      LEFT JOIN staff rs ON t.reversed_by = rs.id
      LEFT JOIN staff mb ON t.created_by = mb.id
      WHERE ${whereClause}
      ORDER BY t.transaction_date ASC, t.created_at ASC
    `;

    const transactionsResult = await client.query(transactionsQuery, queryParams);
    
    console.log(`Found ${transactionsResult.rows.length} transactions for date range`);
    console.log(`Date range: ${formattedStartDate} to ${formattedEndDate}`);

    // 5️⃣ Calculate running balance for each transaction
    let runningBalance = openingBalance;
    const statementTransactions = transactionsResult.rows.map(transaction => {
      const amount = parseFloat(transaction.amount);
      let transactionTypeDisplay = '';
      let debit = 0;
      let credit = 0;
      
      // Determine if it's debit or credit
      switch (transaction.type) {
        case 'deposit':
          transactionTypeDisplay = 'DEPOSIT';
          credit = amount;
          runningBalance += amount;
          break;
        case 'transfer_in':
          transactionTypeDisplay = 'TRANSFER IN';
          credit = amount;
          runningBalance += amount;
          break;
        case 'withdrawal':
          transactionTypeDisplay = 'WITHDRAWAL';
          debit = amount;
          runningBalance -= amount;
          break;
        case 'transfer_out':
          transactionTypeDisplay = 'TRANSFER OUT';
          debit = amount;
          runningBalance -= amount;
          break;
        case 'commission':
          transactionTypeDisplay = 'COMMISSION';
          debit = amount;
          runningBalance -= amount;
          break;
        default:
          transactionTypeDisplay = transaction.type.toUpperCase();
          if (amount > 0) {
            credit = amount;
            runningBalance += amount;
          } else {
            debit = Math.abs(amount);
            runningBalance -= Math.abs(amount);
          }
      }
      
      return {
        transaction_id: transaction.id,
        date: transaction.transaction_date,
        description: transaction.transaction_description,
        transaction_type: transaction.type,
        transaction_type_display: transactionTypeDisplay,
        unique_code: transaction.unique_code,
        debit: debit > 0 ? debit.toFixed(2) : '0.00',
        credit: credit > 0 ? credit.toFixed(2) : '0.00',
        balance: runningBalance.toFixed(2),
        status: transaction.status,
        payment_method: transaction.payment_method,
        withdrawal_type: transaction.withdrawal_type,
        reversed: !!transaction.reversed_at,
        reversal_reason: transaction.reversal_reason,
        processed_by: transaction.created_by_name,
        reversed_by: transaction.reversed_by_name
      };
    });

    // 6️⃣ Calculate statement summaries from the transactions in the date range only
    const summary = {
      total_deposits: 0,
      total_withdrawals: 0,
      total_transfer_ins: 0,
      total_transfer_outs: 0,
      total_commissions: 0,
      net_change: 0
    };

    statementTransactions.forEach(tx => {
      const amount = parseFloat(tx.debit !== '0.00' ? tx.debit : tx.credit);
      
      switch (tx.transaction_type) {
        case 'deposit':
          summary.total_deposits += amount;
          break;
        case 'withdrawal':
          summary.total_withdrawals += amount;
          break;
        case 'transfer_in':
          summary.total_transfer_ins += amount;
          break;
        case 'transfer_out':
          summary.total_transfer_outs += amount;
          break;
        case 'commission':
          summary.total_commissions += amount;
          break;
      }
    });
    
    summary.net_change = (summary.total_deposits + summary.total_transfer_ins) - 
                         (summary.total_withdrawals + summary.total_transfer_outs + summary.total_commissions);
    
    const closingBalance = runningBalance;

    // 7️⃣ Build the statement response
    const statement = {
      statement_period: {
        start_date: formattedStartDate,
        end_date: formattedEndDate || new Date().toISOString(),
        generated_on: new Date().toISOString()
      },
      account_info: {
        account_id: account.id,
        account_number: account.account_number,
        account_type: account.account_type,
        account_status: account.status,
        account_opened_date: account.account_opened_date,
        customer_id: account.customer_id,
        customer_name: account.customer_name,
        customer_phone: account.phone_number,
        customer_email: account.email,
        customer_address: account.location || 'Not provided',
        customer_account_number: account.customer_account_number
      },
      bank_info: {
        company_name: account.company_name,
        company_email: account.company_email,
        company_phone: account.company_phone,
        company_address: account.company_address
      },
      balances: {
        opening_balance: openingBalance.toFixed(2),
        closing_balance: closingBalance.toFixed(2),
        current_balance: parseFloat(account.current_balance).toFixed(2),
        opening_balance_date: openingBalanceDate
      },
      summary: {
        total_deposits: summary.total_deposits.toFixed(2),
        total_withdrawals: summary.total_withdrawals.toFixed(2),
        total_transfer_ins: summary.total_transfer_ins.toFixed(2),
        total_transfer_outs: summary.total_transfer_outs.toFixed(2),
        total_commissions: summary.total_commissions.toFixed(2),
        net_change: summary.net_change.toFixed(2),
        total_transactions: statementTransactions.length
      },
      transactions: statementTransactions
    };

    return res.status(200).json({
      status: 'success',
      message: 'Account statement generated successfully',
      data: statement
    });

  } catch (error) {
    console.error('Error generating account statement:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  } finally {
    client.release();
  }
};
// Alternative endpoint that allows filtering by customer (all their accounts)
export const generateCustomerStatement = async (req, res) => {
  const { customerId } = req.params;
  const {
    accountNumber, // optional - specific account
    startDate,
    endDate,
    includePending = false,
    transactionTypes = 'all'
  } = req.query;

  if (!customerId) {
    return res.status(400).json({
      status: 'fail',
      message: 'Customer ID is required',
    });
  }

  const client = await pool.connect();

  try {
    // Get customer accounts
    let accountsQuery = `
      SELECT id, account_number, account_type
      FROM accounts
      WHERE customer_id = $1 AND is_deleted = false
    `;
    const queryParams = [customerId];
    
    if (accountNumber) {
      accountsQuery += ` AND account_number = $2`;
      queryParams.push(accountNumber);
    }
    
    const accountsResult = await client.query(accountsQuery, queryParams);
    
    if (accountsResult.rowCount === 0) {
      return res.status(404).json({
        status: 'fail',
        message: accountNumber ? 'Account not found for this customer' : 'No accounts found for this customer',
      });
    }
    
    // Generate consolidated statement for all accounts or specific one
    const statements = [];
    
    for (const account of accountsResult.rows) {
      // Reuse the generateAccountStatement logic but as internal function
      const statementResult = await generateStatementForAccount(
        client, 
        account.id, 
        { startDate, endDate, includePending, transactionTypes }
      );
      statements.push(statementResult);
    }
    
    // Get customer details
    const customerQuery = `
      SELECT name, phone_number, email, address, account_number
      FROM customers
      WHERE id = $1
    `;
    const customerResult = await client.query(customerQuery, [customerId]);
    const customer = customerResult.rows[0];
    
    return res.status(200).json({
      status: 'success',
      message: 'Customer statement generated successfully',
      data: {
        customer_info: {
          customer_id: customerId,
          customer_name: customer.name,
          customer_phone: customer.phone_number,
          customer_email: customer.email,
          customer_address: customer.address,
          master_account_number: customer.account_number
        },
        statement_period: {
          start_date: startDate ? formatStartDate(startDate) : null,
          end_date: endDate ? formatEndDate(endDate) : new Date().toISOString(),
          generated_on: new Date().toISOString()
        },
        accounts: statements,
        consolidated_summary: statements.reduce((acc, stmt) => {
          acc.total_deposits += parseFloat(stmt.summary.total_deposits);
          acc.total_withdrawals += parseFloat(stmt.summary.total_withdrawals);
          acc.total_transfer_ins += parseFloat(stmt.summary.total_transfer_ins);
          acc.total_transfer_outs += parseFloat(stmt.summary.total_transfer_outs);
          acc.total_commissions += parseFloat(stmt.summary.total_commissions);
          acc.total_balance += parseFloat(stmt.balances.current_balance);
          acc.total_transactions += stmt.summary.total_transactions;
          return acc;
        }, {
          total_deposits: 0,
          total_withdrawals: 0,
          total_transfer_ins: 0,
          total_transfer_outs: 0,
          total_commissions: 0,
          total_balance: 0,
          total_transactions: 0
        })
      }
    });
    
  } catch (error) {
    console.error('Error generating customer statement:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  } finally {
    client.release();
  }
};

// Helper function to generate statement for a single account (internal use)
async function generateStatementForAccount(client, accountId, filters) {
  const { startDate, endDate, includePending, transactionTypes } = filters;
  
  // Get account details
  const accountQuery = `
    SELECT 
      a.id,
      a.account_number,
      a.account_type,
      a.balance AS current_balance,
      a.status,
      a.created_at AS account_opened_date,
      c.name AS customer_name
    FROM accounts a
    JOIN customers c ON a.customer_id = c.id
    WHERE a.id = $1
  `;
  const accountResult = await client.query(accountQuery, [accountId]);
  const account = accountResult.rows[0];
  
  // Build conditions (same as main function)
  let whereConditions = ['t.account_id = $1', 't.is_deleted = false'];
  const queryParams = [accountId];
  let paramIndex = 2;
  
  if (startDate && endDate) {
    whereConditions.push(`t.transaction_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
    queryParams.push(formatStartDate(startDate), formatEndDate(endDate));
    paramIndex += 2;
  } else if (startDate) {
    whereConditions.push(`t.transaction_date >= $${paramIndex}`);
    queryParams.push(formatStartDate(startDate));
    paramIndex++;
  } else if (endDate) {
    whereConditions.push(`t.transaction_date <= $${paramIndex}`);
    queryParams.push(formatEndDate(endDate));
    paramIndex++;
  }
  
  if (!includePending || includePending === 'false') {
    whereConditions.push(`t.status IN ('approved', 'completed')`);
  }
  
  if (transactionTypes !== 'all') {
    switch (transactionTypes) {
      case 'deposits':
        whereConditions.push(`t.type = 'deposit'`);
        break;
      case 'withdrawals':
        whereConditions.push(`t.type = 'withdrawal'`);
        break;
      case 'transfers':
        whereConditions.push(`t.type IN ('transfer_in', 'transfer_out')`);
        break;
    }
  }
  
  // Get opening balance
  let openingBalance = 0;
  if (startDate) {
    const openingQuery = `
      SELECT COALESCE(SUM(
        CASE 
          WHEN t.type = 'deposit' THEN t.amount
          WHEN t.type = 'transfer_in' THEN t.amount
          WHEN t.type = 'withdrawal' THEN -t.amount
          WHEN t.type = 'transfer_out' THEN -t.amount
          WHEN t.type = 'commission' THEN -t.amount
          ELSE 0
        END
      ), 0) AS net_change
      FROM transactions t
      WHERE t.account_id = $1 AND t.transaction_date < $2
        AND t.is_deleted = false AND t.status IN ('approved', 'completed')
    `;
    const openingResult = await client.query(openingQuery, [accountId, formatStartDate(startDate)]);
    openingBalance = parseFloat(account.current_balance) - parseFloat(openingResult.rows[0].net_change);
  }
  
  // Get transactions
  const whereClause = whereConditions.join(' AND ');
  const transactionsQuery = `
    SELECT t.*, mb.full_name AS created_by_name
    FROM transactions t
    LEFT JOIN staff mb ON t.created_by = mb.id
    WHERE ${whereClause}
    ORDER BY t.transaction_date ASC
  `;
  const transactionsResult = await client.query(transactionsQuery, queryParams);
  
  // Calculate running balance
  let runningBalance = openingBalance;
  const transactions = transactionsResult.rows.map(tx => {
    const amount = parseFloat(tx.amount);
    let debit = 0, credit = 0;
    
    switch (tx.type) {
      case 'deposit':
      case 'transfer_in':
        credit = amount;
        runningBalance += amount;
        break;
      case 'withdrawal':
      case 'transfer_out':
      case 'commission':
        debit = amount;
        runningBalance -= amount;
        break;
    }
    
    return {
      date: tx.transaction_date,
      description: tx.description || tx.type,
      transaction_type: tx.type,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      balance: runningBalance.toFixed(2),
      status: tx.status,
      reference: tx.unique_code
    };
  });
  
  const closingBalance = runningBalance;
  
  return {
    account_info: {
      account_id: account.id,
      account_number: account.account_number,
      account_type: account.account_type,
      account_status: account.status,
      customer_name: account.customer_name
    },
    balances: {
      opening_balance: openingBalance.toFixed(2),
      closing_balance: closingBalance.toFixed(2),
      current_balance: parseFloat(account.current_balance).toFixed(2)
    },
    summary: {
      total_transactions: transactions.length,
      net_change: (closingBalance - openingBalance).toFixed(2)
    },
    transactions
  };
}