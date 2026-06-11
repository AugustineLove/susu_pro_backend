// controllers/investmentReversalController.mjs
// ─── Investment Creation Reversal ─────────────────────────────────────────────
//
// Atomically unwinds everything createInvestment created:
//
//   1. Validates the investment exists, is still 'active', and hasn't matured
//   2. Restores source account balance (if funded from an account transfer)
//   3. Zeros and soft-deletes the investment account (accounts table)
//   4. Marks investment_accounts row as 'cancelled'
//   5. Marks all linked transactions as 'reversed'
//   6. Marks the original journal entry as 'reversed'
//   7. Posts a reversal journal entry (mirror of original, with a reason)
//
// Can look up by:
//   - investment_accounts.id              (ia_id)
//   - investment_accounts.reference       (INV-YYYY-XXXXXX)
//   - journal_entries.reference_no        (JE-YYYY-XXXXXX)
//   - accounts.id of the investment acct  (account_id)
//
// POST /api/investments/reverse
// Body:
//   lookup_type  — "ia_id" | "inv_reference" | "je_reference" | "account_id"
//   lookup_value — the actual value to search by
//   company_id
//   reversed_by  — staff UUID
//   reason       — required explanation (audit trail)
//
// ─────────────────────────────────────────────────────────────────────────────

import pool from "../db.mjs";
import {
  postJournalEntry,
  resolveCOA,
  depositCoaCode,
  cashCoaCode,
} from "../services/accountingHelper.mjs";

const fixedDepositCoaCode = () => "2020-01";

// ─────────────────────────────────────────────────────────────────────────────
// MAIN REVERSAL
// ─────────────────────────────────────────────────────────────────────────────
export const reverseInvestmentCreation = async (req, res) => {
  const {
    lookup_type  = "je_reference",
    lookup_value,
    company_id,
    reversed_by,
    reason,
  } = req.body;

  // ── Validation ───────────────────────────────────────────────────────────
  if (!lookup_value || !company_id || !reversed_by)
    return res.status(400).json({
      success: false,
      message: "lookup_value, company_id, and reversed_by are required",
    });

  if (!reason || reason.trim().length < 5)
    return res.status(400).json({
      success: false,
      message: "A reason of at least 5 characters is required for audit purposes",
    });

  const validLookups = ["ia_id", "inv_reference", "je_reference", "account_id"];
  if (!validLookups.includes(lookup_type))
    return res.status(400).json({
      success: false,
      message: `lookup_type must be one of: ${validLookups.join(", ")}`,
    });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ── Step 1: Locate the investment record ──────────────────────────────
    //
    // We support 4 lookup strategies so staff can use whatever reference
    // they have in front of them (the JE ref from the error report,
    // the INV- ref from the SMS, the account ID from the DB, etc.)

    let investmentRow;

    if (lookup_type === "je_reference") {
      // Most likely path — staff has the JE reference number
      const res = await client.query(
        `SELECT ia.*,
                a.balance        AS inv_account_balance,
                a.account_type   AS inv_account_type,
                a.account_number AS inv_account_number,
                a.customer_id    AS inv_customer_id,
                je.id            AS je_id,
                je.reference_no  AS je_ref,
                je.status        AS je_status,
                -- Find the funding transaction linked to this JE
                t.id             AS funding_tx_id,
                t.type           AS funding_tx_type,
                t.source_transaction_id AS paired_tx_id,
                -- If transfer_in, the source is the transfer_out account
                src_t.account_id AS source_account_id,
                src_a.account_type AS source_account_type,
                src_a.balance    AS source_account_balance
         FROM journal_entries je
         JOIN transactions t
           ON t.id = je.source_id
           AND je.source_table = 'transactions'
         JOIN accounts a
           ON a.id = t.account_id
         JOIN investment_accounts ia
           ON ia.account_id = a.id
         -- Optional: link back to transfer_out for account-funded investments
         LEFT JOIN transactions src_t
           ON src_t.id = t.source_transaction_id
           AND src_t.type = 'transfer_out'
         LEFT JOIN accounts src_a
           ON src_a.id = src_t.account_id
         WHERE je.reference_no = $1
           AND je.company_id   = $2
         LIMIT 1`,
        [lookup_value.trim(), company_id]
      );

      if (res.rowCount === 0)
        throw Object.assign(
          new Error(`No investment found for JE reference "${lookup_value}". ` +
                    `Verify the reference number and company.`),
          { status: 404 }
        );

      investmentRow = res.rows[0];

    } else if (lookup_type === "inv_reference") {
      const res = await client.query(
        `SELECT ia.*,
                a.balance        AS inv_account_balance,
                a.account_type   AS inv_account_type,
                a.account_number AS inv_account_number,
                a.customer_id    AS inv_customer_id,
                je.id            AS je_id,
                je.reference_no  AS je_ref,
                je.status        AS je_status,
                t.id             AS funding_tx_id,
                t.type           AS funding_tx_type,
                t.source_transaction_id AS paired_tx_id,
                src_t.account_id AS source_account_id,
                src_a.account_type AS source_account_type,
                src_a.balance    AS source_account_balance
         FROM investment_accounts ia
         JOIN accounts a ON a.id = ia.account_id
         LEFT JOIN journal_entries je
           ON je.source_id = (
             SELECT id FROM transactions
             WHERE account_id = ia.account_id
             AND type IN ('deposit','transfer_in')
             AND status = 'completed'
             ORDER BY created_at ASC LIMIT 1
           )
           AND je.company_id = $2
         LEFT JOIN transactions t ON t.id = je.source_id
         LEFT JOIN transactions src_t
           ON src_t.id = t.source_transaction_id
           AND src_t.type = 'transfer_out'
         LEFT JOIN accounts src_a ON src_a.id = src_t.account_id
         WHERE ia.reference = $1
           AND ia.company_id = $2
         LIMIT 1`,
        [lookup_value.trim(), company_id]
      );

      if (res.rowCount === 0)
        throw Object.assign(
          new Error(`No investment found with reference "${lookup_value}".`),
          { status: 404 }
        );

      investmentRow = res.rows[0];

    } else if (lookup_type === "account_id") {
      const res = await client.query(
        `SELECT ia.*,
                a.balance        AS inv_account_balance,
                a.account_type   AS inv_account_type,
                a.account_number AS inv_account_number,
                a.customer_id    AS inv_customer_id,
                je.id            AS je_id,
                je.reference_no  AS je_ref,
                je.status        AS je_status,
                t.id             AS funding_tx_id,
                t.type           AS funding_tx_type,
                t.source_transaction_id AS paired_tx_id,
                src_t.account_id AS source_account_id,
                src_a.account_type AS source_account_type,
                src_a.balance    AS source_account_balance
         FROM investment_accounts ia
         JOIN accounts a ON a.id = ia.account_id
         LEFT JOIN journal_entries je
           ON je.source_id = (
             SELECT id FROM transactions
             WHERE account_id = ia.account_id
             AND type IN ('deposit','transfer_in')
             AND status = 'completed'
             ORDER BY created_at ASC LIMIT 1
           )
           AND je.company_id = $2
         LEFT JOIN transactions t ON t.id = je.source_id
         LEFT JOIN transactions src_t
           ON src_t.id = t.source_transaction_id
           AND src_t.type = 'transfer_out'
         LEFT JOIN accounts src_a ON src_a.id = src_t.account_id
         WHERE ia.account_id = $1
           AND ia.company_id = $2
         LIMIT 1`,
        [lookup_value.trim(), company_id]
      );

      if (res.rowCount === 0)
        throw Object.assign(
          new Error(`No investment found for account "${lookup_value}".`),
          { status: 404 }
        );

      investmentRow = res.rows[0];

    } else {
      // ia_id
      const res = await client.query(
        `SELECT ia.*,
                a.balance        AS inv_account_balance,
                a.account_type   AS inv_account_type,
                a.account_number AS inv_account_number,
                a.customer_id    AS inv_customer_id,
                je.id            AS je_id,
                je.reference_no  AS je_ref,
                je.status        AS je_status,
                t.id             AS funding_tx_id,
                t.type           AS funding_tx_type,
                t.source_transaction_id AS paired_tx_id,
                src_t.account_id AS source_account_id,
                src_a.account_type AS source_account_type,
                src_a.balance    AS source_account_balance
         FROM investment_accounts ia
         JOIN accounts a ON a.id = ia.account_id
         LEFT JOIN journal_entries je
           ON je.source_id = (
             SELECT id FROM transactions
             WHERE account_id = ia.account_id
             AND type IN ('deposit','transfer_in')
             AND status = 'completed'
             ORDER BY created_at ASC LIMIT 1
           )
           AND je.company_id = $2
         LEFT JOIN transactions t ON t.id = je.source_id
         LEFT JOIN transactions src_t
           ON src_t.id = t.source_transaction_id
           AND src_t.type = 'transfer_out'
         LEFT JOIN accounts src_a ON src_a.id = src_t.account_id
         WHERE ia.id = $1
           AND ia.company_id = $2
         LIMIT 1`,
        [lookup_value.trim(), company_id]
      );

      if (res.rowCount === 0)
        throw Object.assign(new Error(`Investment record not found.`), { status: 404 });

      investmentRow = res.rows[0];
    }

    // ── Step 2: Guard rails ───────────────────────────────────────────────

    if (investmentRow.status === "cancelled")
      throw Object.assign(
        new Error("This investment has already been cancelled/reversed."),
        { status: 400 }
      );

    if (investmentRow.status === "matured")
      throw Object.assign(
        new Error(
          "This investment has already matured and paid out. " +
          "A maturity reversal is a different operation."
        ),
        { status: 400 }
      );

    if (investmentRow.je_status === "reversed")
      throw Object.assign(
        new Error("The journal entry for this investment is already reversed."),
        { status: 400 }
      );

    // ── Step 3: Lock the investment account row ───────────────────────────
    await client.query(
      `SELECT id FROM accounts WHERE id = $1 FOR UPDATE`,
      [investmentRow.account_id]
    );

    const principal = parseFloat(investmentRow.principal_amount);
    const invBalance = parseFloat(investmentRow.inv_account_balance);
    const entryDate  = new Date().toISOString().slice(0, 10);

    // Sanity: if the investment account balance has changed (top-ups happened,
    // partial withdrawals, etc.) we reverse the actual current balance,
    // not the original principal, to keep accounts balanced.
    const reversalAmount = invBalance > 0 ? invBalance : principal;

    // ── Step 4: Restore source account balance (if transfer-funded) ───────
    let sourceRestored = false;

    if (investmentRow.source_account_id) {
      await client.query(
        `UPDATE accounts
         SET balance = balance + $1, last_activity_at = NOW()
         WHERE id = $2`,
        [reversalAmount, investmentRow.source_account_id]
      );
      sourceRestored = true;
    }

    // ── Step 5: Zero and soft-delete the investment account ───────────────
    await client.query(
      `UPDATE accounts
       SET balance      = 0,
           status       = 'Inactive',
           is_deleted   = true,
           deleted_at   = NOW(),
           updated_at   = NOW()
       WHERE id = $1`,
      [investmentRow.account_id]
    );

    // ── Step 6: Mark investment_accounts row as cancelled ─────────────────
    await client.query(
      `UPDATE investment_accounts
       SET status       = 'cancelled',
           narration    = COALESCE(narration, '') || ' | REVERSED: ' || $1,
           updated_at   = NOW()
       WHERE id = $2`,
      [reason.trim(), investmentRow.id]
    );

    // ── Step 7: Mark all linked transactions as reversed ──────────────────
    // Catches: the transfer_in on the investment account,
    //          the transfer_out on the source account,
    //          any deposit transaction (cash-funded path)
    await client.query(
      `UPDATE transactions
       SET status          = 'reversed',
           reversed_at     = NOW(),
           reversed_by     = $1,
           reversal_reason = $2
       WHERE account_id = $3
         AND status IN ('completed', 'approved')
         AND is_deleted = false`,
      [reversed_by, reason.trim(), investmentRow.account_id]
    );

    // Also reverse the transfer_out on the source side if it exists
    if (investmentRow.paired_tx_id) {
      await client.query(
        `UPDATE transactions
         SET status          = 'reversed',
             reversed_at     = NOW(),
             reversed_by     = $1,
             reversal_reason = $2
         WHERE id = $3`,
        [reversed_by, reason.trim(), investmentRow.paired_tx_id]
      );
    }

    // ── Step 8: Mark original JE reversed ────────────────────────────────
    if (investmentRow.je_id) {
      await client.query(
        `UPDATE journal_entries
         SET status          = 'reversed',
             reversed_at     = NOW(),
             reversal_reason = $1
         WHERE id = $2`,
        [reason.trim(), investmentRow.je_id]
      );
    }

    // ── Step 9: Post reversal journal entry ───────────────────────────────
    //
    // TRANSFER-FUNDED path (original was Dr Source Liability / Cr Investment Liability):
    //   Reversal:  Dr Investment Liability  (undo the credit — liability down)
    //              Cr Source Liability       (restore what we owe source acct holder)
    //
    // CASH-FUNDED path (original was Dr Cash / Cr Investment Liability):
    //   Reversal:  Dr Investment Liability  (undo the credit — liability down)
    //              Cr Cash / Float           (cash goes back out)

    const invCoaId = await resolveCOA(client, company_id, fixedDepositCoaCode());

    let drCoaId, crCoaId;
    let drDesc, crDesc;

    if (investmentRow.source_account_id) {
      // Transfer-funded reversal
      const srcCoaId = await resolveCOA(
        client, company_id,
        depositCoaCode(investmentRow.source_account_type)
      );
      drCoaId = invCoaId;
      crCoaId = srcCoaId;
      drDesc  = `Reverse investment — undo investment liability (${investmentRow.inv_account_number})`;
      crDesc  = `Reverse investment — restore source account liability`;
    } else {
      // Cash-funded reversal — need to know what payment method was used
      // Fall back to the funding transaction's payment_method
      const pmRes = await client.query(
        `SELECT payment_method FROM transactions
         WHERE id = $1`,
        [investmentRow.funding_tx_id]
      );
      const pm = pmRes.rows[0]?.payment_method ?? "cash";
      const cashCoaId_ = await resolveCOA(client, company_id, cashCoaCode(pm));

      drCoaId = invCoaId;
      crCoaId = cashCoaId_;
      drDesc  = `Reverse investment — undo investment liability (${investmentRow.inv_account_number})`;
      crDesc  = `Reverse investment — cash/float restored`;
    }

    await postJournalEntry(client, {
      companyId:   company_id,
      description: `Investment reversal — ${investmentRow.reference} — ${reason.trim()}`,
      entryDate,
      source:      "investment_reversal",
      sourceId:    investmentRow.id,
      sourceTable: "investment_accounts",
      createdBy:   reversed_by,
      lines: [
        {
          coaId:      drCoaId,
          dc:         "debit",
          amount:     reversalAmount,
          description: drDesc,
          customerId: investmentRow.customer_id,
          accountId:  investmentRow.account_id,
          staffId:    reversed_by,
        },
        {
          coaId:      crCoaId,
          dc:         "credit",
          amount:     reversalAmount,
          description: crDesc,
          customerId:  investmentRow.customer_id,
          accountId:   investmentRow.source_account_id ?? investmentRow.account_id,
          staffId:     reversed_by,
        },
      ],
    });

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: `Investment ${investmentRow.reference} fully reversed`,
      data: {
        investment_reference:  investmentRow.reference,
        investment_id:         investmentRow.id,
        account_id:            investmentRow.account_id,
        account_number:        investmentRow.inv_account_number,
        original_je_reference: investmentRow.je_ref,
        principal_reversed:    reversalAmount,
        source_account_restored: sourceRestored,
        source_account_id:     investmentRow.source_account_id ?? null,
        reversal_date:         entryDate,
        reversed_by,
        reason: reason.trim(),
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("reverseInvestmentCreation error:", err.message);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investments/lookup/:reference
// Quick lookup by any reference — returns investment details before reversing.
// Lets the UI show a preview card before the staff confirms.
// ─────────────────────────────────────────────────────────────────────────────
export const lookupInvestmentForReversal = async (req, res) => {
  const { reference } = req.params;
  const { company_id } = req.query;

  if (!reference || !company_id)
    return res.status(400).json({ success: false, message: "reference and company_id are required" });

  try {
    // Try all reference types in one query using OR
    const result = await pool.query(
      `SELECT
         ia.id,
         ia.reference            AS inv_reference,
         ia.product_type,
         ia.principal_amount,
         ia.interest_rate,
         ia.term_months,
         ia.start_date,
         ia.maturity_date,
         ia.status               AS investment_status,
         ia.auto_rollover,
         a.id                    AS account_id,
         a.account_number,
         a.account_type,
         a.balance               AS current_balance,
         a.status                AS account_status,
         c.name                  AS customer_name,
         c.phone_number          AS customer_phone,
         c.account_number        AS customer_account_number,
         je.reference_no         AS je_reference,
         je.id                   AS je_id,
         je.status               AS je_status,
         je.entry_date           AS je_date,
         -- source account info (if funded by transfer)
         src_a.id                AS source_account_id,
         src_a.account_number    AS source_account_number,
         src_a.account_type      AS source_account_type,
         src_a.balance           AS source_current_balance
       FROM investment_accounts ia
       JOIN accounts a   ON a.id = ia.account_id
       JOIN customers c  ON c.id = ia.customer_id
       -- Link to original JE via the first transaction on the investment account
       LEFT JOIN journal_entries je
         ON je.source_id = (
           SELECT id FROM transactions
           WHERE account_id = ia.account_id
             AND type IN ('deposit','transfer_in')
             AND status IN ('completed','approved')
           ORDER BY created_at ASC LIMIT 1
         )
         AND je.company_id = $2
       -- Source account (transfer-funded)
       LEFT JOIN transactions tx_in
         ON tx_in.account_id = ia.account_id
         AND tx_in.type = 'transfer_in'
       LEFT JOIN transactions tx_out
         ON tx_out.id = tx_in.source_transaction_id
         AND tx_out.type = 'transfer_out'
       LEFT JOIN accounts src_a ON src_a.id = tx_out.account_id
       WHERE ia.company_id = $2
         AND (
           ia.reference  = $1 OR
           je.reference_no = $1 OR
           a.id::text    = $1 OR
           ia.id::text   = $1
         )
       LIMIT 1`,
      [reference.trim(), company_id]
    );

    if (result.rowCount === 0)
      return res.status(404).json({
        success: false,
        message: `Nothing found matching "${reference}". Check the reference and try again.`,
      });

    const row = result.rows[0];

    // Determine if reversible
    const reversible =
      row.investment_status === "active" &&
      row.je_status !== "reversed";

    const blockReason = !reversible
      ? row.investment_status === "cancelled"
        ? "Already cancelled"
        : row.investment_status === "matured"
        ? "Already matured — use maturity reversal"
        : row.je_status === "reversed"
        ? "Journal entry already reversed"
        : "Cannot reverse"
      : null;

    return res.status(200).json({
      success: true,
      data: {
        ...row,
        reversible,
        block_reason: blockReason,
      },
    });

  } catch (err) {
    console.error("lookupInvestmentForReversal error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};
