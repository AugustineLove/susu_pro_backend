// controllers/transactionController.mjs
import pool from '../db.mjs';

import {
  postJournalEntry,
  resolveCOA,
  cashCoaCode,
  depositCoaCode,
} from "../services/accountingHelper.mjs";


export const getTransactionsByAccount = async (req, res) => {
  const { account_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, amount, type, description, transaction_date, created_by, company_id 
       FROM transactions 
       WHERE account_id = $1 AND is_deleted = false
       ORDER BY transaction_date DESC`,
      [account_id]
    );

    return res.status(200).json({
      status: 'success',
      results: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching account transactions:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};


export const getTransactionsByStaff = async (req, res) => {
  const { staff_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT 
    t.id,
    t.amount,
    t.type,
    t.description,
    t.status,
    t.transaction_date,
    t.account_id,
    t.company_id,
    a.account_type,
    c.company_name,
    s.full_name,
    cu.location AS customer_location,
    cu.name AS customer_name
FROM transactions t
JOIN accounts a ON t.account_id = a.id
JOIN companies c ON t.company_id = c.id
JOIN staff s ON t.created_by = s.id
JOIN customers cu ON a.customer_id = cu.id
WHERE t.created_by = $1 AND t.is_deleted = false
ORDER BY t.transaction_date DESC;
`,
      [staff_id]
    );

    return res.status(200).json({
      status: 'success',
      results: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching staff transactions:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getTransactionsByCustomer = async (req, res) => {
  const { customerId } = req.params;
  console.log(customerId)
  try {
    // Get all account IDs for the customer
    const accountsResult = await pool.query(
      'SELECT id FROM accounts WHERE customer_id = $1 AND is_deleted = false',
      [customerId]
    );

    if (accountsResult.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No accounts found for this customer.',
      });
    }

    const accountIds = accountsResult.rows.map((acc) => acc.id);

    // Fetch transactions for those account IDs
    const transactionsResult = await pool.query(
      `SELECT t.*, a.account_type,
      rs.id AS recorded_staff_id,
      rs.full_name as recorded_staff_name,
      str.full_name as reversed_by_name
      FROM transactions t
      LEFT JOIN staff rs ON t.staff_id = rs.id
      LEFT JOIN staff str ON t.reversed_by = str.id
      JOIN accounts a ON t.account_id = a.id
      WHERE t.account_id = ANY($1::uuid[])
      ORDER BY t.transaction_date DESC;`,
      [accountIds]
    );

    return res.status(200).json({
      status: 'success',
      results: transactionsResult.rowCount,
      data: transactionsResult.rows,
    });
  } catch (error) {
    console.error('Error fetching customer transactions:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};


export const getCompanyTransactions = async (req, res) => {
  const { company_id } = req.params;

  if (!company_id) {
    return res.status(400).json({
      status: 'fail',
      message: 'Company ID is required',
    });
  }

  try {
    const result = await pool.query(
      `SELECT t.*, a.account_type, c.name AS customer_name, s.full_name AS staff_name
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN customers c ON a.customer_id = c.id
       LEFT JOIN staff s ON t.created_by = s.id
       WHERE t.company_id = $1 AND t.is_deleted = false
       ORDER BY t.transaction_date DESC`,
      [company_id]
    );

    return res.status(200).json({
      status: 'success',
      transactions: result.rows,
    });
  } catch (error) {
    console.error('Error fetching company transactions:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};
export const getRecentTransactions = async (req, res) => {
  try {
    const { company_id } = req.params;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // Filters
    const { search, type, status, staff, startDate, endDate } = req.query;

    let whereConditions = ["t.company_id = $1", "t.type != 'withdrawal'" ];
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

    // 💰 Type
    if (type && type !== "all") {
      whereConditions.push(`t.type = $${paramIndex}`);
      values.push(type);
      paramIndex++;
    }

    // 📌 Status
    if (status && status !== "all") {
      whereConditions.push(`t.status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    // 👤 Staff
    if (staff && staff !== "all") {
      whereConditions.push(`rs.id = $${paramIndex}`);
      values.push(staff);
      paramIndex++;
    }

    // 📅 Date filtering using startDate & endDate
    if (startDate && endDate) {
      whereConditions.push(`t.transaction_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
      values.push(formatStartDate(startDate), formatEndDate(endDate));
      paramIndex += 2;
    } else if (startDate) {
      whereConditions.push(`t.transaction_date >= $${paramIndex}`);
      values.push(formatStartDate(startDate));
      paramIndex++;
    } else if (endDate) {
      whereConditions.push(`t.transaction_date <= $${paramIndex}`);
      values.push(formatEndDate(endDate));
      paramIndex++;
    }

    const whereClause =
      whereConditions.length > 0
        ? "WHERE " + whereConditions.join(" AND ")
        : "";

    // Determine if searching/filtering
    const isSearching = !!(
      search ||
      (type && type !== "all") ||
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
        t.type,
        t.description,
        t.status,
        t.unique_code,
        t.transaction_date,
        t.reversed_at,
        t.reversal_reason,
        t.reversed_by,
        t.is_deleted,
        t.withdrawal_type,
        t.payment_method,
        t.processing_status,
        t.processed_by, 
        t.processed_at,
        t.payment_reference,
        t.agent_note,

        a.id AS account_id,
        a.customer_id,
        a.account_type,
        a.account_number,

        c.name AS customer_name,
        c.phone_number AS customer_phone,
        c.account_number AS customer_account_number,

        mb.id AS mobile_banker_id,
        mb.full_name AS mobile_banker_name,

        rs.id AS recorded_staff_id,
        rs.full_name AS recorded_staff_name,

        str.full_name AS reversed_by_name

      FROM transactions t
      LEFT JOIN staff str ON t.reversed_by = str.id
      LEFT JOIN staff mb ON t.created_by = mb.id
      LEFT JOIN staff rs ON t.staff_id = rs.id
      JOIN accounts a ON t.account_id = a.id
      JOIN customers c ON a.customer_id = c.id
      ${whereClause}
      ORDER BY t.transaction_date DESC
    `;

    const queryValues = [...values];

    // Pagination only if NOT searching
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
    console.error("Error fetching recent transactions:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to fetch transactions",
    });
  }
};

// Format start date to beginning of the day
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

export const approveTransaction = async (req, res) => {
  const transactionId = req.params.id;
  const { teller_id } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =====================================================
    // 1. FETCH & VALIDATE TRANSACTION
    // =====================================================

    const txRes = await client.query(
      `
      SELECT
        id,
        account_id,
        amount,
        type,
        status,
        created_by,
        payment_method,
        accounting_je_id
      FROM transactions
      WHERE id = $1
      FOR UPDATE
      `,
      [transactionId]
    );

    if (txRes.rowCount === 0) {
      throw new Error("Transaction not found");
    }

    const tx = txRes.rows[0];

    if (
      tx.type !== "withdrawal" ||
      tx.status !== "pending"
    ) {
      throw new Error(
        "Only pending withdrawal transactions can be approved"
      );
    }

    const amount = parseFloat(tx.amount);

    if (isNaN(amount) || amount <= 0) {
      throw new Error("Invalid withdrawal amount");
    }

    // =====================================================
    // 2. FETCH ACCOUNT
    // =====================================================

    const accRes = await client.query(
      `
      SELECT
        a.id,
        a.balance,
        a.company_id,
        a.account_type,
        a.customer_id
      FROM accounts a
      WHERE a.id = $1
      FOR UPDATE
      `,
      [tx.account_id]
    );

    if (accRes.rowCount === 0) {
      throw new Error("Associated account not found");
    }

    const account = accRes.rows[0];

    const currentBalance = parseFloat(
      account.balance || 0
    );

    if (amount > currentBalance) {
      throw new Error(
        "Insufficient customer account balance"
      );
    }

    // =====================================================
    // 3. VERIFY TELLER FLOAT BALANCE
    // =====================================================

    /**
     * IMPORTANT:
     * We ONLY validate teller float here.
     *
     * We DO NOT manually deduct float balance,
     * because the accounting journal entry will
     * automatically credit/reduce the teller float.
     */

    const tellerFloatCode = "1010-02";

/**
 * Fetch teller float balance dynamically
 * from posted journal entries
 */
const tellerFloatRes = await client.query(
  `
  SELECT
    coa.id,
    coa.code,
    coa.name,
    coa.normal_balance,

    CASE coa.normal_balance

      WHEN 'debit' THEN
        COALESCE(SUM(jel.amount)
          FILTER (
            WHERE jel.debit_credit = 'debit'
          ), 0)
        -
        COALESCE(SUM(jel.amount)
          FILTER (
            WHERE jel.debit_credit = 'credit'
          ), 0)

      WHEN 'credit' THEN
        COALESCE(SUM(jel.amount)
          FILTER (
            WHERE jel.debit_credit = 'credit'
          ), 0)
        -
        COALESCE(SUM(jel.amount)
          FILTER (
            WHERE jel.debit_credit = 'debit'
          ), 0)

            END AS balance

          FROM chart_of_accounts coa

          LEFT JOIN (
            journal_entry_lines jel
            INNER JOIN journal_entries je
              ON je.id = jel.journal_entry_id
              AND je.status = 'posted'
              AND je.company_id = $1
          )
            ON jel.coa_id = coa.id

          WHERE coa.company_id = $1
            AND coa.code = $2
            AND coa.is_active = true
            AND coa.is_deleted = false

          GROUP BY coa.id

          LIMIT 1
          `,
          [account.company_id, tellerFloatCode]
        );

        if (tellerFloatRes.rowCount === 0) {
          throw new Error(
            "Teller float account (1010-02) not found"
          );
        }

        const tellerFloat = tellerFloatRes.rows[0];

        const tellerFloatBalance = parseFloat(
          tellerFloat.balance || 0
        );

        if (tellerFloatBalance < amount) {
          throw new Error(
            `Insufficient teller float balance. Available float: GHS ${tellerFloatBalance.toFixed(
              2
            )}`
          );
        }

    // =====================================================
    // 4. UPDATE CUSTOMER ACCOUNT BALANCE
    // =====================================================

    const updatedCustomerBalance =
      currentBalance - amount;

    await client.query(
      `
      UPDATE accounts
      SET
        balance = $1,
        last_activity_at = NOW(),
        updated_at = NOW()
      WHERE id = $2
      `,
      [updatedCustomerBalance, account.id]
    );

    // =====================================================
    // 5. APPROVE TRANSACTION
    // =====================================================

    const approverId =
      teller_id || tx.created_by;

    await client.query(
      `
      UPDATE transactions
      SET
        status = 'approved',
        approved_by = $1,
        approved_at = NOW(),
        updated_at = NOW()
      WHERE id = $2
      `,
      [approverId, tx.id]
    );

    // =====================================================
    // 6. FLOAT MOVEMENT TRACKING
    // =====================================================

    const today = new Date()
      .toISOString()
      .split("T")[0];

    const budgetRes = await client.query(
      `
      SELECT
        id,
        allocated,
        spent
      FROM budgets
      WHERE company_id = $1
        AND date = $2
      ORDER BY id ASC
      `,
      [account.company_id, today]
    );

    let remaining = amount;

    if (budgetRes.rowCount > 0) {
      for (const budget of budgetRes.rows) {
        if (remaining <= 0) break;

        const allocated = parseFloat(
          budget.allocated || 0
        );

        const spent = parseFloat(
          budget.spent || 0
        );

        const available = allocated - spent;

        if (available <= 0) continue;

        const deducted = Math.min(
          remaining,
          available
        );

        remaining -= deducted;

        await client.query(
          `
          UPDATE budgets
          SET
            spent = spent + $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [deducted, budget.id]
        );

        await client.query(
          `
          INSERT INTO float_movements (
            budget_id,
            company_id,
            source_type,
            source_id,
            amount,
            direction,
            created_at
          )
          VALUES (
            $1,
            $2,
            'withdrawal',
            $3,
            $4,
            'debit',
            NOW()
          )
          `,
          [
            budget.id,
            account.company_id,
            tx.id,
            deducted,
          ]
        );
      }

      // Overflow handling
      if (remaining > 0) {
        await client.query(
          `
          UPDATE budgets
          SET
            spent = spent + $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            remaining,
            budgetRes.rows[0].id,
          ]
        );

        await client.query(
          `
          INSERT INTO float_movements (
            budget_id,
            company_id,
            source_type,
            source_id,
            amount,
            direction,
            created_at
          )
          VALUES (
            $1,
            $2,
            'withdrawal',
            $3,
            $4,
            'debit',
            NOW()
          )
          `,
          [
            budgetRes.rows[0].id,
            account.company_id,
            tx.id,
            remaining,
          ]
        );
      }
    } else {
      // Create fallback budget record
      const newBudget = await client.query(
        `
        INSERT INTO budgets (
          company_id,
          date,
          allocated,
          spent,
          status,
          created_at
        )
        VALUES (
          $1,
          $2,
          0,
          $3,
          'Active',
          NOW()
        )
        RETURNING id
        `,
        [
          account.company_id,
          today,
          amount,
        ]
      );

      await client.query(
        `
        INSERT INTO float_movements (
          budget_id,
          company_id,
          source_type,
          source_id,
          amount,
          direction,
          created_at
        )
        VALUES (
          $1,
          $2,
          'withdrawal',
          $3,
          $4,
          'debit',
          NOW()
        )
        `,
        [
          newBudget.rows[0].id,
          account.company_id,
          tx.id,
          amount,
        ]
      );
    }

    // =====================================================
    // 7. ACCOUNTING JOURNAL ENTRY
    // =====================================================

    const cashCode = cashCoaCode(
      tx.payment_method
    );

    const depositCode = depositCoaCode(
      account.account_type
    );

    const cashCoaId = await resolveCOA(
      client,
      account.company_id,
      cashCode
    );

    const depositCoaId = await resolveCOA(
      client,
      account.company_id,
      depositCode
    );

    const entryDate = new Date()
      .toISOString()
      .slice(0, 10);

    if (tx.accounting_je_id) {
      // Post existing draft journal entry
      await client.query(
        `
        UPDATE journal_entries
        SET
          status = 'posted',
          posted_by = $1,
          posted_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
          AND status = 'draft'
        `,
        [approverId, tx.accounting_je_id]
      );
    } else {
      // Create and post fresh JE
      await postJournalEntry(client, {
        companyId: account.company_id,
        description: `Withdrawal approved for account ${account.id}`,
        entryDate,
        source: "customer_withdrawal",
        sourceId: tx.id,
        sourceTable: "transactions",
        createdBy: approverId,

        lines: [
          {
            coaId: depositCoaId,
            dc: "debit",
            amount,
            description:
              "Customer deposit liability reduced on withdrawal",
            customerId: account.customer_id,
            accountId: account.id,
            staffId: approverId,
          },
          {
            coaId: cashCoaId,
            dc: "credit",
            amount,
            description:
              "Cash/teller float paid out to customer",
            customerId: account.customer_id,
            accountId: account.id,
            staffId: approverId,
          },
        ],
      });
    }

    // =====================================================
    // 8. COMMIT
    // =====================================================

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message:
        "Withdrawal approved successfully",
      data: {
        transaction_id: tx.id,
        withdrawn_amount: amount,
        previous_balance: currentBalance,
        new_balance: updatedCustomerBalance,
        teller_float_available:
          tellerFloatBalance,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(
      "approveTransaction error:",
      err.message
    );

    return res.status(400).json({
      status: "fail",
      message:
        err.message ||
        "Failed to approve withdrawal",
    });
  } finally {
    client.release();
  }
};


export const rejectTransaction = async (req, res) => {
  const transactionId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Fetch transaction
    const txRes = await client.query(
      `SELECT id, type, status, accounting_je_id
       FROM transactions WHERE id = $1 FOR UPDATE`,
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
        message: "Only pending withdrawals can be rejected",
      });
    }

    // 2. Cancel the draft journal entry that was parked by stakeMoney.
    //    We mark it 'reversed' (rather than deleting) so the audit
    //    trail shows it existed and was voided.
    if (tx.accounting_je_id) {
      await client.query(
        `UPDATE journal_entries
         SET status = 'reversed',
             reversed_at      = NOW(),
             reversal_reason  = 'Withdrawal rejected'
         WHERE id = $1 AND status = 'draft'`,
        [tx.accounting_je_id]
      );
    }

    // 3. Mark the transaction rejected
    await client.query(
      `UPDATE transactions SET status = 'rejected' WHERE id = $1`,
      [tx.id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status:  "success",
      message: "Withdrawal request rejected successfully",
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("rejectTransaction error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};


export const deleteTransaction = async (req, res) => {
  const { id }        = req.params;
  const { company_id, deleted_by } = req.body;

  if (!id)
    return res.status(400).json({ status: "fail", message: "Transaction ID is required" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Fetch full transaction row
    const txResult = await client.query(
      `SELECT t.*, a.account_type, a.customer_id, a.company_id AS acc_company_id
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1 AND t.company_id = $2 AND t.is_deleted = false
      FOR UPDATE`,
      [id, company_id]
    );

    if (txResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "Transaction not found or not authorized" });
    }

    const tx = txResult.rows[0];

    // ── Balance adjustment & JE reversal ─────────────────
    const amount = Number(tx.amount);

    if (tx.type === "deposit" && tx.status !== "reversed") {
      // ── Reverse a deposit ─────────────────────────────
      // Remove the deposit from the customer balance
      await client.query(
        `UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND company_id = $3`,
        [amount, tx.account_id, company_id]
      );

      // Reverse JE:  Dr Customer Deposits  /  Cr Cash
      const cashCoaId    = await resolveCOA(client, company_id, cashCoaCode(tx.payment_method));
      const depositCoaId = await resolveCOA(client, company_id, depositCoaCode(tx.account_type));

      await postJournalEntry(client, {
        companyId:   company_id,
        description: `Deposit deleted — transaction ${tx.id}`,
        entryDate:   new Date().toISOString().slice(0, 10),
        source:      "reversal",
        sourceId:    tx.id,
        sourceTable: "transactions",
        createdBy:   deleted_by || tx.created_by,
        lines: [
          {
            coaId:      depositCoaId,
            dc:         "debit",
            amount,
            description: "Reverse deposit — reduce liability",
            customerId: tx.customer_id,
            accountId:  tx.account_id,
          },
          {
            coaId:      cashCoaId,
            dc:         "credit",
            amount,
            description: "Reverse deposit — reduce cash asset",
            customerId: tx.customer_id,
            accountId:  tx.account_id,
          },
        ],
      });

      // Mark original posted JE as reversed
      if (tx.accounting_je_id) {
        await client.query(
          `UPDATE journal_entries SET status = 'reversed' WHERE id = $1`,
          [tx.accounting_je_id]
        );
      }

    } else if (tx.type === "withdrawal" && tx.status === "approved") {
      // ── Reverse an approved withdrawal ────────────────
      // Give the money back to the customer
      await client.query(
        `UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND company_id = $3`,
        [amount, tx.account_id, company_id]
      );

      // Reverse JE:  Dr Cash  /  Cr Customer Deposits
      const cashCoaId    = await resolveCOA(client, company_id, cashCoaCode(tx.payment_method));
      const depositCoaId = await resolveCOA(client, company_id, depositCoaCode(tx.account_type));

      await postJournalEntry(client, {
        companyId:   company_id,
        description: `Approved withdrawal deleted — transaction ${tx.id}`,
        entryDate:   new Date().toISOString().slice(0, 10),
        source:      "reversal",
        sourceId:    tx.id,
        sourceTable: "transactions",
        createdBy:   deleted_by || tx.created_by,
        lines: [
          {
            coaId:      cashCoaId,
            dc:         "debit",
            amount,
            description: "Reverse withdrawal — cash returned",
            customerId: tx.customer_id,
            accountId:  tx.account_id,
          },
          {
            coaId:      depositCoaId,
            dc:         "credit",
            amount,
            description: "Reverse withdrawal — liability restored",
            customerId: tx.customer_id,
            accountId:  tx.account_id,
          },
        ],
      });

      if (tx.accounting_je_id) {
        await client.query(
          `UPDATE journal_entries SET status = 'reversed' WHERE id = $1`,
          [tx.accounting_je_id]
        );
      }

    } else if (tx.type === "withdrawal" && tx.status === "pending") {
      // ── Pending withdrawal — nothing was posted ────────
      // Just void the draft JE if one exists
      if (tx.accounting_je_id) {
        await client.query(
          `UPDATE journal_entries
           SET status = 'reversed', reversal_reason = 'Transaction deleted while pending'
           WHERE id = $1 AND status = 'draft'`,
          [tx.accounting_je_id]
        );
      }

    } else if (tx.type === "commission" && tx.status !== "reversed") {
      // ── Reverse a commission deduction ────────────────
      // Give commission amount back to customer
      await client.query(
        `UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND company_id = $3`,
        [amount, tx.account_id, company_id]
      );

      const depositCoaId    = await resolveCOA(client, company_id, depositCoaCode(tx.account_type));
      const commIncomeCoaId = await resolveCOA(client, company_id, "4020");

      await postJournalEntry(client, {
        companyId:   company_id,
        description: `Commission deleted — transaction ${tx.id}`,
        entryDate:   new Date().toISOString().slice(0, 10),
        source:      "reversal",
        sourceId:    tx.id,
        sourceTable: "transactions",
        createdBy:   deleted_by || tx.created_by,
        lines: [
          {
            coaId:      commIncomeCoaId,
            dc:         "debit",
            amount,
            description: "Reverse commission — undo income",
            customerId: tx.customer_id,
            accountId:  tx.account_id,
          },
          {
            coaId:      depositCoaId,
            dc:         "credit",
            amount,
            description: "Reverse commission — restore customer balance",
            customerId: tx.customer_id,
            accountId:  tx.account_id,
          },
        ],
      });

      if (tx.accounting_je_id) {
        await client.query(
          `UPDATE journal_entries SET status = 'reversed' WHERE id = $1`,
          [tx.accounting_je_id]
        );
      }
    }
    // Note: transfer_in / transfer_out deletions should go through
    // reverseTransfer instead — that handles both legs atomically.

    // 2. Soft-delete the transaction
    await client.query(
      `UPDATE transactions
       SET is_deleted = true,
           deleted_at = NOW(),
           status     = 'reversed'
       WHERE id = $1 AND company_id = $2 AND is_deleted = false`,
      [id, company_id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status:  "success",
      message: "Transaction deleted and accounting entries reversed",
      data:    tx,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteTransaction error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};


export const reverseWithdrawal = async (req, res) => {
  const { transactionId } = req.params;
  const { reason, staffId } = req.body;

  if (!staffId)
    return res.status(401).json({ message: "Unauthorized" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. Fetch + validate transaction ──────────────────
    const txRes = await client.query(
      `SELECT t.id, t.amount, t.account_id, t.status, t.type,
              t.payment_method, t.accounting_je_id
       FROM transactions t WHERE t.id = $1 FOR UPDATE`,
      [transactionId]
    );
    if (txRes.rowCount === 0) throw new Error("Transaction not found");

    const tx = txRes.rows[0];
    if (tx.type !== "withdrawal")  throw new Error("Only withdrawals can be reversed");
    if (tx.status !== "approved")  throw new Error("Only approved withdrawals can be reversed");

    // ── 2. Fetch account ─────────────────────────────────
    const accRes = await client.query(
      `SELECT id, company_id, account_type, customer_id FROM accounts WHERE id = $1`,
      [tx.account_id]
    );
    const account = accRes.rows[0];

    // ── 3. Reverse float movements (existing logic) ──────
    const floatRes = await client.query(
      `SELECT id, budget_id, amount FROM float_movements
       WHERE source_type = 'withdrawal' AND source_id = $1 AND direction = 'debit'`,
      [transactionId]
    );
    for (const fm of floatRes.rows) {
      await client.query(
        `UPDATE budgets SET spent = spent - $1 WHERE id = $2`,
        [fm.amount, fm.budget_id]
      );
      await client.query(
        `INSERT INTO float_movements
           (budget_id, source_type, source_id, amount, direction, company_id)
         VALUES ($1,'withdrawal',$2,$3,'credit',
           (SELECT company_id FROM budgets WHERE id = $1))`,
        [fm.budget_id, transactionId, fm.amount]
      );
    }

    // ── 4. Handle commission reversal ────────────────────
    const commRes = await client.query(
      `SELECT id, amount FROM commissions
       WHERE transaction_id = $1 AND status != 'reversed' FOR UPDATE`,
      [transactionId]
    );

    let commissionAmount = 0;

    if (commRes.rowCount > 0) {
      commissionAmount = parseFloat(commRes.rows[0].amount);

      await client.query(
        `UPDATE commissions SET status='reversed', reversed_at=NOW(), reversed_by=$1
         WHERE transaction_id = $2`,
        [staffId, transactionId]
      );

      // Reverse the commission transaction row
      await client.query(
        `UPDATE transactions
         SET status='reversed', reversed_at=NOW(), reversed_by=$1, reversal_reason=$2
         WHERE source_transaction_id = $3 AND type='commission' AND status != 'reversed'`,
        [staffId, reason || null, transactionId]
      );

      // Commission reversal JE:
      // Dr Commission income (4020)   — undo the income
      // Cr Customer deposits (2010-01) — restore the customer balance
      const commIncomeCoaId = await resolveCOA(client, account.company_id, "4020");
      const depositCoaId    = await resolveCOA(client, account.company_id, depositCoaCode(account.account_type));

      await postJournalEntry(client, {
        companyId:   account.company_id,
        description: `Commission reversal — withdrawal ${transactionId}`,
        entryDate:   new Date().toISOString().slice(0, 10),
        source:      "reversal",
        sourceId:    commRes.rows[0].id,
        sourceTable: "commissions",
        createdBy:   staffId,
        lines: [
          {
            coaId:      commIncomeCoaId,
            dc:         "debit",
            amount:     commissionAmount,
            description: "Reverse commission income",
            customerId: account.customer_id,
            accountId:  tx.account_id,
          },
          {
            coaId:      depositCoaId,
            dc:         "credit",
            amount:     commissionAmount,
            description: "Restore customer deposit balance",
            customerId: account.customer_id,
            accountId:  tx.account_id,
          },
        ],
      });
    }

    // ── 5. Mark withdrawal reversed ───────────────────────
    await client.query(
      `UPDATE transactions
       SET status='reversed', reversed_at=NOW(), reversed_by=$1, reversal_reason=$2
       WHERE id = $3`,
      [staffId, reason || null, transactionId]
    );

    // ── 6. Restore customer balance ───────────────────────
    const totalRefund = parseFloat(tx.amount) + commissionAmount;
    await client.query(
      `UPDATE accounts SET balance = balance + $1, last_activity_at = NOW() WHERE id = $2`,
      [totalRefund, tx.account_id]
    );

    // ── 7. Reversal journal entry ─────────────────────────
    // Dr  Cash / Float          — asset ↑  (money comes back in)
    // Cr  Customer deposits     — liability ↑  (we owe the customer again)
    const cashCode    = cashCoaCode(tx.payment_method);
    const cashCoaId    = await resolveCOA(client, account.company_id, cashCode);
    const depositCoaId = await resolveCOA(client, account.company_id, depositCoaCode(account.account_type));

    await postJournalEntry(client, {
      companyId:   account.company_id,
      description: `Withdrawal reversal${reason ? ` — ${reason}` : ""}`,
      entryDate:   new Date().toISOString().slice(0, 10),
      source:      "reversal",
      sourceId:    tx.id,
      sourceTable: "transactions",
      createdBy:   staffId,
      lines: [
        {
          coaId:      cashCoaId,
          dc:         "debit",
          amount:     parseFloat(tx.amount),
          description: "Cash returned / float restored",
          customerId: account.customer_id,
          accountId:  tx.account_id,
          staffId,
        },
        {
          coaId:      depositCoaId,
          dc:         "credit",
          amount:     parseFloat(tx.amount),
          description: "Customer deposit liability restored",
          customerId: account.customer_id,
          accountId:  tx.account_id,
          staffId,
        },
      ],
    });

    // Also reverse the original approved JE if it exists
    if (tx.accounting_je_id) {
      await client.query(
        `UPDATE journal_entries
         SET status = 'reversed', reversed_by_entry_id = (
           SELECT id FROM journal_entries
           WHERE source_id = $1 AND source = 'reversal' AND status = 'posted'
           ORDER BY created_at DESC LIMIT 1
         )
         WHERE id = $2`,
        [tx.id, tx.accounting_je_id]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Withdrawal reversed successfully",
      data: {
        transactionId,
        refundedAmount: totalRefund,
        floatRestored:  floatRes.rowCount > 0,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("reverseWithdrawal error:", err.message);
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

export const transferBetweenAccounts = async (req, res) => {
  const {
    from_account_id, to_account_id, amount,
    company_id, created_by, created_by_type = "staff", description,
  } = req.body;

  if (!from_account_id || !to_account_id || !amount || amount <= 0)
    return res.status(400).json({ success: false, message: "Invalid transfer data" });
  if (from_account_id === to_account_id)
    return res.status(400).json({ success: false, message: "Cannot transfer to the same account" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Lock both accounts ────────────────────────────────
    const accountsRes = await client.query(
      `SELECT id, balance, customer_id, account_type
       FROM accounts
       WHERE id IN ($1,$2) AND company_id = $3 FOR UPDATE`,
      [from_account_id, to_account_id, company_id]
    );
    if (accountsRes.rowCount !== 2) throw new Error("One or both accounts not found");

    const fromAcc = accountsRes.rows.find(a => a.id === from_account_id);
    const toAcc   = accountsRes.rows.find(a => a.id === to_account_id);

    if (Number(fromAcc.balance) < Number(amount)) throw new Error("Insufficient balance");

    // ── Update balances ───────────────────────────────────
    await client.query(
      `UPDATE accounts SET balance = balance - $1, last_activity_at = NOW() WHERE id = $2`,
      [amount, from_account_id]
    );
    await client.query(
      `UPDATE accounts SET balance = balance + $1, last_activity_at = NOW() WHERE id = $2`,
      [amount, to_account_id]
    );

    // ── Insert transaction records ────────────────────────
    const outTx = await client.query(
      `INSERT INTO transactions
         (account_id, company_id, type, amount, description, created_by, created_by_type)
       VALUES ($1,$2,'transfer_out',$3,$4,$5,$6) RETURNING *`,
      [from_account_id, company_id, amount, description || "Transfer to another account", created_by, created_by_type]
    );
    const inTx = await client.query(
      `INSERT INTO transactions
         (account_id, company_id, type, amount, description, created_by, created_by_type,
          source_transaction_id)
       VALUES ($1,$2,'transfer_in',$3,$4,$5,$6,$7) RETURNING *`,
      [to_account_id, company_id, amount, description || "Transfer from another account",
       created_by, created_by_type, outTx.rows[0].id]
    );

    // ── Resolve COA accounts ──────────────────────────────
    // Both sides use the deposits liability account —
    // just different customers attached to each line.
    const fromDepositCoaId = await resolveCOA(client, company_id, depositCoaCode(fromAcc.account_type));
    const toDepositCoaId   = await resolveCOA(client, company_id, depositCoaCode(toAcc.account_type));

    // ── Post journal entry ────────────────────────────────
    await postJournalEntry(client, {
      companyId:   company_id,
      description: description || "Transfer between customer accounts",
      entryDate:   new Date().toISOString().slice(0, 10),
      source:      "transfer",
      sourceId:    outTx.rows[0].id,
      sourceTable: "transactions",
      createdBy:   created_by,
      lines: [
        {
          coaId:      fromDepositCoaId,
          dc:         "debit",
          amount:     Number(amount),
          description: "From account — liability reduces",
          customerId: fromAcc.customer_id,
          accountId:  from_account_id,
          staffId:    created_by,
        },
        {
          coaId:      toDepositCoaId,
          dc:         "credit",
          amount:     Number(amount),
          description: "To account — liability increases",
          customerId: toAcc.customer_id,
          accountId:  to_account_id,
          staffId:    created_by,
        },
      ],
    });

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Transfer completed successfully",
      data: {
        from_account_id, to_account_id, amount,
        debit_transaction:  outTx.rows[0],
        credit_transaction: inTx.rows[0],
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("transferBetweenAccounts error:", err.message);
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};
;

export const reverseTransfer = async (req, res) => {
  const { transactionId } = req.params;
  const { staffId, reason } = req.body;

  if (!staffId) return res.status(401).json({ message: "Unauthorized" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. Fetch the clicked transaction ─────────────────
    const txRes = await client.query(
      `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
      [transactionId]
    );
    if (txRes.rowCount === 0) throw new Error("Transaction not found");

    const tx = txRes.rows[0];
    if (!["transfer_out","transfer_in"].includes(tx.type))
      throw new Error("Not a transfer transaction");
    if (tx.status !== "approved")
      throw new Error("Only approved transfers can be reversed");

    // ── 2. Find the paired transaction ───────────────────
    const linkedRes = await client.query(
      `SELECT * FROM transactions
       WHERE (source_transaction_id = $1 OR id = $1 OR source_transaction_id = $2)
         AND id != $1
       FOR UPDATE`,
      [tx.source_transaction_id || tx.id, tx.id]
    );
    if (linkedRes.rowCount === 0) throw new Error("Linked transfer transaction not found");

    const transferOut = [tx, ...linkedRes.rows].find(t => t.type === "transfer_out");
    const transferIn  = [tx, ...linkedRes.rows].find(t => t.type === "transfer_in");

    if (!transferOut || !transferIn) throw new Error("Invalid transfer pair");

    // ── 3. Reverse balances ───────────────────────────────
    await client.query(
      `UPDATE accounts SET balance = balance + $1, last_activity_at = NOW() WHERE id = $2`,
      [transferOut.amount, transferOut.account_id]
    );
    await client.query(
      `UPDATE accounts SET balance = balance - $1, last_activity_at = NOW() WHERE id = $2`,
      [transferIn.amount, transferIn.account_id]
    );

    // ── 4. Mark both reversed ─────────────────────────────
    await client.query(
      `UPDATE transactions
       SET status='reversed', reversed_at=NOW(), reversed_by=$1, reversal_reason=$2
       WHERE id IN ($3,$4)`,
      [staffId, reason || null, transferOut.id, transferIn.id]
    );

    // ── 5. Fetch account info for COA resolution ─────────
    const fromAccRes = await client.query(
      `SELECT id, company_id, customer_id, account_type
       FROM accounts WHERE id = $1`,
      [transferOut.account_id]
    );
    const toAccRes = await client.query(
      `SELECT id, company_id, customer_id, account_type
       FROM accounts WHERE id = $1`,
      [transferIn.account_id]
    );
    const fromAcc  = fromAccRes.rows[0];
    const toAcc    = toAccRes.rows[0];
    const companyId = fromAcc.company_id;

    const fromDepositCoaId = await resolveCOA(client, companyId, depositCoaCode(fromAcc.account_type));
    const toDepositCoaId   = await resolveCOA(client, companyId, depositCoaCode(toAcc.account_type));

    // ── 6. Post reversal journal entry ───────────────────
    // Mirror of original: debit to-account, credit from-account
    await postJournalEntry(client, {
      companyId,
      description: `Transfer reversal${reason ? ` — ${reason}` : ""}`,
      entryDate:   new Date().toISOString().slice(0, 10),
      source:      "reversal",
      sourceId:    transferOut.id,
      sourceTable: "transactions",
      createdBy:   staffId,
      lines: [
        {
          coaId:      toDepositCoaId,
          dc:         "debit",
          amount:     Number(transferIn.amount),
          description: "Reverse transfer — undo credit to recipient",
          customerId: toAcc.customer_id,
          accountId:  transferIn.account_id,
          staffId,
        },
        {
          coaId:      fromDepositCoaId,
          dc:         "credit",
          amount:     Number(transferOut.amount),
          description: "Reverse transfer — restore sender balance",
          customerId: fromAcc.customer_id,
          accountId:  transferOut.account_id,
          staffId,
        },
      ],
    });

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Transfer reversed successfully",
      data: { reversed_transactions: [transferOut.id, transferIn.id] },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("reverseTransfer error:", err.message);
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};
