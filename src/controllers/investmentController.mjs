// controllers/investmentController.mjs
// ─── Fixed Deposit & Investment Account Management ────────────────────────────
//
// Endpoints:
//   POST   /api/investments/create          — open an investment account
//   POST   /api/investments/fund            — fund an existing investment
//   GET    /api/investments/products        — list investment products
//   GET    /api/investments/customer/:id    — customer's investment portfolio
//   POST   /api/investments/:id/mature      — mark investment matured / pay out
//   POST   /api/investments/:id/rollover    — rollover on maturity
//   GET    /api/investments/:id             — single investment details
//
// ─────────────────────────────────────────────────────────────────────────────

import pool from "../db.mjs";
import {
  postJournalEntry,
  resolveCOA,
  depositCoaCode,
  cashCoaCode,
} from "../services/accountingHelper.mjs";

// ─── COA helpers specific to investments ─────────────────────────────────────
// Adjust codes to match your actual chart of accounts.

/** Fixed-deposit / term-deposit liability account */
const fixedDepositCoaCode = () => "2020-01"; // Term deposits liability

/** Investment income (interest payable) */
const interestPayableCoaCode = () => "2030-01"; // Accrued interest payable

/** Interest expense when paying out */
const interestExpenseCoaCode = () => "5010-01"; // Interest expense


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function calculateMaturityDate(startDate, termMonths) {
  const d = new Date(startDate);
  d.setMonth(d.getMonth() + Number(termMonths));
  return d;
}

function calculateExpectedReturn(principal, ratePercent, termMonths) {
  // Simple interest: I = P * R/100 * (T/12)
  const interest = (Number(principal) * Number(ratePercent) / 100) * (Number(termMonths) / 12);
  return {
    interest: parseFloat(interest.toFixed(2)),
    maturityValue: parseFloat((Number(principal) + interest).toFixed(2)),
  };
}

function generateInvestmentRef() {
  return `INV-${new Date().getFullYear()}-${Math.floor(Math.random() * 900000 + 100000)}`;
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investments/products
// Returns the catalogue of investment products the company offers.
// ─────────────────────────────────────────────────────────────────────────────
export const getInvestmentProducts = async (req, res) => {
  const { company_id } = req.params;

  // If you have a DB table for products, query it here.
  // Falling back to a sensible hard-coded catalogue that most MFIs offer.
  const products = [
    {
      id: "fixed_deposit",
      name: "Fixed Deposit",
      icon: "🔒",
      description: "Lock funds for a fixed term and earn guaranteed interest.",
      min_amount: 500,
      min_term_months: 1,
      max_term_months: 60,
      default_rate: 18,          // % per annum
      rate_type: "fixed",
      early_withdrawal_penalty: 2.5, // % of principal
      auto_rollover: false,
      coa_code: "2020-01",
    },
    {
      id: "treasury_bill",
      name: "Treasury Bill",
      icon: "📜",
      description: "Government-backed short-term securities via your MFI.",
      min_amount: 1000,
      min_term_months: 3,
      max_term_months: 12,
      default_rate: 22,
      rate_type: "fixed",
      early_withdrawal_penalty: 0,
      auto_rollover: false,
      coa_code: "2020-02",
    },
    {
      id: "susu_plus",
      name: "Susu Plus",
      icon: "📈",
      description: "Enhanced Susu with bonus interest on milestones.",
      min_amount: 100,
      min_term_months: 6,
      max_term_months: 24,
      default_rate: 15,
      rate_type: "tiered",
      early_withdrawal_penalty: 1,
      auto_rollover: true,
      coa_code: "2010-01",
    },
    {
      id: "investment_bond",
      name: "Investment Bond",
      icon: "🏛️",
      description: "Medium-to-long term bond with quarterly interest payments.",
      min_amount: 5000,
      min_term_months: 12,
      max_term_months: 120,
      default_rate: 24,
      rate_type: "compound",
      early_withdrawal_penalty: 5,
      auto_rollover: false,
      coa_code: "2020-03",
    },
    {
      id: "money_market",
      name: "Money Market",
      icon: "💹",
      description: "Flexible high-yield account with 30-day notice withdrawal.",
      min_amount: 2000,
      min_term_months: 0,        // open-ended
      max_term_months: null,
      default_rate: 20,
      rate_type: "variable",
      early_withdrawal_penalty: 0,
      auto_rollover: true,
      coa_code: "2020-04",
    },
  ];

  return res.status(200).json({ status: "success", data: products });
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investments/create
// Opens a new investment account for a customer AND funds it from a source
// account (or cash) in a single atomic transaction.
//
// Body:
//   customer_id, company_id, created_by
//   product_type         — "fixed_deposit" | "treasury_bill" | etc.
//   principal_amount     — initial investment
//   interest_rate        — % per annum
//   term_months          — duration
//   source_account_id    — account to debit (null = cash/walk-in)
//   payment_method       — "cash" | "momo" | "bank_transfer"
//   auto_rollover        — bool
//   narration            — optional note
//   sms_notify_receiver  — bool
//   sms_receiver_template
// ─────────────────────────────────────────────────────────────────────────────
export const createInvestment = async (req, res) => {
  const {
    customer_id,
    company_id,
    created_by,
    product_type,
    principal_amount,
    interest_rate,
    term_months,
    source_account_id,   // nullable — if null, treat as cash walk-in
    payment_method = "cash",
    auto_rollover = false,
    narration,
    sms_notify_receiver = false,
    sms_receiver_template,
    sms_receiver_name,
    sms_receiver_phone,
  } = req.body;

  // ── Validation ───────────────────────────────────────────────────────────
  if (!customer_id || !company_id || !created_by || !product_type)
    return res.status(400).json({ success: false, message: "customer_id, company_id, created_by, and product_type are required" });

  if (!principal_amount || Number(principal_amount) <= 0)
    return res.status(400).json({ success: false, message: "Principal amount must be greater than 0" });

  if (!term_months && term_months !== 0)
    return res.status(400).json({ success: false, message: "term_months is required" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ── 1. Validate source account (if funding from account) ─────────────
    let sourceAccount = null;
    if (source_account_id) {
      const accRes = await client.query(
        `SELECT id, balance, account_type, customer_id, status
         FROM accounts
         WHERE id = $1 AND company_id = $2 AND is_deleted = false
         FOR UPDATE`,
        [source_account_id, company_id]
      );

      if (accRes.rowCount === 0)
        throw new Error("Source account not found");

      sourceAccount = accRes.rows[0];

      if (sourceAccount.status === "Inactive")
        throw new Error("Source account is inactive");

      if (Number(sourceAccount.balance) < Number(principal_amount))
        throw new Error(`Insufficient balance in source account. Available: GHS ${Number(sourceAccount.balance).toFixed(2)}`);
    }

    // ── 2. Validate customer ──────────────────────────────────────────────
    const custRes = await client.query(
      `SELECT id, name, status FROM customers WHERE id = $1 AND company_id = $2 AND is_deleted = false`,
      [customer_id, company_id]
    );

    if (custRes.rowCount === 0)
      throw new Error("Customer not found");

    if (custRes.rows[0].status === "Inactive")
      throw new Error("Customer account is inactive");

    // ── 3. Generate investment account number ─────────────────────────────
    const ref = generateInvestmentRef();
    const startDate = new Date();
    const maturityDate = term_months > 0
      ? calculateMaturityDate(startDate, term_months)
      : null;

    const { interest, maturityValue } = calculateExpectedReturn(
      principal_amount, interest_rate || 0, term_months || 12
    );

    // ── 4. Create investment account in `accounts` table ─────────────────
    // Uses account_type = product_type so it flows through your existing schema
    const accountNumber = await generateInvestmentAccountNumber(client, customer_id, product_type);

    const invAccountRes = await client.query(
      `INSERT INTO accounts
         (customer_id, company_id, account_type, balance, account_number,
          interest_rate, status, created_by, created_by_type,
          minimum_balance, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Active', $7, 'staff', $4, NOW(), NOW())
       RETURNING *`,
      [
        customer_id, company_id, product_type,
        principal_amount, accountNumber,
        interest_rate || 0, created_by,
      ]
    );

    const invAccount = invAccountRes.rows[0];

    // ── 5. Create investment record (investment_accounts table) ───────────
    // Upsert-create this table if it doesn't exist yet — handled in migration.
    const invRes = await client.query(
      `INSERT INTO investment_accounts
         (account_id, customer_id, company_id, product_type, principal_amount,
          interest_rate, term_months, start_date, maturity_date,
          expected_interest, expected_maturity_value, auto_rollover,
          status, reference, narration, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13,$14,$15,NOW())
       RETURNING *`,
      [
        invAccount.id, customer_id, company_id,
        product_type, principal_amount,
        interest_rate || 0, term_months,
        startDate.toISOString().slice(0, 10),
        maturityDate ? maturityDate.toISOString().slice(0, 10) : null,
        interest, maturityValue,
        auto_rollover, ref, narration || null, created_by,
      ]
    );

    const investment = invRes.rows[0];

    // ── 6. Create funding transaction ─────────────────────────────────────
    // If source_account_id → transfer_out from source, transfer_in to investment
    // If cash → deposit transaction on investment account

    let fundingTxId;

    if (source_account_id && sourceAccount) {
      // Debit source account
      await client.query(
        `UPDATE accounts SET balance = balance - $1, last_activity_at = NOW() WHERE id = $2`,
        [principal_amount, source_account_id]
      );

      const outTxRes = await client.query(
        `INSERT INTO transactions
           (account_id, company_id, type, amount, description, created_by, created_by_type, status)
         VALUES ($1,$2,'transfer_out',$3,$4,$5,'staff','completed') RETURNING id`,
        [source_account_id, company_id, principal_amount,
         narration || `Investment transfer — ${product_type} ${ref}`, created_by]
      );

      fundingTxId = outTxRes.rows[0].id;

      // Credit investment account
      const inTxRes = await client.query(
        `INSERT INTO transactions
           (account_id, company_id, type, amount, description, created_by,
            created_by_type, status, source_transaction_id)
         VALUES ($1,$2,'transfer_in',$3,$4,$5,'staff','completed',$6) RETURNING id`,
        [invAccount.id, company_id, principal_amount,
         narration || `Investment funded — ${product_type} ${ref}`,
         created_by, fundingTxId]
      );

      // ── 7a. Journal Entry (transfer between accounts) ─────────────────
      // Dr  Source deposit liability   (source account ↓)
      // Cr  Investment deposit liability (investment account ↑)
      const sourceCoaId = await resolveCOA(client, company_id, depositCoaCode(sourceAccount.account_type));
      const invCoaId    = await resolveCOA(client, company_id, fixedDepositCoaCode());

      await postJournalEntry(client, {
        companyId:   company_id,
        description: narration || `Investment funding — ${product_type} — ${ref}`,
        entryDate:   startDate.toISOString().slice(0, 10),
        source:      "investment_funding",
        sourceId:    fundingTxId,
        sourceTable: "transactions",
        createdBy:   created_by,
        lines: [
          {
            coaId:      sourceCoaId,
            dc:         "debit",
            amount:     Number(principal_amount),
            description: `Funds moved from ${sourceAccount.account_type} to investment`,
            customerId: customer_id,
            accountId:  source_account_id,
            staffId:    created_by,
          },
          {
            coaId:      invCoaId,
            dc:         "credit",
            amount:     Number(principal_amount),
            description: `Investment account funded — ${product_type}`,
            customerId: customer_id,
            accountId:  invAccount.id,
            staffId:    created_by,
          },
        ],
      });

    } else {
      // Cash walk-in — deposit directly
      const cashTxRes = await client.query(
        `INSERT INTO transactions
           (account_id, company_id, type, amount, description, created_by,
            created_by_type, status, payment_method)
         VALUES ($1,$2,'deposit',$3,$4,$5,'staff','completed',$6) RETURNING id`,
        [invAccount.id, company_id, principal_amount,
         narration || `Investment deposit — ${product_type} ${ref}`,
         created_by, payment_method]
      );

      fundingTxId = cashTxRes.rows[0].id;

      // ── 7b. Journal Entry (cash → investment) ─────────────────────────
      // Dr  Cash / Float     (asset ↑)
      // Cr  Investment deposit liability (liability ↑)
      const cashCoaId = await resolveCOA(client, company_id, cashCoaCode(payment_method));
      const invCoaId  = await resolveCOA(client, company_id, fixedDepositCoaCode());

      await postJournalEntry(client, {
        companyId:   company_id,
        description: narration || `Cash investment — ${product_type} — ${ref}`,
        entryDate:   startDate.toISOString().slice(0, 10),
        source:      "investment_deposit",
        sourceId:    fundingTxId,
        sourceTable: "transactions",
        createdBy:   created_by,
        lines: [
          {
            coaId:      cashCoaId,
            dc:         "debit",
            amount:     Number(principal_amount),
            description: `Cash received for investment`,
            customerId: customer_id,
            accountId:  invAccount.id,
            staffId:    created_by,
          },
          {
            coaId:      invCoaId,
            dc:         "credit",
            amount:     Number(principal_amount),
            description: `Investment liability created — ${product_type}`,
            customerId: customer_id,
            accountId:  invAccount.id,
            staffId:    created_by,
          },
        ],
      });
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: `Investment account opened successfully`,
      data: {
        investment,
        account:          invAccount,
        reference:        ref,
        principal:        Number(principal_amount),
        expected_interest: interest,
        maturity_value:   maturityValue,
        maturity_date:    maturityDate ? maturityDate.toISOString().slice(0, 10) : null,
        funding_tx_id:    fundingTxId,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createInvestment error:", err.message);
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investments/fund
// Top-up an EXISTING investment account (additional deposit).
// ─────────────────────────────────────────────────────────────────────────────
export const fundInvestment = async (req, res) => {
  const {
    investment_account_id,
    amount,
    company_id,
    created_by,
    source_account_id,
    payment_method = "cash",
    narration,
  } = req.body;

  if (!investment_account_id || !amount || Number(amount) <= 0)
    return res.status(400).json({ success: false, message: "investment_account_id and amount are required" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Fetch investment account
    const invAccRes = await client.query(
      `SELECT a.*, ia.product_type, ia.id AS investment_id, ia.principal_amount,
              ia.term_months, ia.interest_rate
       FROM accounts a
       JOIN investment_accounts ia ON ia.account_id = a.id
       WHERE a.id = $1 AND a.company_id = $2 AND a.is_deleted = false
       FOR UPDATE OF a`,
      [investment_account_id, company_id]
    );

    if (invAccRes.rowCount === 0)
      throw new Error("Investment account not found");

    const invAcc = invAccRes.rows[0];

    if (invAcc.status === "Inactive")
      throw new Error("Investment account is inactive");

    // Optional: validate source account
    let sourceAccount = null;
    if (source_account_id) {
      const srcRes = await client.query(
        `SELECT id, balance, account_type FROM accounts
         WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [source_account_id, company_id]
      );
      if (srcRes.rowCount === 0) throw new Error("Source account not found");
      sourceAccount = srcRes.rows[0];
      if (Number(sourceAccount.balance) < Number(amount))
        throw new Error(`Insufficient balance. Available: GHS ${Number(sourceAccount.balance).toFixed(2)}`);

      await client.query(
        `UPDATE accounts SET balance = balance - $1, last_activity_at = NOW() WHERE id = $2`,
        [amount, source_account_id]
      );
    }

    // Credit investment account
    await client.query(
      `UPDATE accounts SET balance = balance + $1, last_activity_at = NOW() WHERE id = $2`,
      [amount, investment_account_id]
    );

    // Update principal in investment_accounts
    await client.query(
      `UPDATE investment_accounts
       SET principal_amount = principal_amount + $1,
           expected_interest = expected_interest + $2,
           expected_maturity_value = expected_maturity_value + $3
       WHERE account_id = $4`,
      [
        amount,
        ...Object.values(calculateExpectedReturn(amount, invAcc.interest_rate, invAcc.term_months)),
        investment_account_id,
      ]
    );

    const txRef = generateInvestmentRef().replace("INV", "TOP");

    // Transaction records
    let fundingTxId;
    if (source_account_id && sourceAccount) {
      const outRes = await client.query(
        `INSERT INTO transactions
           (account_id, company_id, type, amount, description, created_by, created_by_type, status)
         VALUES ($1,$2,'transfer_out',$3,$4,$5,'staff','completed') RETURNING id`,
        [source_account_id, company_id, amount,
         narration || `Top-up investment — ${invAcc.product_type} ${txRef}`, created_by]
      );
      fundingTxId = outRes.rows[0].id;

      await client.query(
        `INSERT INTO transactions
           (account_id, company_id, type, amount, description, created_by,
            created_by_type, status, source_transaction_id)
         VALUES ($1,$2,'transfer_in',$3,$4,$5,'staff','completed',$6)`,
        [investment_account_id, company_id, amount,
         narration || `Investment top-up — ${invAcc.product_type} ${txRef}`,
         created_by, fundingTxId]
      );
    } else {
      const txRes = await client.query(
        `INSERT INTO transactions
           (account_id, company_id, type, amount, description, created_by,
            created_by_type, status, payment_method)
         VALUES ($1,$2,'deposit',$3,$4,$5,'staff','completed',$6) RETURNING id`,
        [investment_account_id, company_id, amount,
         narration || `Investment top-up — ${invAcc.product_type} ${txRef}`,
         created_by, payment_method]
      );
      fundingTxId = txRes.rows[0].id;
    }

    // Journal Entry
    const invCoaId  = await resolveCOA(client, company_id, fixedDepositCoaCode());
    const sourceCoaId = source_account_id && sourceAccount
      ? await resolveCOA(client, company_id, depositCoaCode(sourceAccount.account_type))
      : await resolveCOA(client, company_id, cashCoaCode(payment_method));

    await postJournalEntry(client, {
      companyId:   company_id,
      description: narration || `Investment top-up — ${invAcc.product_type}`,
      entryDate:   new Date().toISOString().slice(0, 10),
      source:      "investment_topup",
      sourceId:    fundingTxId,
      sourceTable: "transactions",
      createdBy:   created_by,
      lines: [
        {
          coaId:      sourceCoaId,
          dc:         "debit",
          amount:     Number(amount),
          description: source_account_id ? "Source account debited for top-up" : "Cash received for top-up",
          customerId: invAcc.customer_id,
          accountId:  source_account_id || investment_account_id,
          staffId:    created_by,
        },
        {
          coaId:      invCoaId,
          dc:         "credit",
          amount:     Number(amount),
          description: "Investment liability increased",
          customerId: invAcc.customer_id,
          accountId:  investment_account_id,
          staffId:    created_by,
        },
      ],
    });

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Investment topped up successfully",
      data: { investment_account_id, amount_added: amount, reference: txRef },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("fundInvestment error:", err.message);
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investments/customer/:customerId
// Return customer's full investment portfolio
// ─────────────────────────────────────────────────────────────────────────────
export const getCustomerInvestments = async (req, res) => {
  const { customerId } = req.params;

  try {
    const result = await pool.query(
      `SELECT
         ia.*,
         a.balance         AS current_balance,
         a.account_number,
         a.status          AS account_status,
         a.created_at      AS account_created_at,
         c.name            AS customer_name,
         c.phone_number    AS customer_phone,
         -- Days to maturity
         CASE
           WHEN ia.maturity_date IS NOT NULL
           THEN (ia.maturity_date - CURRENT_DATE)
           ELSE NULL
         END AS days_to_maturity,
         -- Is matured?
         CASE
           WHEN ia.maturity_date IS NOT NULL AND ia.maturity_date <= CURRENT_DATE
                AND ia.status = 'active'
           THEN true ELSE false
         END AS is_matured
       FROM investment_accounts ia
       JOIN accounts a ON a.id = ia.account_id
       JOIN customers c ON c.id = ia.customer_id
       WHERE ia.customer_id = $1
         AND ia.is_deleted IS DISTINCT FROM true
       ORDER BY ia.created_at DESC`,
      [customerId]
    );

    const summary = result.rows.reduce(
      (acc, inv) => ({
        total_invested:        acc.total_invested        + Number(inv.principal_amount),
        total_expected_return: acc.total_expected_return + Number(inv.expected_maturity_value),
        total_interest:        acc.total_interest        + Number(inv.expected_interest),
        active_count:          acc.active_count          + (inv.status === "active" ? 1 : 0),
        matured_count:         acc.matured_count         + (inv.status === "matured" ? 1 : 0),
      }),
      { total_invested: 0, total_expected_return: 0, total_interest: 0, active_count: 0, matured_count: 0 }
    );

    return res.status(200).json({
      status:  "success",
      data:    result.rows,
      summary,
    });
  } catch (err) {
    console.error("getCustomerInvestments error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investments/:id
// Single investment record with full details
// ─────────────────────────────────────────────────────────────────────────────
export const getInvestmentById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT ia.*, a.balance AS current_balance, a.account_number,
              c.name AS customer_name, c.phone_number
       FROM investment_accounts ia
       JOIN accounts a ON a.id = ia.account_id
       JOIN customers c ON c.id = ia.customer_id
       WHERE ia.id = $1`,
      [id]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ status: "fail", message: "Investment not found" });

    return res.status(200).json({ status: "success", data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investments/:id/mature
// Matures an investment — pays principal + interest back to a target account
// or as cash payout.
// ─────────────────────────────────────────────────────────────────────────────
export const matureInvestment = async (req, res) => {
  const { id } = req.params;
  const {
    company_id,
    processed_by,
    target_account_id,  // where to credit maturity value (nullable = cash)
    payment_method = "cash",
    narration,
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Fetch investment
    const invRes = await client.query(
      `SELECT ia.*, a.balance AS current_balance, a.account_type,
              a.customer_id AS acc_customer_id
       FROM investment_accounts ia
       JOIN accounts a ON a.id = ia.account_id
       WHERE ia.id = $1 AND ia.company_id = $2 FOR UPDATE OF a`,
      [id, company_id]
    );

    if (invRes.rowCount === 0) throw new Error("Investment not found");

    const inv = invRes.rows[0];
    if (inv.status !== "active") throw new Error(`Investment is already ${inv.status}`);

    // Recompute actual interest (use stored rate & term)
    const { interest, maturityValue } = calculateExpectedReturn(
      inv.principal_amount, inv.interest_rate, inv.term_months
    );

    const principal = Number(inv.current_balance); // use actual balance
    const payout    = parseFloat((principal + interest).toFixed(2));

    // Mark investment closed
    await client.query(
      `UPDATE investment_accounts
       SET status = 'matured', actual_interest = $1, actual_maturity_value = $2,
           matured_at = NOW()
       WHERE id = $3`,
      [interest, payout, id]
    );

    // Zero out investment account balance
    await client.query(
      `UPDATE accounts SET balance = 0, last_activity_at = NOW() WHERE id = $1`,
      [inv.account_id]
    );

    // Record payout transaction on investment account
    const payoutTxRes = await client.query(
      `INSERT INTO transactions
         (account_id, company_id, type, amount, description,
          created_by, created_by_type, status)
       VALUES ($1,$2,'withdrawal',$3,$4,$5,'staff','completed') RETURNING id`,
      [inv.account_id, company_id, payout,
       narration || `Maturity payout — ${inv.product_type} ${inv.reference}`,
       processed_by]
    );

    const payoutTxId = payoutTxRes.rows[0].id;

    // If target account specified, credit it
    if (target_account_id) {
      await client.query(
        `UPDATE accounts SET balance = balance + $1, last_activity_at = NOW() WHERE id = $2`,
        [payout, target_account_id]
      );
      await client.query(
        `INSERT INTO transactions
           (account_id, company_id, type, amount, description,
            created_by, created_by_type, status, source_transaction_id)
         VALUES ($1,$2,'transfer_in',$3,$4,$5,'staff','completed',$6)`,
        [target_account_id, company_id, payout,
         `Maturity credited from ${inv.product_type}`, processed_by, payoutTxId]
      );
    }

    // Journal Entry for maturity
    // Dr  Investment liability   (settled — liability ↓)
    // Dr  Interest expense       (cost of interest)
    // Cr  Cash / target account  (funds out)
    const invCoaId      = await resolveCOA(client, company_id, fixedDepositCoaCode());
    const intExpCoaId   = await resolveCOA(client, company_id, interestExpenseCoaCode());
    const payoutCoaId   = target_account_id
      ? await resolveCOA(client, company_id, depositCoaCode("savings"))
      : await resolveCOA(client, company_id, cashCoaCode(payment_method));

    await postJournalEntry(client, {
      companyId:   company_id,
      description: narration || `Investment maturity — ${inv.product_type} — ${inv.reference}`,
      entryDate:   new Date().toISOString().slice(0, 10),
      source:      "investment_maturity",
      sourceId:    payoutTxId,
      sourceTable: "transactions",
      createdBy:   processed_by,
      lines: [
        {
          coaId:      invCoaId,
          dc:         "debit",
          amount:     principal,
          description: "Investment principal settled",
          customerId: inv.customer_id,
          accountId:  inv.account_id,
          staffId:    processed_by,
        },
        {
          coaId:      intExpCoaId,
          dc:         "debit",
          amount:     interest,
          description: "Interest paid on maturity",
          customerId: inv.customer_id,
          accountId:  inv.account_id,
          staffId:    processed_by,
        },
        {
          coaId:      payoutCoaId,
          dc:         "credit",
          amount:     payout,
          description: target_account_id ? "Maturity credited to target account" : "Cash paid out on maturity",
          customerId: inv.customer_id,
          accountId:  target_account_id || inv.account_id,
          staffId:    processed_by,
        },
      ],
    });

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Investment matured and payout processed",
      data: {
        investment_id:   id,
        principal_paid:  principal,
        interest_paid:   interest,
        total_payout:    payout,
        target_account:  target_account_id || "cash",
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("matureInvestment error:", err.message);
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investments/:id/rollover
// Rollover a matured investment into a new term.
// ─────────────────────────────────────────────────────────────────────────────
export const rolloverInvestment = async (req, res) => {
  const { id } = req.params;
  const {
    company_id,
    processed_by,
    new_term_months,
    new_interest_rate,
    include_interest = true, // rollover with interest
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const invRes = await client.query(
      `SELECT ia.*, a.balance FROM investment_accounts ia
       JOIN accounts a ON a.id = ia.account_id
       WHERE ia.id = $1 AND ia.company_id = $2 FOR UPDATE OF a`,
      [id, company_id]
    );

    if (invRes.rowCount === 0) throw new Error("Investment not found");
    const inv = invRes.rows[0];

    const termMonths  = new_term_months    || inv.term_months;
    const rate        = new_interest_rate  || inv.interest_rate;
    const principal   = include_interest
      ? Number(inv.expected_maturity_value)
      : Number(inv.principal_amount);

    const { interest, maturityValue } = calculateExpectedReturn(principal, rate, termMonths);

    const newStartDate    = new Date();
    const newMaturityDate = calculateMaturityDate(newStartDate, termMonths);
    const newRef          = generateInvestmentRef();

    // Reset investment
    await client.query(
      `UPDATE investment_accounts
       SET status = 'active',
           principal_amount = $1,
           interest_rate = $2,
           term_months = $3,
           start_date = $4,
           maturity_date = $5,
           expected_interest = $6,
           expected_maturity_value = $7,
           reference = $8,
           actual_interest = NULL,
           actual_maturity_value = NULL,
           matured_at = NULL
       WHERE id = $9`,
      [
        principal, rate, termMonths,
        newStartDate.toISOString().slice(0, 10),
        newMaturityDate.toISOString().slice(0, 10),
        interest, maturityValue, newRef, id,
      ]
    );

    // Update account balance
    await client.query(
      `UPDATE accounts SET balance = $1, last_activity_at = NOW() WHERE id = $2`,
      [principal, inv.account_id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Investment rolled over successfully",
      data: {
        investment_id:   id,
        new_reference:   newRef,
        new_principal:   principal,
        new_term_months: termMonths,
        new_rate:        rate,
        new_maturity:    newMaturityDate.toISOString().slice(0, 10),
        expected_return: maturityValue,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: generate investment account number
// ─────────────────────────────────────────────────────────────────────────────
async function generateInvestmentAccountNumber(client, customerId, productType) {
  const prefixMap = {
    fixed_deposit:   "FD",
    treasury_bill:   "TB",
    susu_plus:       "SP",
    investment_bond: "IB",
    money_market:    "MM",
  };
  const prefix = prefixMap[productType] ?? "IV";

  // Get customer base number
  const custRes = await client.query(
    `SELECT account_number FROM customers WHERE id = $1`,
    [customerId]
  );

  const base = custRes.rows[0]?.account_number ?? customerId.slice(0, 8).toUpperCase();

  // Count existing investment accounts
  const countRes = await client.query(
    `SELECT COUNT(*) FROM accounts WHERE customer_id = $1 AND account_type = $2`,
    [customerId, productType]
  );
  const seq = parseInt(countRes.rows[0].count) + 1;

  return `${base}${prefix}${seq}`;
}


// ─────────────────────────────────────────────────────────────────────────────
// DB MIGRATION HELPER
// Run once to create the investment_accounts table if it doesn't exist.
// Call GET /api/investments/migrate to run.
// ─────────────────────────────────────────────────────────────────────────────
export const runMigration = async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS investment_accounts (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id             UUID NOT NULL REFERENCES accounts(id),
        customer_id            UUID NOT NULL REFERENCES customers(id),
        company_id             UUID NOT NULL,
        product_type           VARCHAR(50) NOT NULL,
        principal_amount       NUMERIC(15,2) NOT NULL,
        interest_rate          NUMERIC(8,4) NOT NULL DEFAULT 0,
        term_months            INTEGER NOT NULL DEFAULT 12,
        start_date             DATE NOT NULL,
        maturity_date          DATE,
        expected_interest      NUMERIC(15,2) NOT NULL DEFAULT 0,
        expected_maturity_value NUMERIC(15,2) NOT NULL DEFAULT 0,
        actual_interest        NUMERIC(15,2),
        actual_maturity_value  NUMERIC(15,2),
        auto_rollover          BOOLEAN NOT NULL DEFAULT false,
        status                 VARCHAR(20) NOT NULL DEFAULT 'active',
        reference              VARCHAR(50) UNIQUE NOT NULL,
        narration              TEXT,
        created_by             UUID,
        matured_at             TIMESTAMPTZ,
        is_deleted             BOOLEAN DEFAULT false,
        created_at             TIMESTAMPTZ DEFAULT NOW(),
        updated_at             TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ia_customer ON investment_accounts(customer_id);
      CREATE INDEX IF NOT EXISTS idx_ia_company  ON investment_accounts(company_id);
      CREATE INDEX IF NOT EXISTS idx_ia_status   ON investment_accounts(status);
    `);

    return res.status(200).json({ status: "success", message: "Migration complete" });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};
