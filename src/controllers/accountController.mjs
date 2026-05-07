import pool from "../db.mjs";
import { generateAccountNumber, getCustomerBaseAccountNumber } from "../services/accountServices.mjs";

export const createAccount = async (req, res) => {
  const {
    customer_id,
    account_type,
    created_by,
    company_id,
    daily_rate,
    frequency,
    minimum_balance,
    interest_rate,
    initial_deposit = 0,
    created_by_type,
    account_number // optional
  } = req.body;

  if (!customer_id || !account_type || !created_by || !company_id) {
    return res.status(400).json({
      status: "fail",
      message: "customer_id, account_type, created_by, and company_id are required",
    });
  }

  try {
    // 🔑 base number (however you already get it)
    const baseNumber = account_number?.replace(/(SU|SA)\d+$/, "")
      || await getCustomerBaseAccountNumber(customer_id);

    const finalAccountNumber = await generateAccountNumber({
      customerId: customer_id,
      baseNumber,
      accountType: account_type
    });

    // then continue with your existing insert

   
    const fields = ["customer_id", "account_type", "created_by", "company_id", "created_by_type", "balance", "account_number"];
    const values = [customer_id, account_type, created_by, company_id, created_by_type, initial_deposit, finalAccountNumber];
    const placeholders = values.map((_, i) => `$${i + 1}`);

    // Optional fields
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

    if (initial_deposit !== undefined) {
      fields.push("initial_deposit");
      values.push(initial_deposit);
      placeholders.push(`$${values.length}`);
    }

    // Build query dynamically
    const query = `
      INSERT INTO accounts (${fields.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING *
    `;

    const result = await pool.query(query, values);

    return res.status(201).json({
      status: 'success',
      message: 'Account created successfully',
      data: result.rows[0],
    });

  } catch (error) {
    console.error('Error creating account:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

export const getAccountsByCustomer = async (req, res) => {
  const { customerId } = req.params;
  try {
    // 1. Get accounts (UNCHANGED)
    const accounts = await pool.query(
      `SELECT * 
       FROM accounts 
       WHERE customer_id = $1`,
      [customerId]
    );

    if (accounts.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No accounts found for this customer.',
      });
    }

    // 2. Get summary (NEW)
    const summary = await pool.query(
  `SELECT
     -- Deposits
     COALESCE(SUM(CASE 
       WHEN t.type = 'deposit' AND t.is_deleted = false AND t.status IN ('approved', 'completed') THEN t.amount 
       ELSE 0 END), 0) AS total_deposits,

     -- Withdrawals
     COALESCE(SUM(CASE 
       WHEN t.type = 'withdrawal' AND t.is_deleted = false AND t.status IN ('approved', 'completed') THEN t.amount 
       ELSE 0 END), 0) AS total_withdrawals,

     -- Transfer In
     COALESCE(SUM(CASE 
       WHEN t.type = 'transfer_in' AND t.is_deleted = false AND t.status IN ('approved', 'completed') THEN t.amount 
       ELSE 0 END), 0) AS total_transfer_ins,

     -- Transfer Out
     COALESCE(SUM(CASE 
       WHEN t.type = 'transfer_out' AND t.is_deleted = false AND t.status IN ('approved', 'completed') THEN t.amount 
       ELSE 0 END), 0) AS total_transfer_outs,

     -- Commissions (separate subquery to avoid duplication)
     (
       SELECT COALESCE(SUM(c.amount), 0)
       FROM commissions c
       INNER JOIN accounts a2 ON c.account_id = a2.id
       WHERE a2.customer_id = $1
     ) AS total_commissions

   FROM transactions t
   INNER JOIN accounts a ON t.account_id = a.id
   WHERE a.customer_id = $1`,
  [customerId]
);

    // 3. Total balance (optional but useful)
    const balance = await pool.query(
      `SELECT COALESCE(SUM(balance), 0) AS total_balance
       FROM accounts
       WHERE customer_id = $1`,
      [customerId]
    );
    return res.status(200).json({
      status: 'success',
      results: accounts.rowCount,
      data: accounts.rows,
      summary: {
        totalDeposits: Number(summary.rows[0].total_deposits),
        totalWithdrawals: Number(summary.rows[0].total_withdrawals),
        totalBalance: Number(balance.rows[0].total_balance),
        totalTransferIns: Number(summary.rows[0].total_transfer_ins),
        totalTransferOuts: Number(summary.rows[0].total_transfer_outs),
        totalCommissions: Number(summary.rows[0].total_commissions),
      },
    });

  } catch (error) {
    console.error('Error fetching customer accounts:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getAllCompanyAccounts = async (req, res) => {
  const { companyId } = req.params;
  console.log(companyId);
  try {
    const accounts = await pool.query(
      `SELECT 
         *
       FROM accounts 
       WHERE company_id = $1`,
      [companyId]
    );

    if (accounts.rows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No accounts found for this company.',
      });
    }

    return res.status(200).json({
      status: 'success',
      results: accounts.rowCount,
      data: accounts.rows,
    });
  } catch (error) {
    console.error('Error fetching customer accounts:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getLastAccountNumber = async (req, res) => {
  const { staffId } = req.params;
  console.log("Fetching last account number for staff ID:", staffId);

  try {
    if (!staffId) {
      return res.status(400).json({
        status: 'error',
        message: 'staffId is required',
      });
    }

    const query = `
      SELECT account_number
      FROM accounts
      WHERE created_by = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [staffId]);

    return res.json({
      status: 'success',
      lastAccountNumber: rows.length ? rows[0].account_number : null,
    });
  } catch (error) {
    console.error('Error fetching last account number:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getLastCustomerAccountNumber = async (req, res) => {
  const { staffId } = req.params;
  console.log("Fetching last customer account number for staff ID:", staffId);

  try {
    if (!staffId) {
      return res.status(400).json({
        status: 'error',
        message: 'staffId is required',
      });
    }

    const query = `
      SELECT account_number
      FROM customers
      WHERE registered_by = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [staffId]);

    return res.json({
      status: 'success',
      lastCustomerAccountNumber: rows.length ? rows[0].account_number : null,
    });
  } catch (error) {
    console.error('Error fetching last customer account number:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

export const getLastAccountNumbersByStaff = async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT ON (s.id)
      s.id AS staff_id,
      s.staff_id AS staff_account_number,
      s.full_name AS staff_name,
      c.account_number,
      c.created_at
    FROM staff s
    LEFT JOIN customers c
      ON c.registered_by = s.id
    WHERE LOWER(s.role) IN ('mobile banker', 'mobile_banker', 'Mobile Banker','teller', 'manager', 'accountant', 'sales_manager', 'hr')
    ORDER BY s.id, c.created_at DESC;
    `;

    const { rows } = await pool.query(query);

    return res.json({
      status: 'success',
      data: rows.map(row => ({
        staff_id: row.staff_id,
        staff_name: row.staff_name,
        staff_account_number: row.staff_account_number,
        last_account_number: row.account_number || null,
      })),
    });
  } catch (error) {
    console.error('Error fetching last account numbers:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};


export const toggleAccountStatus = async (req, res) => {
  const { accountId } = req.params;
  const { company_id, staff_id } = req.body;

  if (!staff_id) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const accRes = await client.query(
      `
      SELECT id, status
      FROM accounts
      WHERE id = $1 AND company_id = $2
      FOR UPDATE
      `,
      [accountId, company_id]
    );

    if (accRes.rowCount === 0) {
      throw new Error("Account not found");
    }

    const currentStatus = accRes.rows[0].status;
    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";

    const updateRes = await client.query(
      `
      UPDATE accounts
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [newStatus, accountId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: `Account successfully set to ${newStatus.toLowerCase()}`,
      data: updateRes.rows[0],
    });

  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts/:accountId/card-replacements
// Get all card replacement history for an account
// ─────────────────────────────────────────────────────────────────────────────
export const getCardReplacements = async (req, res) => {
  const { accountId } = req.params;
  const companyId = req.user?.companyId;

  try {
    const { rows } = await pool.query(
      `SELECT 
        cr.id,
        cr.account_id,
        cr.customer_id,
        cr.old_card_number,
        cr.new_card_number,
        cr.replacement_reason,
        cr.replacement_status,
        cr.requested_by,
        cr.approved_by,
        cr.request_date,
        cr.approval_date,
        cr.estimated_delivery_date,
        cr.delivery_date,
        cr.delivery_address,
        cr.tracking_number,
        cr.fee_charged,
        cr.fee_transaction_id,
        cr.notes,
        cr.created_at,
        cr.updated_at,
        c.name as customer_name,
        c.phone_number as customer_phone,
        c.email as customer_email,
        req_staff.full_name as requested_by_name,
        app_staff.full_name as approved_by_name,
        a.account_number
      FROM card_replacements cr
      JOIN customers c ON cr.customer_id = c.id
      JOIN accounts a ON cr.account_id = a.id
      LEFT JOIN staff req_staff ON cr.requested_by = req_staff.id
      LEFT JOIN staff app_staff ON cr.approved_by = app_staff.id
      WHERE cr.account_id = $1 AND a.company_id = $2
      ORDER BY cr.request_date DESC`,
      [accountId, companyId]
    );

    return res.status(200).json({
      status: 'success',
      data: rows,
      count: rows.length
    });

  } catch (error) {
    console.error("getCardReplacements error:", error);
    return res.status(500).json({ 
      status: 'error',
      message: "Internal server error." 
    });
  }
};

export const getCustomerCardReplacements = async (req, res) => {
  const { customerId } = req.params;
  const companyId = req.user?.companyId;

  try {
    const { rows } = await pool.query(
      `SELECT 
        cr.id,
        cr.account_id,
        cr.customer_id,
        cr.old_card_number,
        cr.new_card_number,
        cr.replacement_reason,
        cr.replacement_status,
        cr.requested_by,
        cr.approved_by,
        cr.request_date,
        cr.approval_date,
        cr.estimated_delivery_date,
        cr.delivery_date,
        cr.delivery_address,
        cr.tracking_number,
        cr.fee_charged,
        cr.fee_transaction_id,
        cr.notes,
        cr.created_at,
        cr.updated_at,
        a.account_number,
        a.account_type,
        req_staff.full_name as requested_by_name,
        app_staff.full_name as approved_by_name
      FROM card_replacements cr
      JOIN accounts a ON cr.account_id = a.id
      LEFT JOIN staff req_staff ON cr.requested_by = req_staff.id
      LEFT JOIN staff app_staff ON cr.approved_by = app_staff.id
      WHERE cr.customer_id = $1 AND a.company_id = $2
      ORDER BY cr.request_date DESC`,
      [customerId, companyId]
    );

    return res.status(200).json({
      status: 'success',
      data: rows,
      count: rows.length
    });

  } catch (error) {
    console.error("getCustomerCardReplacements error:", error);
    return res.status(500).json({ 
      status: 'error',
      message: "Internal server error." 
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accounts/:accountId/card/replace-with-record
// Request a card replacement with full record keeping
// ─────────────────────────────────────────────────────────────────────────────
// Helper function to mask card numbers


export const requestCardReplacement = async (req, res) => {
  const { accountId } = req.params;
  const companyId = req.user?.companyId;
  const staffId = req.user?.id;
  
  const {
    replacement_reason,
    delivery_address,
    notes,
    fee_charged = 0
  } = req.body;

  if (!replacement_reason) {
    return res.status(400).json({ 
      status: 'fail',
      message: "Replacement reason is required." 
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Verify account ownership and get current card info
    const { rows: accountRows } = await client.query(
      `SELECT 
        a.id, 
        a.card_number, 
        a.card_status,
        a.card_replacement_count,
        a.customer_id,
        c.name as customer_name,
        c.phone_number
      FROM accounts a
      JOIN customers c ON a.customer_id = c.id
      WHERE a.id = $1 AND a.company_id = $2 AND a.is_deleted = false
      FOR UPDATE`,
      [accountId, companyId]
    );

    if (accountRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ 
        status: 'fail',
        message: "Account not found." 
      });
    }

    const account = accountRows[0];
    const oldCardNumber = account.card_number;
    const replacementCount = (account.card_replacement_count || 0) + 1;

    // 2️⃣ Generate new card number
    const generateNewCardNumber = () => {
      const prefix = "4111"; // Visa/Mastercard prefix
      const timestamp = Date.now().toString().slice(-8);
      const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      const count = replacementCount.toString().padStart(2, '0');
      return `${prefix}${timestamp}${random}${count}`;
    };

    const newCardNumber = generateNewCardNumber();
    const estimatedDeliveryDate = new Date();
    estimatedDeliveryDate.setDate(estimatedDeliveryDate.getDate() + 7); // 7 days delivery

    // 3️⃣ Create card replacement record
    const { rows: replacementRows } = await client.query(
      `INSERT INTO card_replacements (
        account_id,
        customer_id,
        old_card_number,
        new_card_number,
        replacement_reason,
        replacement_status,
        requested_by,
        request_date,
        estimated_delivery_date,
        delivery_address,
        fee_charged,
        notes,
        company_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        accountId,
        account.customer_id,
        oldCardNumber,
        newCardNumber,
        replacement_reason,
        'REQUESTED',
        staffId,
        new Date().toISOString(),
        estimatedDeliveryDate,
        delivery_address || null,
        fee_charged,
        notes || null,
        companyId
      ]
    );

    const replacement = replacementRows[0];

    // 4️⃣ Update account with pending card replacement status
    await client.query(
      `UPDATE accounts
       SET 
         card_status = 'PENDING_REPLACEMENT',
         card_replacement_count = $1,
         updated_at = NOW()
       WHERE id = $2`,
      [replacementCount, accountId]
    );

    // 5️⃣ If fee is charged, create a transaction for it
    // let feeTransaction = null;
    // if (fee_charged > 0) {
    //   const { rows: feeRows } = await client.query(
    //     `INSERT INTO transactions (
    //       account_id,
    //       company_id,
    //       type,
    //       amount,
    //       description,
    //       created_by,
    //       created_by_type,
    //       status,
    //       transaction_date
    //     ) VALUES ($1, $2, 'fee', $3, $4, $5, 'staff', 'completed', NOW())
    //     RETURNING *`,
    //     [
    //       accountId,
    //       companyId,
    //       fee_charged,
    //       `Card replacement fee - Request #${replacement.id}`,
    //       staffId
    //     ]
    //   );
    //   feeTransaction = feeRows[0];

    //   // Update the replacement record with fee transaction ID
    //   await client.query(
    //     `UPDATE card_replacements 
    //      SET fee_transaction_id = $1 
    //      WHERE id = $2`,
    //     [feeTransaction.id, replacement.id]
    //   );
    // }

    await client.query("COMMIT");

    return res.status(201).json({
      status: 'success',
      message: 'Card replacement request submitted successfully',
      data: {
        replacement: {
          ...replacement,
          // fee_transaction: feeTransaction
        },
        old_card_number: maskCardNumber(oldCardNumber),
        new_card_number: maskCardNumber(newCardNumber),
        estimated_delivery_date: estimatedDeliveryDate
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("requestCardReplacement error:", error);
    return res.status(500).json({ 
      status: 'error',
      message: "Internal server error.",
      error: error.message 
    });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/card-replacements/:replacementId/status
// Update card replacement status (approve, process, deliver, complete, reject)
// ─────────────────────────────────────────────────────────────────────────────
export const updateCardReplacementStatus = async (req, res) => {
  const { replacementId } = req.params;
  const companyId = req.user?.companyId;
  const staffId = req.user?.id;
  
  const { 
    replacement_status, 
    tracking_number,
    delivery_date,
    rejection_reason,
    approval_notes 
  } = req.body;

  const validStatuses = ['REQUESTED', 'APPROVED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'REJECTED', 'CANCELLED'];
  
  if (!validStatuses.includes(replacement_status)) {
    return res.status(400).json({ 
      status: 'fail',
      message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Get current replacement record
    const { rows: replacementRows } = await client.query(
      `SELECT * FROM card_replacements 
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [replacementId, companyId]
    );

    if (replacementRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ 
        status: 'fail',
        message: "Card replacement record not found." 
      });
    }

    const replacement = replacementRows[0];
    const now = new Date().toISOString();

    // 2️⃣ Build update query dynamically
    const updates = {
      replacement_status,
      updated_at: now
    };

    if (replacement_status === 'APPROVED' && replacement.replacement_status === 'REQUESTED') {
      updates.approved_by = staffId;
      updates.approval_date = now;
    }

    if (replacement_status === 'REJECTED') {
      updates.rejection_reason = rejection_reason || 'No reason provided';
      updates.approved_by = staffId;
      updates.approval_date = now;
    }

    if (tracking_number) {
      updates.tracking_number = tracking_number;
    }

    if (delivery_date) {
      updates.delivery_date = delivery_date;
    }

    if (replacement_status === 'COMPLETED') {
      updates.delivery_date = now;
      
      // Update the account with new card number
      await client.query(
        `UPDATE accounts
         SET 
           card_number = $1,
           card_status = 'ACTIVE',
           card_issued_at = $2,
           card_last_replaced_at = $2,
           updated_at = $2
         WHERE id = $3`,
        [replacement.new_card_number, now, replacement.account_id]
      );
    }

    if (replacement_status === 'REJECTED' || replacement_status === 'CANCELLED') {
      // Restore previous card status
      await client.query(
        `UPDATE accounts
         SET card_status = 'ACTIVE'
         WHERE id = $1`,
        [replacement.account_id]
      );
    }

    // 3️⃣ Execute update
    const setClauses = Object.keys(updates).map((key, idx) => `${key} = $${idx + 1}`).join(', ');
    const values = Object.values(updates);
    values.push(replacementId);

    const { rows: updatedRows } = await client.query(
      `UPDATE card_replacements 
       SET ${setClauses}
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: 'success',
      message: `Card replacement ${replacement_status.toLowerCase()} successfully`,
      data: updatedRows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("updateCardReplacementStatus error:", error);
    return res.status(500).json({ 
      status: 'error',
      message: "Internal server error." 
    });
  } finally {
    client.release();
  }
};

// Helper function to mask card numbers
export const maskCardNumber = (cardNumber) => {
  if (!cardNumber) return '****';
  const str = String(cardNumber);
  if (str.length <= 4) return '****';
  return '**** **** **** ' + str.slice(-4);
}

// GET /api/accounts/search?account_number=xxx
export const searchAccountByNumber = async (req, res) => {
  const { account_number } = req.query;
  const companyId = req.user?.companyId;

  try {
    const { rows } = await pool.query(
      `SELECT 
        a.id, a.account_number, a.account_type, a.balance, a.card_status,
        c.id as customer_id, c.name as customer_name, c.phone_number, c.email
       FROM accounts a
       JOIN customers c ON a.customer_id = c.id
       WHERE a.account_number = $1 AND a.company_id = $2 AND a.is_deleted = false`,
      [account_number, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Account not found" });
    }

    return res.status(200).json({ status: 'success', data: rows[0] });
  } catch (error) {
    console.error("searchAccountByNumber error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /api/customers/search?query=xxx
export const searchCustomer = async (req, res) => {
  const { query } = req.query;
  const companyId = req.user?.companyId;
  console.log(query,companyId);
  try {
    const { rows } = await pool.query(
      `SELECT 
        id, name, phone_number, email, account_number, status
       FROM customers
       WHERE company_id = $1 
         AND (name ILIKE $2 OR phone_number ILIKE $2 OR email ILIKE $2 OR account_number ILIKE $2)
         AND is_deleted = false
       LIMIT 1`,
      [companyId, `%${query}%`]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }

    return res.status(200).json({ status: 'success', data: rows[0] });
  } catch (error) {
    console.error("searchCustomer error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /api/customers/:customerId/accounts
export const getCustomerAccounts = async (req, res) => {
  const { customerId } = req.params;
  const companyId = req.user?.companyId;

  try {
    const { rows } = await pool.query(
      `SELECT id, account_number, account_type, balance, card_status, status
       FROM accounts
       WHERE customer_id = $1 AND company_id = $2 AND is_deleted = false`,
      [customerId, companyId]
    );

    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error("getCustomerAccounts error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /api/card-replacements/recent
export const getRecentReplacements = async (req, res) => {
  const companyId = req.user?.companyId;
  const { limit = 10 } = req.query;

  try {
    const { rows } = await pool.query(
      `SELECT 
        cr.id, cr.replacement_reason, cr.replacement_status, cr.request_date,
        cr.estimated_delivery_date, cr.fee_charged,
        a.account_number,
        c.name as customer_name
       FROM card_replacements cr
       JOIN accounts a ON cr.account_id = a.id
       JOIN customers c ON cr.customer_id = c.id
       WHERE cr.company_id = $1
       ORDER BY cr.request_date DESC
       LIMIT $2`,
      [companyId, limit]
    );

    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error("getRecentReplacements error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};