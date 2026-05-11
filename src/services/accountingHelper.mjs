// ─────────────────────────────────────────────────────────────
// accountingHelper.mjs
// ─────────────────────────────────────────────────────────────
// One place that knows how to:
//   1. Resolve COA account IDs by code for a company
//   2. Post a balanced journal entry inside an existing DB client
//
// All transaction controllers import from here so COA code
// lookups and JE logic never get duplicated.
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a chart-of-accounts row by its code for a given company.
 * Uses the same client so it participates in the caller's transaction.
 *
 * @param {object} client  - pg PoolClient (already in BEGIN)
 * @param {string} companyId
 * @param {string} code    - e.g. "1010-02", "2010-01", "4020"
 * @returns {string} uuid  - coa.id
 * @throws  if code not found (prevents silent mis-postings)
 */
export async function resolveCOA(client, companyId, code) {
  const res = await client.query(
    `SELECT id FROM chart_of_accounts
     WHERE company_id = $1 AND code = $2 AND is_deleted = false
     LIMIT 1`,
    [companyId, code]
  );
  if (res.rowCount === 0)
    throw new Error(`COA account "${code}" not found for company ${companyId}. Run accounting_seed.sql first.`);
  return res.rows[0].id;
}

/**
 * Generate the next journal reference number.
 * Uses the DB sequence so it's safe under concurrent requests.
 */
async function nextRef(client, companyId) {
  const res = await client.query(
    "SELECT generate_journal_ref($1) AS ref",
    [companyId]
  );
  return res.rows[0].ref;
}

/**
 * Post a balanced two-sided journal entry inside an existing transaction.
 *
 * @param {object} client
 * @param {object} opts
 *   companyId      string
 *   description    string
 *   entryDate      Date | string   — economic date of the event
 *   source         journal_source enum value
 *   sourceId       uuid            — FK to originating record
 *   sourceTable    string          — 'transactions' | 'commissions' | 'expenses' | 'revenue' | 'budgets'
 *   createdBy      uuid            — staff id
 *   lines          Array<{
 *                    coaId       uuid,
 *                    dc          'debit' | 'credit',
 *                    amount      number,
 *                    description string?,
 *                    customerId  uuid?,
 *                    accountId   uuid?,   -- susu savings account id
 *                    staffId     uuid?,
 *                  }>
 *
 * @returns {string} journal_entry id
 */
export async function postJournalEntry(client, opts) {
  const {
    companyId, description, entryDate, source,
    sourceId, sourceTable, createdBy, lines
  } = opts;

  // ── Validate balance before touching the DB ──────────────
  const totalDebits  = lines.filter(l => l.dc === "debit") .reduce((s, l) => s + Number(l.amount), 0);
  const totalCredits = lines.filter(l => l.dc === "credit").reduce((s, l) => s + Number(l.amount), 0);

  if (Math.abs(totalDebits - totalCredits) > 0.005)
    throw new Error(
      `Unbalanced journal entry for "${description}": ` +
      `debits=${totalDebits} credits=${totalCredits}`
    );

  if (totalDebits === 0)
    throw new Error(`Journal entry "${description}" has no amounts`);

  // ── Resolve active accounting period (optional, nullable) ─
  const periodRes = await client.query(
    `SELECT id FROM accounting_periods
     WHERE company_id = $1
       AND status = 'open'
       AND start_date <= $2
       AND end_date   >= $2
     ORDER BY start_date DESC LIMIT 1`,
    [companyId, entryDate]
  );
  const periodId = periodRes.rows[0]?.id || null;

  const ref = await nextRef(client, companyId);

  // ── Insert header (draft) ─────────────────────────────────
  const jeRes = await client.query(
    `INSERT INTO journal_entries
       (company_id, reference_no, description, entry_date,
        source, source_id, source_table, period_id,
        status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9)
     RETURNING id`,
    [companyId, ref, description,
     entryDate instanceof Date ? entryDate.toISOString().slice(0,10) : entryDate,
     source, sourceId, sourceTable, periodId, createdBy]
  );
  const jeId = jeRes.rows[0].id;

  // ── Insert lines ──────────────────────────────────────────
  for (const line of lines) {
    await client.query(
      `INSERT INTO journal_entry_lines
         (journal_entry_id, coa_id, debit_credit, amount,
          description, customer_id, account_id, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [jeId, line.coaId, line.dc, Number(line.amount),
       line.description || null,
       line.customerId  || null,
       line.accountId   || null,
       line.staffId     || null]
    );
  }

  // ── Post — triggers balance check + account_balances update ─
  await client.query(
    `UPDATE journal_entries
     SET status = 'posted', posted_by = $1, posted_at = NOW()
     WHERE id = $2`,
    [createdBy, jeId]
  );

  return jeId;
}

// ─────────────────────────────────────────────────────────────
// Convenience: pick the right cash/float COA based on
// payment method.  Returns the code string, not the uuid.
// ─────────────────────────────────────────────────────────────
export function cashCoaCode(paymentMethod, user) {
  console.log(paymentMethod, user);
  if (paymentMethod === "momo")  return "1010-01"; // MoMo float
  if (paymentMethod === "bank")  return "1020-01"; // Bank account
  if(user === 'teller') return "1010-02"
  return "1010-01";                                // cash cash equivalent (default)
}

// ─────────────────────────────────────────────────────────────
// Convenience: pick the right deposits liability COA based on
// account type.  Returns the code string.
// ─────────────────────────────────────────────────────────────
export function depositCoaCode(accountType) {
  const t = (accountType || "").toLowerCase();
  if (t.includes("fixed") || t.includes("lock")) return "2010-02";
  return "2010-01"; // daily susu (default)
}
