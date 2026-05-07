-- ============================================================
-- SUSU BANKING SYSTEM — FULL ACCOUNTING MIGRATION
-- Double-entry bookkeeping layer
-- ============================================================
-- Run order:
--   1. accounting_migration.sql  (this file)
--   2. accounting_seed.sql       (chart of accounts seed)
--   3. accounting_backfill.sql   (migrate existing data)
-- ============================================================


-- ============================================================
-- 1. ACCOUNT TYPES ENUM
-- ============================================================
-- The 5 fundamental account types in double-entry bookkeeping
-- Asset & Expense have normal DEBIT balances
-- Liability, Equity & Income have normal CREDIT balances

CREATE TYPE accounting_account_type AS ENUM (
  'asset',       -- Cash, bank accounts, receivables, fixed assets
  'liability',   -- Customer deposits, loans payable, payables
  'equity',      -- Owner capital, retained earnings
  'income',      -- Interest income, commission income, fees
  'expense'      -- Salaries, office costs, depreciation
);

CREATE TYPE account_category AS ENUM (
  -- Asset categories
  'cash_and_cash_equivalents',
  'bank_accounts',
  'accounts_receivable',
  'other_receivables',
  'fixed_assets',
  'accumulated_depreciation',
  'other_assets',

  -- Liability categories
  'customer_deposits',       -- susu savings = liability to the company
  'loans_payable',
  'accounts_payable',
  'accrued_liabilities',
  'other_liabilities',

  -- Equity categories
  'share_capital',
  'retained_earnings',
  'current_year_profit',

  -- Income categories
  'interest_income',
  'commission_income',
  'fee_income',
  'other_income',

  -- Expense categories
  'staff_costs',
  'depreciation_expense',
  'interest_expense',
  'operating_expense',
  'commission_expense',
  'other_expense'
);

CREATE TYPE normal_balance AS ENUM ('debit', 'credit');


-- ============================================================
-- 2. CHART OF ACCOUNTS
-- ============================================================
-- Every company gets their own chart of accounts.
-- Companies can create custom accounts (e.g. "Mobile Money Float").
-- Account codes follow standard numbering:
--   1xxx = Assets
--   2xxx = Liabilities
--   3xxx = Equity
--   4xxx = Income
--   5xxx = Expenses

CREATE TABLE chart_of_accounts (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Identity
  code              varchar(20)   NOT NULL,  -- e.g. "1010", "4100"
  name              varchar(150)  NOT NULL,  -- e.g. "Cash in Vault", "Commission Income"
  description       text,

  -- Classification
  account_type      accounting_account_type NOT NULL,
  category          account_category        NOT NULL,
  normal_balance    normal_balance  NOT NULL,

  -- Hierarchy — accounts can have sub-accounts
  parent_id         uuid          REFERENCES chart_of_accounts(id),
  is_sub_account    boolean       NOT NULL DEFAULT false,

  -- Opening balance (for migration & new accounts)
  opening_balance   numeric(18,2) NOT NULL DEFAULT 0,
  opening_date      date,

  -- Linking to existing system (nullable — custom accounts won't have these)
  linked_bank_account_id   uuid  REFERENCES accounts(id),  -- link to a customer account acting as vault
  
  -- Behaviour flags
  is_system_account boolean       NOT NULL DEFAULT false,   -- system accounts can't be deleted
  is_active         boolean       NOT NULL DEFAULT true,
  allow_manual_entry boolean      NOT NULL DEFAULT true,    -- false = only updated by system
  is_deleted        boolean       NOT NULL DEFAULT false,

  -- Audit
  created_by        uuid          NOT NULL,
  created_at        timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (company_id, code)
);

-- Enforce that account code starts with correct digit for type
ALTER TABLE chart_of_accounts
  ADD CONSTRAINT coa_code_type_check CHECK (
    (account_type = 'asset'     AND code ~ '^1')  OR
    (account_type = 'liability' AND code ~ '^2')  OR
    (account_type = 'equity'    AND code ~ '^3')  OR
    (account_type = 'income'    AND code ~ '^4')  OR
    (account_type = 'expense'   AND code ~ '^5')
  );

-- Normal balance must match account type
ALTER TABLE chart_of_accounts
  ADD CONSTRAINT coa_normal_balance_check CHECK (
    (account_type IN ('asset', 'expense')               AND normal_balance = 'debit')  OR
    (account_type IN ('liability', 'equity', 'income')  AND normal_balance = 'credit')
  );

CREATE INDEX idx_coa_company    ON chart_of_accounts(company_id);
CREATE INDEX idx_coa_type       ON chart_of_accounts(account_type);
CREATE INDEX idx_coa_parent     ON chart_of_accounts(parent_id);


-- ============================================================
-- 3. ACCOUNTING PERIODS
-- ============================================================
-- Tracks fiscal months/years. Used for period-end reporting.
-- Closing a period prevents new entries from being posted to it.

CREATE TYPE period_status AS ENUM ('open', 'closed', 'locked');

CREATE TABLE accounting_periods (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        varchar(50)   NOT NULL,   -- e.g. "January 2025"
  start_date  date          NOT NULL,
  end_date    date          NOT NULL,
  status      period_status NOT NULL DEFAULT 'open',
  closed_by   uuid,
  closed_at   timestamp,
  created_at  timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (company_id, start_date, end_date),
  CHECK (end_date > start_date)
);

CREATE INDEX idx_periods_company ON accounting_periods(company_id, start_date);


-- ============================================================
-- 4. JOURNAL ENTRIES (the heart of double-entry bookkeeping)
-- ============================================================
-- Every financial event creates ONE journal entry.
-- Each journal entry has >= 2 lines (debits and credits).
-- The sum of all debit amounts MUST equal the sum of all credit amounts.

CREATE TYPE journal_source AS ENUM (
  'customer_deposit',
  'customer_withdrawal',
  'loan_disbursement',
  'loan_repayment',
  'commission',
  'transfer',
  'expense',
  'revenue',
  'interest_accrual',
  'depreciation',
  'budget_float',
  'reversal',
  'manual',         -- manually entered by accountant
  'opening_balance' -- migration entries
);

CREATE TYPE journal_status AS ENUM (
  'draft',     -- not yet posted — does not affect balances
  'posted',    -- posted to ledger — affects balances
  'reversed'   -- reversed by a counter-entry
);

CREATE TABLE journal_entries (
  id              uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Reference
  reference_no    varchar(50)     NOT NULL,  -- e.g. "JE-2025-001234"
  description     text            NOT NULL,
  memo            text,

  -- Timing
  entry_date      date            NOT NULL,  -- the economic date (may differ from created_at)
  period_id       uuid            REFERENCES accounting_periods(id),

  -- Source
  source          journal_source  NOT NULL,
  source_id       uuid,           -- FK to the originating record (transaction, expense, etc.)
  source_table    varchar(50),    -- 'transactions', 'expenses', 'commissions', etc.

  -- Status
  status          journal_status  NOT NULL DEFAULT 'draft',
  posted_by       uuid,
  posted_at       timestamp,

  -- Reversal tracking
  is_reversal     boolean         NOT NULL DEFAULT false,
  reversed_entry_id uuid          REFERENCES journal_entries(id),
  reversed_by_entry_id uuid       REFERENCES journal_entries(id),

  -- Audit
  created_by      uuid            NOT NULL,
  created_at      timestamp       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamp       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_je_company     ON journal_entries(company_id, entry_date DESC);
CREATE INDEX idx_je_source      ON journal_entries(source_table, source_id);
CREATE INDEX idx_je_period      ON journal_entries(period_id);
CREATE INDEX idx_je_status      ON journal_entries(status);
CREATE INDEX idx_je_ref         ON journal_entries(company_id, reference_no);


-- ============================================================
-- 5. JOURNAL ENTRY LINES (the debit/credit lines)
-- ============================================================

CREATE TYPE debit_credit AS ENUM ('debit', 'credit');

CREATE TABLE journal_entry_lines (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid         NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  coa_id          uuid          NOT NULL REFERENCES chart_of_accounts(id),

  debit_credit    debit_credit  NOT NULL,
  amount          numeric(18,2) NOT NULL CHECK (amount > 0),

  description     text,

  -- Optional: link line to a specific customer / account / staff
  customer_id     uuid          REFERENCES customers(id),
  account_id      uuid          REFERENCES accounts(id),  -- the susu savings account
  staff_id        uuid,

  created_at      timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_jel_entry   ON journal_entry_lines(journal_entry_id);
CREATE INDEX idx_jel_coa     ON journal_entry_lines(coa_id);
CREATE INDEX idx_jel_account ON journal_entry_lines(account_id);


-- ============================================================
-- 6. ENFORCE DOUBLE-ENTRY BALANCE (trigger)
-- ============================================================
-- When a journal entry is POSTED, debits must equal credits.

CREATE OR REPLACE FUNCTION check_journal_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_debits  numeric(18,2);
  v_credits numeric(18,2);
BEGIN
  IF NEW.status = 'posted' AND OLD.status != 'posted' THEN
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE debit_credit = 'debit'),  0),
      COALESCE(SUM(amount) FILTER (WHERE debit_credit = 'credit'), 0)
    INTO v_debits, v_credits
    FROM journal_entry_lines
    WHERE journal_entry_id = NEW.id;

    IF v_debits <> v_credits THEN
      RAISE EXCEPTION
        'Journal entry % is unbalanced: debits=% credits=%',
        NEW.reference_no, v_debits, v_credits;
    END IF;

    IF v_debits = 0 THEN
      RAISE EXCEPTION
        'Journal entry % has no lines', NEW.reference_no;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_balance
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_journal_balance();


-- ============================================================
-- 7. GENERAL LEDGER VIEW
-- ============================================================
-- Running balance per account. This is the primary reporting view.

CREATE VIEW general_ledger AS
SELECT
  jel.id                  AS line_id,
  je.company_id,
  je.entry_date,
  je.reference_no,
  je.description          AS entry_description,
  jel.description         AS line_description,
  je.source,
  je.source_id,

  coa.id                  AS coa_id,
  coa.code                AS account_code,
  coa.name                AS account_name,
  coa.account_type,
  coa.category,
  coa.normal_balance,

  jel.debit_credit,
  jel.amount,

  -- Signed amount: positive = increases the account's balance
  CASE
    WHEN coa.normal_balance = 'debit'  AND jel.debit_credit = 'debit'  THEN  jel.amount
    WHEN coa.normal_balance = 'debit'  AND jel.debit_credit = 'credit' THEN -jel.amount
    WHEN coa.normal_balance = 'credit' AND jel.debit_credit = 'credit' THEN  jel.amount
    WHEN coa.normal_balance = 'credit' AND jel.debit_credit = 'debit'  THEN -jel.amount
  END AS signed_amount,

  -- Running balance within this account ordered by date + line id
  SUM(
    CASE
      WHEN coa.normal_balance = 'debit'  AND jel.debit_credit = 'debit'  THEN  jel.amount
      WHEN coa.normal_balance = 'debit'  AND jel.debit_credit = 'credit' THEN -jel.amount
      WHEN coa.normal_balance = 'credit' AND jel.debit_credit = 'credit' THEN  jel.amount
      WHEN coa.normal_balance = 'credit' AND jel.debit_credit = 'debit'  THEN -jel.amount
    END
  ) OVER (
    PARTITION BY jel.coa_id
    ORDER BY je.entry_date, jel.id
  ) AS running_balance,

  jel.customer_id,
  jel.account_id,
  jel.staff_id,

  je.status               AS entry_status,
  je.period_id,
  je.created_at

FROM journal_entry_lines jel
JOIN journal_entries     je  ON je.id  = jel.journal_entry_id
JOIN chart_of_accounts   coa ON coa.id = jel.coa_id
WHERE je.status = 'posted';


-- ============================================================
-- 8. ACCOUNT BALANCES (materialized summary per account)
-- ============================================================
-- Faster than scanning the full ledger every time.

CREATE TABLE account_balances (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  coa_id          uuid          NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  company_id      uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Period-specific balance (for period-end closing)
  period_id       uuid          REFERENCES accounting_periods(id),

  -- Balances
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  total_debits    numeric(18,2) NOT NULL DEFAULT 0,
  total_credits   numeric(18,2) NOT NULL DEFAULT 0,
  closing_balance numeric(18,2) GENERATED ALWAYS AS (
    opening_balance +
    CASE
      WHEN (SELECT normal_balance FROM chart_of_accounts WHERE id = coa_id) = 'debit'
        THEN total_debits - total_credits
      ELSE total_credits - total_debits
    END
  ) STORED,

  last_entry_date date,
  updated_at      timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (coa_id, period_id)
);

CREATE INDEX idx_balances_coa     ON account_balances(coa_id);
CREATE INDEX idx_balances_company ON account_balances(company_id);


-- ============================================================
-- 9. TRIGGER: auto-update account_balances on journal post
-- ============================================================

CREATE OR REPLACE FUNCTION update_account_balances()
RETURNS TRIGGER AS $$
DECLARE
  v_line RECORD;
BEGIN
  -- Only run when a journal entry transitions to 'posted'
  IF NEW.status = 'posted' AND OLD.status != 'posted' THEN
    FOR v_line IN
      SELECT * FROM journal_entry_lines WHERE journal_entry_id = NEW.id
    LOOP
      INSERT INTO account_balances (coa_id, company_id, period_id, opening_balance, total_debits, total_credits, last_entry_date)
      VALUES (
        v_line.coa_id,
        NEW.company_id,
        NEW.period_id,
        0,
        CASE WHEN v_line.debit_credit = 'debit'  THEN v_line.amount ELSE 0 END,
        CASE WHEN v_line.debit_credit = 'credit' THEN v_line.amount ELSE 0 END,
        NEW.entry_date
      )
      ON CONFLICT (coa_id, period_id) DO UPDATE
        SET total_debits    = account_balances.total_debits    + CASE WHEN v_line.debit_credit = 'debit'  THEN v_line.amount ELSE 0 END,
            total_credits   = account_balances.total_credits   + CASE WHEN v_line.debit_credit = 'credit' THEN v_line.amount ELSE 0 END,
            last_entry_date = GREATEST(account_balances.last_entry_date, NEW.entry_date),
            updated_at      = NOW();
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_balances
  AFTER UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION update_account_balances();


-- ============================================================
-- 10. TRIAL BALANCE VIEW
-- ============================================================

CREATE VIEW trial_balance AS
SELECT
  coa.company_id,
  coa.code                AS account_code,
  coa.name                AS account_name,
  coa.account_type,
  coa.category,
  coa.normal_balance,
  COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0) AS total_debits,
  COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0) AS total_credits,

  -- Net balance in the account's normal direction
  CASE coa.normal_balance
    WHEN 'debit'  THEN COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0)
                     - COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0)
    WHEN 'credit' THEN COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0)
                     - COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0)
  END                     AS net_balance

FROM chart_of_accounts coa
LEFT JOIN journal_entry_lines jel ON jel.coa_id = coa.id
LEFT JOIN journal_entries je      ON je.id = jel.journal_entry_id AND je.status = 'posted'
WHERE coa.is_active = true AND coa.is_deleted = false
GROUP BY coa.id, coa.company_id, coa.code, coa.name, coa.account_type, coa.category, coa.normal_balance
ORDER BY coa.code;


-- ============================================================
-- 11. PROFIT & LOSS VIEW
-- ============================================================

CREATE VIEW profit_and_loss AS
SELECT
  company_id,
  account_type,
  category,
  account_code,
  account_name,
  net_balance
FROM trial_balance
WHERE account_type IN ('income', 'expense')
ORDER BY
  CASE account_type WHEN 'income' THEN 1 ELSE 2 END,
  account_code;


-- ============================================================
-- 12. BALANCE SHEET VIEW
-- ============================================================

CREATE VIEW balance_sheet AS
SELECT
  company_id,
  account_type,
  category,
  account_code,
  account_name,
  net_balance
FROM trial_balance
WHERE account_type IN ('asset', 'liability', 'equity')
ORDER BY
  CASE account_type WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 ELSE 3 END,
  account_code;


-- ============================================================
-- 13. REFERENCE NUMBER SEQUENCE
-- ============================================================

CREATE SEQUENCE journal_entry_seq START 1;

CREATE OR REPLACE FUNCTION generate_journal_ref(p_company_id uuid)
RETURNS varchar AS $$
DECLARE
  v_year  varchar(4);
  v_seq   varchar(8);
BEGIN
  v_year := TO_CHAR(CURRENT_DATE, 'YYYY');
  v_seq  := LPAD(nextval('journal_entry_seq')::text, 6, '0');
  RETURN 'JE-' || v_year || '-' || v_seq;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 14. AUDIT LOG (optional but recommended for banking systems)
-- ============================================================

CREATE TABLE accounting_audit_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL,
  table_name    varchar(50) NOT NULL,
  record_id     uuid        NOT NULL,
  action        varchar(20) NOT NULL,  -- INSERT, UPDATE, DELETE
  old_values    jsonb,
  new_values    jsonb,
  performed_by  uuid,
  performed_at  timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_record ON accounting_audit_log(table_name, record_id);
CREATE INDEX idx_audit_company ON accounting_audit_log(company_id, performed_at DESC);