import pool from "../db.mjs";

function parseSmsNumbers(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((n) => String(n).trim()).filter(Boolean);
  return String(raw)
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}


function buildSetClause(fields, startIndex = 1) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  const setText = entries.map(([col], i) => `${col} = $${startIndex + i}`).join(", ");
  const values = entries.map(([, v]) => v);
  return { setText, values, nextIndex: startIndex + entries.length };
}


export const updateAccountSettings = async (req, res) => {
  const { accountId } = req.params;
  const companyId = req.user?.companyId;

  const {
    // ── Balance & limits ──────────────────────────────────────
    minimum_balance,
    allow_negative_balance,
    overdraft_limit,
    low_balance_threshold,
    daily_withdrawal_limit,

    // ── Rates / product config ────────────────────────────────
    interest_rate,
    daily_rate,
    frequency,
    description,

    // ── Card ─────────────────────────────────────────────────
    card_status,
    card_expiry_date,

    // ── Notifications ─────────────────────────────────────────
    sms_enabled,
    sms_numbers,          // string[] or comma-separated string
    email_notifications,
    push_notifications,

    // ── Risk / security ───────────────────────────────────────
    transaction_pin_enabled,
    locked_until,         // null clears the lock

    // ── Lifecycle ─────────────────────────────────────────────
    status,
  } = req.body;

  try {
    // ── 1. Fetch current account ────────────────────────────────────────────
    const { rows } = await pool.query(
      `SELECT id, balance, status, card_status, card_number,
              allow_negative_balance, overdraft_limit,
              failed_pin_attempts, locked_until,
              card_replacement_count
       FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_deleted = false`,
      [accountId, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Account not found." });
    }

    const account = rows[0];

    // ── 2. Validations ──────────────────────────────────────────────────────

    if (minimum_balance !== undefined && minimum_balance < 0) {
      return res.status(400).json({ message: "Minimum balance cannot be negative." });
    }

    if (overdraft_limit !== undefined && overdraft_limit < 0) {
      return res.status(400).json({ message: "Overdraft limit cannot be negative." });
    }

    if (low_balance_threshold !== undefined && low_balance_threshold < 0) {
      return res.status(400).json({ message: "Low balance threshold cannot be negative." });
    }

    if (daily_withdrawal_limit !== undefined && daily_withdrawal_limit !== null && daily_withdrawal_limit < 0) {
      return res.status(400).json({ message: "Daily withdrawal limit cannot be negative." });
    }

    // Disabling overdraft while account is already negative
    if (allow_negative_balance === false && Number(account.balance) < 0) {
      return res.status(400).json({
        message: "Cannot disable overdraft while account balance is negative.",
      });
    }

    // Valid card statuses
    const VALID_CARD_STATUSES = ["ACTIVE", "BLOCKED", "EXPIRED", "LOST", "STOLEN", "INACTIVE"];
    if (card_status !== undefined && !VALID_CARD_STATUSES.includes(card_status)) {
      return res.status(400).json({
        message: `Invalid card status. Must be one of: ${VALID_CARD_STATUSES.join(", ")}.`,
      });
    }

    // Valid account statuses
    const VALID_STATUSES = ["Active", "Inactive", "Suspended", "Closed", "Dormant"];
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `Invalid account status. Must be one of: ${VALID_STATUSES.join(", ")}.`,
      });
    }

    if (
      card_expiry_date !== undefined &&
      card_expiry_date !== null &&
      isNaN(Date.parse(card_expiry_date))
    ) {
      return res.status(400).json({ message: "Invalid card expiry date." });
    }

    if (
      locked_until !== undefined &&
      locked_until !== null &&
      isNaN(Date.parse(locked_until))
    ) {
      return res.status(400).json({ message: "Invalid locked_until date." });
    }

    // Validate SMS numbers format (E.164 or local Ghanaian numbers)
    const parsedSmsNumbers = parseSmsNumbers(sms_numbers);
    const phoneRegex = /^\+?[0-9]{9,15}$/;
    for (const num of parsedSmsNumbers) {
      if (!phoneRegex.test(num)) {
        return res.status(400).json({
          message: `Invalid phone number format: "${num}". Use international format e.g. +233244000001.`,
        });
      }
    }

    // ── 3. Build update payload ─────────────────────────────────────────────
    //
    // We only include a field in the SET clause when the caller explicitly
    // sent it (not undefined). This makes every field optional — the caller
    // can send a single field or all of them.
    //
    const fields = {};

    // Balance & limits
    if (minimum_balance !== undefined)       fields.minimum_balance       = minimum_balance;
    if (allow_negative_balance !== undefined) fields.allow_negative_balance = allow_negative_balance;
    if (overdraft_limit !== undefined)        fields.overdraft_limit        = overdraft_limit;
    if (low_balance_threshold !== undefined)  fields.low_balance_threshold  = low_balance_threshold;
    if (daily_withdrawal_limit !== undefined) fields.daily_withdrawal_limit = daily_withdrawal_limit;

    // Rates / product
    if (interest_rate !== undefined) fields.interest_rate = interest_rate;
    if (daily_rate !== undefined)    fields.daily_rate    = daily_rate;
    if (frequency !== undefined)     fields.frequency     = frequency;
    if (description !== undefined)   fields.description   = description;

    // Card
    if (card_status !== undefined)      fields.card_status      = card_status;
    if (card_expiry_date !== undefined)  fields.card_expiry_date = card_expiry_date;

    // Notifications
    if (sms_enabled !== undefined)          fields.sms_enabled          = sms_enabled;
    if (sms_numbers !== undefined)          fields.sms_numbers          = parsedSmsNumbers;
    if (email_notifications !== undefined)  fields.email_notifications  = email_notifications;
    if (push_notifications !== undefined)   fields.push_notifications   = push_notifications;

    // Risk / security
    if (transaction_pin_enabled !== undefined) fields.transaction_pin_enabled = transaction_pin_enabled;

    // locked_until: null clears the lock (explicit null is intentional)
    if (locked_until !== undefined) {
      fields.locked_until          = locked_until;
      fields.failed_pin_attempts   = 0; // reset counter when staff manually sets/clears lock
    }

    // Lifecycle
    if (status !== undefined) {
      fields.status = status;
      // If closing the account, stamp closed_at
      if (status === "Closed" && account.status !== "Closed") {
        fields.closed_at = new Date().toISOString();
      }
    }

    // Always touch updated_at
    fields.updated_at = new Date().toISOString();

    if (Object.keys(fields).length === 1) {
      // Only updated_at — nothing meaningful to save
      return res.status(400).json({ message: "No valid fields provided to update." });
    }

    // ── 4. Execute update ───────────────────────────────────────────────────
    const { setText, values, nextIndex } = buildSetClause(fields);

    const updateQuery = `
      UPDATE accounts
      SET ${setText}
      WHERE id = $${nextIndex} AND company_id = $${nextIndex + 1}
      RETURNING
        id, account_number, account_type, status, balance,
        minimum_balance, allow_negative_balance, overdraft_limit,
        low_balance_threshold, daily_withdrawal_limit,
        interest_rate, daily_rate, frequency, description,
        card_number, card_status, card_expiry_date,
        card_issued_at, card_last_replaced_at, card_replacement_count,
        sms_enabled, sms_numbers, email_notifications, push_notifications,
        transaction_pin_enabled, failed_pin_attempts, locked_until,
        opened_at, closed_at, last_activity_at, inactive_at, updated_at,
        branch_id, customer_id, company_id
    `;

    const { rows: updated } = await pool.query(updateQuery, [
      ...values,
      accountId,
      companyId,
    ]);

    return res.status(200).json(updated[0]);

  } catch (error) {
    console.error("updateAccountSettings error:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};


const VALID_RATE_TYPES = ["interest_rate", "daily_rate"];

// ── Apply a rate change ───────────────────────────────────────────────────
// Writes/replaces a row in account_rate_changes for (account, rate_type, date)
// AND updates the account's live rate column, in a single transaction.
export const applyRateChange = async (req, res) => {
  const { accountId } = req.params;
  const companyId = req.user?.companyId;
  const userId = req.user?.id;
  const userName = req.user?.name || req.user?.full_name || null;

  const { rate_type, new_rate, effective_date, reason } = req.body;

  try {
    // ── Validation ─────────────────────────────────────────────────────
    if (!VALID_RATE_TYPES.includes(rate_type)) {
      return res.status(400).json({
        message: `rate_type must be one of: ${VALID_RATE_TYPES.join(", ")}.`,
      });
    }

    if (new_rate === undefined || new_rate === null || isNaN(new_rate) || Number(new_rate) < 0) {
      return res.status(400).json({ message: "new_rate must be a non-negative number." });
    }

    if (!effective_date || isNaN(Date.parse(effective_date))) {
      return res.status(400).json({ message: "A valid effective_date is required." });
    }

    if (!userId || !companyId) {
      return res.status(401).json({ message: "Unable to identify the staff member making this change." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the account row so concurrent rate changes can't race
      const { rows: accountRows } = await client.query(
        `SELECT id, interest_rate, daily_rate
         FROM accounts
         WHERE id = $1 AND company_id = $2 AND is_deleted = false
         FOR UPDATE`,
        [accountId, companyId]
      );

      if (accountRows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Account not found." });
      }

      const account = accountRows[0];
      const previousRate = rate_type === "interest_rate" ? account.interest_rate : account.daily_rate;

      // Upsert into history: same account + rate_type + effective_date
      // REPLACES the existing row instead of creating a duplicate.
      const { rows: historyRows } = await client.query(
        `INSERT INTO account_rate_changes
           (account_id, company_id, rate_type, effective_date,
            previous_rate, new_rate, changed_by, changed_by_name, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (account_id, rate_type, effective_date)
         DO UPDATE SET
           previous_rate   = EXCLUDED.previous_rate,
           new_rate        = EXCLUDED.new_rate,
           changed_by      = EXCLUDED.changed_by,
           changed_by_name = EXCLUDED.changed_by_name,
           reason          = EXCLUDED.reason,
           updated_at      = now()
         RETURNING *`,
        [accountId, companyId, rate_type, effective_date, previousRate, new_rate, userId, userName, reason || null]
      );

      // Push the new rate onto the account itself
      const rateColumn = rate_type === "interest_rate" ? "interest_rate" : "daily_rate";
      const { rows: updatedAccountRows } = await client.query(
        `UPDATE accounts
         SET ${rateColumn} = $1,
             rate_last_changed_at = now(),
             rate_last_changed_by = $2,
             updated_at = now()
         WHERE id = $3 AND company_id = $4
         RETURNING id, account_number, interest_rate, daily_rate,
                   rate_last_changed_at, rate_last_changed_by, updated_at`,
        [new_rate, userId, accountId, companyId]
      );

      await client.query("COMMIT");

      return res.status(200).json({
        account: updatedAccountRows[0],
        rate_change: historyRows[0],
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("applyRateChange error:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ── Fetch rate change history for an account ──────────────────────────────
// Optional ?rate_type=interest_rate|daily_rate query param to filter.
export const getAccountRateHistory = async (req, res) => {
  const { accountId } = req.params;
  const companyId = req.user?.companyId;
  const { rate_type } = req.query;

  try {
    if (rate_type !== undefined && !VALID_RATE_TYPES.includes(rate_type)) {
      return res.status(400).json({
        message: `rate_type must be one of: ${VALID_RATE_TYPES.join(", ")}.`,
      });
    }

    const params = [accountId, companyId];
    let query = `
      SELECT id, account_id, rate_type, effective_date, previous_rate, new_rate,
             changed_by, changed_by_name, reason, created_at, updated_at
      FROM account_rate_changes
      WHERE account_id = $1 AND company_id = $2
    `;

    if (rate_type) {
      params.push(rate_type);
      query += ` AND rate_type = $${params.length}`;
    }

    query += ` ORDER BY effective_date DESC, created_at DESC`;

    const { rows } = await pool.query(query, params);
    return res.status(200).json(rows);
  } catch (error) {
    console.error("getAccountRateHistory error:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accounts/:accountId/card/replace
// Logs a card replacement: increments count, stamps timestamps, resets status
// ─────────────────────────────────────────────────────────────────────────────
export const replaceAccountCard = async (req, res) => {
  const { accountId } = req.params;
  const companyId = req.user?.companyId;

  try {
    // Verify account ownership
    const { rows } = await pool.query(
      `SELECT id, card_replacement_count, card_number
       FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_deleted = false`,
      [accountId, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Account not found." });
    }

    const now = new Date().toISOString();

    const { rows: updated } = await pool.query(
      `UPDATE accounts
       SET
         card_last_replaced_at  = $1,
         card_replacement_count = card_replacement_count + 1,
         card_status            = 'ACTIVE',
         card_issued_at         = COALESCE(card_issued_at, $1),
         updated_at             = $1
       WHERE id = $2 AND company_id = $3
       RETURNING
         id, account_number, card_number, card_status,
         card_issued_at, card_last_replaced_at, card_replacement_count,
         card_expiry_date, updated_at`,
      [now, accountId, companyId]
    );

    return res.status(200).json(updated[0]);

  } catch (error) {
    console.error("replaceAccountCard error:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accounts/:accountId/unlock
// Clears PIN lock and resets failed_pin_attempts
// ─────────────────────────────────────────────────────────────────────────────
export const unlockAccount = async (req, res) => {
  const { accountId } = req.params;
  const companyId = req.user?.companyId;

  try {
    const { rows } = await pool.query(
      `SELECT id FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_deleted = false`,
      [accountId, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Account not found." });
    }

    const now = new Date().toISOString();

    const { rows: updated } = await pool.query(
      `UPDATE accounts
       SET
         locked_until        = NULL,
         failed_pin_attempts = 0,
         updated_at          = $1
       WHERE id = $2 AND company_id = $3
       RETURNING id, account_number, locked_until, failed_pin_attempts, updated_at`,
      [now, accountId, companyId]
    );

    return res.status(200).json(updated[0]);

  } catch (error) {
    console.error("unlockAccount error:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accounts/:accountId/pin/verify
// Called during a transaction to validate the PIN and handle lockout logic.
// Expects { pin } in the body. You'd compare against a hashed PIN stored
// elsewhere (e.g. customers table or a separate account_pins table).
// ─────────────────────────────────────────────────────────────────────────────
export const verifyTransactionPin = async (req, res) => {
  const { accountId } = req.params;
  const companyId = req.user?.companyId;
  const { pin } = req.body;
  const MAX_ATTEMPTS = 3;
  const LOCK_DURATION_MINUTES = 30;

  if (!pin) {
    return res.status(400).json({ message: "PIN is required." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, transaction_pin_enabled, failed_pin_attempts,
              locked_until, customer_id
       FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_deleted = false`,
      [accountId, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Account not found." });
    }

    const account = rows[0];

    // PIN feature disabled for this account
    if (!account.transaction_pin_enabled) {
      return res.status(200).json({ verified: true });
    }

    // Check if currently locked
    if (account.locked_until && new Date(account.locked_until) > new Date()) {
      return res.status(423).json({
        message: "Account is temporarily locked due to too many failed PIN attempts.",
        locked_until: account.locked_until,
      });
    }

    // ── Fetch the hashed PIN for this customer ──────────────────────────────
    // Adjust the table/column to wherever you store PINs.
    const { rows: pinRows } = await pool.query(
      `SELECT transaction_pin FROM customers WHERE id = $1`,
      [account.customer_id]
    );

    if (pinRows.length === 0 || !pinRows[0].transaction_pin) {
      // No PIN set — allow through (or tighten this depending on your policy)
      return res.status(200).json({ verified: true, message: "No PIN set for this customer." });
    }

    // ── Compare PINs ────────────────────────────────────────────────────────
    // Replace this with bcrypt.compare() if PINs are hashed (they should be).
    const isCorrect = pin === pinRows[0].transaction_pin;

    if (isCorrect) {
      // Reset failed attempts on success
      await pool.query(
        `UPDATE accounts SET failed_pin_attempts = 0, locked_until = NULL WHERE id = $1`,
        [accountId]
      );
      return res.status(200).json({ verified: true });
    }

    // Increment failed attempts
    const newAttempts = (account.failed_pin_attempts || 0) + 1;
    const shouldLock = newAttempts >= MAX_ATTEMPTS;
    const lockUntil = shouldLock
      ? new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString()
      : null;

    await pool.query(
      `UPDATE accounts
       SET failed_pin_attempts = $1, locked_until = $2, updated_at = NOW()
       WHERE id = $3`,
      [newAttempts, lockUntil, accountId]
    );

    if (shouldLock) {
      return res.status(423).json({
        message: `Too many failed attempts. Account locked for ${LOCK_DURATION_MINUTES} minutes.`,
        locked_until: lockUntil,
      });
    }

    return res.status(401).json({
      verified: false,
      message: `Incorrect PIN. ${MAX_ATTEMPTS - newAttempts} attempt(s) remaining.`,
      attempts_remaining: MAX_ATTEMPTS - newAttempts,
    });

  } catch (error) {
    console.error("verifyTransactionPin error:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};
