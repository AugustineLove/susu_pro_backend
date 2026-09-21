import pool from '../db.mjs';
import { resolveAccountingRule } from '../services/accountingHelper.mjs';
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
        t.payment_method,
        t.processing_status,
        t.processed_by, 
        t.processed_at,
        t.payment_reference,
        t.agent_note,

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

export const reverseWithdrawal = async (req, res) => {
  const { transactionId } = req.params;
  const { reason, staffId } = req.body;

  if (!staffId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

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
        amount,
        account_id,
        status,
        type,
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

    if (tx.type !== "withdrawal") {
      throw new Error("Only withdrawals can be reversed");
    }

    if (tx.status !== "approved") {
      throw new Error("Only approved withdrawals can be reversed");
    }

    const amount = parseFloat(tx.amount);

    if (isNaN(amount) || amount <= 0) {
      throw new Error("Invalid withdrawal amount on original transaction");
    }

    // =====================================================
    // 2. FETCH ACCOUNT
    // =====================================================

    const accRes = await client.query(
      `
      SELECT id, company_id, account_type, customer_id
      FROM accounts
      WHERE id = $1
      FOR UPDATE
      `,
      [tx.account_id]
    );

    if (accRes.rowCount === 0) {
      throw new Error("Associated account not found");
    }

    const account = accRes.rows[0];

    // =====================================================
    // 3. REVERSE FLOAT MOVEMENTS
    // =====================================================

    const floatRes = await client.query(
      `
      SELECT id, budget_id, amount
      FROM float_movements
      WHERE source_type = 'withdrawal'
        AND source_id = $1
        AND direction = 'debit'
      `,
      [transactionId]
    );

    for (const fm of floatRes.rows) {
      await client.query(
        `
        UPDATE budgets
        SET spent = spent - $1, updated_at = NOW()
        WHERE id = $2
        `,
        [fm.amount, fm.budget_id]
      );

      await client.query(
        `
        INSERT INTO float_movements (
          budget_id, company_id, source_type, source_id,
          amount, direction, created_at
        )
        VALUES (
          $1, $2, 'withdrawal', $3, $4, 'credit', NOW()
        )
        `,
        [fm.budget_id, account.company_id, transactionId, fm.amount]
      );
    }

    // =====================================================
    // 4. REVERSE COMMISSION (IF ANY)
    // =====================================================

    const commRes = await client.query(
      `
      SELECT id, amount
      FROM commissions
      WHERE transaction_id = $1
        AND status != 'reversed'
      FOR UPDATE
      `,
      [transactionId]
    );

    let commissionAmount = 0;

    if (commRes.rowCount > 0) {
      commissionAmount = parseFloat(commRes.rows[0].amount);

      await client.query(
        `
        UPDATE commissions
        SET status = 'reversed', reversed_at = NOW(), reversed_by = $1
        WHERE transaction_id = $2
        `,
        [staffId, transactionId]
      );

      await client.query(
        `
        UPDATE transactions
        SET status = 'reversed', reversed_at = NOW(), reversed_by = $1,
            reversal_reason = $2
        WHERE source_transaction_id = $3
          AND type = 'commission'
          AND status != 'reversed'
        `,
        [staffId, reason || null, transactionId]
      );

      // Commission reversal JE:
      //   Dr Commission income  — undo the income
      //   Cr Customer deposits  — restore the customer balance
      const commissionRule = await resolveAccountingRule(client, account.company_id, {
        transaction_type: "commission",
        account_subtype: account.account_type,
        payment_method: tx.payment_method,
      });

      await postJournalEntry(client, {
        companyId: account.company_id,
        description: `Commission reversal — withdrawal ${transactionId}`,
        entryDate: new Date().toISOString().slice(0, 10),
        source: "reversal",
        sourceId: commRes.rows[0].id,
        sourceTable: "commissions",
        createdBy: staffId,
        lines: [
          {
            coaId: commissionRule.debitCoaId,
            dc: "debit",
            amount: commissionAmount,
            description: "Reverse commission income",
            customerId: account.customer_id,
            accountId: tx.account_id,
            staffId,
          },
          {
            coaId: commissionRule.creditCoaId,
            dc: "credit",
            amount: commissionAmount,
            description: "Restore customer deposit balance",
            customerId: account.customer_id,
            accountId: tx.account_id,
            staffId,
          },
        ],
      });
    }

    // =====================================================
    // 5. MARK WITHDRAWAL AS REVERSED
    // =====================================================

    await client.query(
      `
      UPDATE transactions
      SET status = 'reversed', reversed_at = NOW(), reversed_by = $1,
          reversal_reason = $2, updated_at = NOW()
      WHERE id = $3
      `,
      [staffId, reason || null, transactionId]
    );

    // =====================================================
    // 6. RESTORE CUSTOMER ACCOUNT BALANCE
    // =====================================================

    const totalRefund = amount + commissionAmount;

    await client.query(
      `
      UPDATE accounts
      SET balance = balance + $1, last_activity_at = NOW(), updated_at = NOW()
      WHERE id = $2
      `,
      [totalRefund, tx.account_id]
    );

    // =====================================================
    // 7. REVERSAL JOURNAL ENTRY
    // =====================================================
    //
    // IMPORTANT: use the SAME accounting rule the original approval used,
    // not the standalone cashCoaCode/depositCoaCode helpers. If the rule
    // engine ever routes a withdrawal differently (per company, per
    // payment method, mobile money vs teller cash, etc.), reversing
    // against the generic helper accounts would post to the wrong GL
    // accounts and leave both sides of the books permanently wrong.
    //
    // The reversal simply swaps debit/credit relative to the approval:
    //   approval:  Dr rule.debitCoaId   / Cr rule.creditCoaId
    //   reversal:  Dr rule.creditCoaId  / Cr rule.debitCoaId

    const rule = await resolveAccountingRule(client, account.company_id, {
      transaction_type: tx.type,
      account_subtype: account.account_type,
      payment_method: tx.payment_method,
    });

    await postJournalEntry(client, {
      companyId: account.company_id,
      description: `Withdrawal reversal${reason ? ` — ${reason}` : ""}`,
      entryDate: new Date().toISOString().slice(0, 10),
      source: "reversal",
      sourceId: tx.id,
      sourceTable: "transactions",
      createdBy: staffId,
      lines: [
        {
          coaId: rule.creditCoaId,
          dc: "debit",
          amount,
          description: "Cash / teller float restored",
          customerId: account.customer_id,
          accountId: tx.account_id,
          staffId,
        },
        {
          coaId: rule.debitCoaId,
          dc: "credit",
          amount,
          description: "Customer deposit liability restored",
          customerId: account.customer_id,
          accountId: tx.account_id,
          staffId,
        },
      ],
    });

    // Link the original entry to its reversal WITHOUT changing its
    // status. Balances are computed by summing posted journal_entries,
    // so flipping the original entry to 'reversed' would drop it out of
    // every balance sum — the offsetting entry would then no longer net
    // to zero against it, silently inflating (or deflating) every
    // downstream balance by the withdrawal amount. Keep it 'posted' and
    // only record the audit-trail link.
    if (tx.accounting_je_id) {
      await client.query(
        `
        UPDATE journal_entries
        SET reversed_by_entry_id = (
          SELECT id FROM journal_entries
          WHERE source_id = $1 AND source = 'reversal' AND status = 'posted'
          ORDER BY created_at DESC
          LIMIT 1
        ),
        updated_at = NOW()
        WHERE id = $2
        `,
        [tx.id, tx.accounting_je_id]
      );
    }

    // =====================================================
    // 8. COMMIT
    // =====================================================

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Withdrawal reversed successfully",
      data: {
        transactionId,
        refundedAmount: totalRefund,
        floatRestored: floatRes.rowCount > 0,
        commissionReversed: commissionAmount > 0,
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