-- ============================================================
-- CASH VARIANCE SYSTEM — DATABASE MIGRATION
-- Records daily mobile banker reconciliation variances.
-- Shortage  = staff handed in LESS cash than system shows
-- Excess    = staff handed in MORE cash than system shows
-- ============================================================

-- ── 1. Add two new COA accounts ──────────────────────────────
-- These are created per-company via the seed function below.
-- Account type: asset (shortage reduces asset, excess adds)
--
--   1070   Cash Shortage / Excess (parent)
--   1070-01 Cash Shortage Expense   ← Dr when cash is short
--   1070-02 Cash Over (Excess)      ← Cr when cash is over

-- Add 1070 codes to every existing company
DO $$
DECLARE
  v_company RECORD;
  v_creator uuid;
  v_parent  uuid;
BEGIN
  FOR v_company IN SELECT id FROM companies LOOP
    -- Pick any staff member as creator
    SELECT id INTO v_creator FROM staff
    WHERE company_id = v_company.id ORDER BY created_at ASC LIMIT 1;

    CONTINUE WHEN v_creator IS NULL;

    -- Only seed if not already there
    IF EXISTS (
      SELECT 1 FROM chart_of_accounts
      WHERE company_id = v_company.id AND code = '1070'
    ) THEN CONTINUE; END IF;

    -- Parent
    INSERT INTO chart_of_accounts (
      company_id, code, name, description,
      account_type, category, normal_balance,
      is_system_account, allow_manual_entry, created_by
    ) VALUES (
      v_company.id, '1070', 'Cash Variance',
      'Net cash shortage and excess tracking for mobile bankers',
      'asset', 'cash_and_cash_equivalents', 'debit',
      true, false, v_creator
    ) RETURNING id INTO v_parent;

    -- 1070-01 Shortage (expense-like — debit to record loss)
    INSERT INTO chart_of_accounts (
      company_id, code, name, description,
      account_type, category, normal_balance,
      parent_id, is_sub_account, is_system_account, allow_manual_entry, created_by
    ) VALUES (
      v_company.id, '1070-01', 'Cash Shortage',
      'Cash collected by mobile banker is less than system transactions total',
      'expense', 'other_expense', 'debit',
      v_parent, true, true, false, v_creator
    );

    -- 1070-02 Excess (income-like — credit to record gain)
    INSERT INTO chart_of_accounts (
      company_id, code, name, description,
      account_type, category, normal_balance,
      parent_id, is_sub_account, is_system_account, allow_manual_entry, created_by
    ) VALUES (
      v_company.id, '1070-02', 'Cash Over (Excess)',
      'Cash collected by mobile banker exceeds system transactions total',
      'income', 'other_income', 'credit',
      v_parent, true, true, false, v_creator
    );

    RAISE NOTICE 'Seeded 1070 accounts for company %', v_company.id;
  END LOOP;
END $$;


-- ── 2. Cash variance records table ───────────────────────────

CREATE TYPE variance_type AS ENUM ('shortage', 'excess', 'balanced');
CREATE TYPE variance_status AS ENUM ('open', 'acknowledged', 'resolved', 'written_off');

CREATE TABLE cash_variances (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Who and when
  staff_id            uuid          NOT NULL REFERENCES staff(id),
  variance_date       date          NOT NULL,

  -- What the system says was collected
  system_total        numeric(14,2) NOT NULL,  -- sum of completed deposits for that staff that day

  -- What was physically handed in
  physical_cash       numeric(14,2) NOT NULL,

  -- Computed (system - physical)
  -- Positive = shortage (staff owe the company)
  -- Negative = excess   (company owes staff / will investigate)
  variance_amount     numeric(14,2) GENERATED ALWAYS AS (system_total - physical_cash) STORED,
  variance_type       variance_type GENERATED ALWAYS AS (
    CASE
      WHEN (system_total - physical_cash) > 0.005  THEN 'shortage'::variance_type
      WHEN (system_total - physical_cash) < -0.005 THEN 'excess'::variance_type
      ELSE 'balanced'::variance_type
    END
  ) STORED,

  -- Breakdown provided by manager (optional)
  transactions_count  int,
  notes               text,
  attachment_url      text,          -- photo of cash count sheet

  -- Status workflow
  status              variance_status NOT NULL DEFAULT 'open',

  -- Accounting
  accounting_je_id    uuid          REFERENCES journal_entries(id),
  je_posted_at        timestamp,

  -- SMS notification
  sms_sent            boolean       NOT NULL DEFAULT false,
  sms_sent_at         timestamp,

  -- Audit
  recorded_by         uuid          NOT NULL REFERENCES staff(id),
  recorded_at         timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_by         uuid          REFERENCES staff(id),
  resolved_at         timestamp,
  resolution_note     text,
  updated_at          timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One variance record per staff per date
  UNIQUE (company_id, staff_id, variance_date)
);

CREATE INDEX idx_cv_company_date  ON cash_variances(company_id, variance_date DESC);
CREATE INDEX idx_cv_staff         ON cash_variances(staff_id);
CREATE INDEX idx_cv_status        ON cash_variances(status);
CREATE INDEX idx_cv_type          ON cash_variances(variance_type);


-- ── 3. Running variance ledger per staff ─────────────────────
-- Useful for quick "how much does this staff owe / how much
-- excess has been recorded" without scanning the full table.
CREATE VIEW staff_variance_summary AS
SELECT
  staff_id,
  company_id,

  COUNT(*) AS total_records,

  COUNT(*) FILTER (
    WHERE variance_type = 'shortage'
  ) AS shortage_count,

  COUNT(*) FILTER (
    WHERE variance_type = 'excess'
  ) AS excess_count,

  COUNT(*) FILTER (
    WHERE variance_type = 'balanced'
  ) AS balanced_count,

  COALESCE(
    SUM(variance_amount) FILTER (
      WHERE variance_type = 'shortage'
    ),
    0
  ) AS total_shortage,

  COALESCE(
    ABS(
      SUM(variance_amount) FILTER (
        WHERE variance_type = 'excess'
      )
    ),
    0
  ) AS total_excess,

  -- Positive means staff owes company
  COALESCE(SUM(variance_amount), 0) AS net_variance,

  COUNT(*) FILTER (
    WHERE status = 'open'
  ) AS open_count,

  MAX(variance_date) AS last_variance_date

FROM cash_variances

GROUP BY
  staff_id,
  company_id;