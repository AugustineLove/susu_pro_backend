-- ============================================================
-- SUSU BANKING SYSTEM — ACCOUNTING BACKFILL MIGRATION
-- File 3 of 3
-- ============================================================
-- Converts ALL existing data into journal entries.
-- Run AFTER accounting_migration.sql and accounting_seed.sql.
--
-- What gets migrated:
--   A. Customer deposits & withdrawals   → transactions table
--   B. Commission deductions             → commissions table
--   C. Transfers between accounts        → transactions (transfer_in/out)
--   D. Company expenses                  → expenses table
--   E. Company revenue / payments        → revenue table
--   F. Fixed assets                      → assets table
--   G. Opening balances (customer accs)  → accounts table balances
--
-- Strategy:
--   - Each migrated record becomes ONE journal entry (posted immediately)
--   - We use entry_date = original transaction date
--   - source_table + source_id tie every JE back to the original record
--   - Run inside a single transaction so it's all-or-nothing
-- ============================================================

BEGIN;

-- ── Safety check: make sure seed ran first ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts LIMIT 1) THEN
    RAISE EXCEPTION 'Chart of accounts is empty. Run accounting_seed.sql first.';
  END IF;
END $$;


-- ============================================================
-- HELPER: get a COA account id by code for a given company
-- ============================================================

CREATE OR REPLACE FUNCTION get_coa_id(
  p_company_id uuid,
  p_code       varchar
) RETURNS uuid AS $$
  SELECT id
  FROM chart_of_accounts
  WHERE company_id = p_company_id
    AND code       = p_code
    AND is_deleted = false
  LIMIT 1;
$$ LANGUAGE sql STABLE;


-- ============================================================
-- HELPER: create a balanced journal entry and post it
-- Returns the new journal_entry id
-- ============================================================

CREATE OR REPLACE FUNCTION create_posted_je(
  p_company_id    uuid,
  p_description   text,
  p_entry_date    date,
  p_source        journal_source,
  p_source_id     uuid,
  p_source_table  varchar,
  p_created_by    uuid,
  -- debit side
  p_debit_coa     uuid,
  p_debit_amount  numeric,
  -- credit side
  p_credit_coa    uuid,
  p_credit_amount numeric,
  -- optional line-level context
  p_customer_id   uuid  DEFAULT NULL,
  p_account_id    uuid  DEFAULT NULL,
  p_staff_id      uuid  DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_je_id       uuid;
  v_ref         varchar;
BEGIN
  v_ref := generate_journal_ref(p_company_id);

  -- 1. Create the journal entry header (draft first)
  INSERT INTO journal_entries (
    company_id, reference_no, description,
    entry_date, source, source_id, source_table,
    status, created_by
  ) VALUES (
    p_company_id, v_ref, p_description,
    p_entry_date, p_source, p_source_id, p_source_table,
    'draft', p_created_by
  ) RETURNING id INTO v_je_id;

  -- 2. Insert debit line
  INSERT INTO journal_entry_lines (
    journal_entry_id, coa_id, debit_credit, amount,
    customer_id, account_id, staff_id
  ) VALUES (
    v_je_id, p_debit_coa, 'debit', p_debit_amount,
    p_customer_id, p_account_id, p_staff_id
  );

  -- 3. Insert credit line
  INSERT INTO journal_entry_lines (
    journal_entry_id, coa_id, debit_credit, amount,
    customer_id, account_id, staff_id
  ) VALUES (
    v_je_id, p_credit_coa, 'credit', p_credit_amount,
    p_customer_id, p_account_id, p_staff_id
  );

  -- 4. Post it — the balance trigger will fire and validate
  UPDATE journal_entries
  SET status    = 'posted',
      posted_by = p_created_by,
      posted_at = CURRENT_TIMESTAMP
  WHERE id = v_je_id;

  RETURN v_je_id;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- A. CUSTOMER DEPOSITS
-- ============================================================
-- Dr  Cash/Mobile Banker Float (1010-02)
-- Cr  Customer Deposits        (2010-01 daily / 2010-02 fixed)

DO $$
DECLARE
  v_rec           RECORD;
  v_cash_coa      uuid;
  v_deposit_coa   uuid;
  v_acct_type     text;
  v_skipped       int := 0;
  v_migrated      int := 0;
BEGIN
  RAISE NOTICE 'Migrating customer deposits...';

  FOR v_rec IN
    SELECT
      t.id,
      t.amount,
      t.transaction_date,
      t.created_by,
      t.account_id,
      t.company_id,
      t.description,
      t.payment_method,
      a.account_type,
      a.customer_id
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.type        = 'deposit'
      AND t.is_deleted  = false
      AND t.status     IN ('approved', 'completed')
      -- skip already migrated
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.source_table = 'transactions'
          AND je.source_id    = t.id
      )
    ORDER BY t.transaction_date ASC
  LOOP
    -- Decide which cash account to debit
    -- MoMo deposits hit MoMo float; cash hits mobile banker float
    IF v_rec.payment_method = 'momo' THEN
      v_cash_coa := get_coa_id(v_rec.company_id, '1010-03');
    ELSE
      v_cash_coa := get_coa_id(v_rec.company_id, '1010-02');
    END IF;

    -- Decide which deposit liability to credit
    v_acct_type := LOWER(v_rec.account_type);
    IF v_acct_type ILIKE '%fixed%' OR v_acct_type ILIKE '%lock%' THEN
      v_deposit_coa := get_coa_id(v_rec.company_id, '2010-02');
    ELSE
      v_deposit_coa := get_coa_id(v_rec.company_id, '2010-01');
    END IF;

    IF v_cash_coa IS NULL OR v_deposit_coa IS NULL THEN
      RAISE WARNING 'Missing COA for deposit transaction %, skipping', v_rec.id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    PERFORM create_posted_je(
      v_rec.company_id,
      COALESCE(v_rec.description, 'Customer deposit'),
      v_rec.transaction_date::date,
      'customer_deposit',
      v_rec.id,
      'transactions',
      v_rec.created_by,
      v_cash_coa,    v_rec.amount,
      v_deposit_coa, v_rec.amount,
      v_rec.customer_id,
      v_rec.account_id,
      v_rec.created_by
    );

    v_migrated := v_migrated + 1;
  END LOOP;

  RAISE NOTICE 'Deposits → migrated: %, skipped: %', v_migrated, v_skipped;
END $$;


-- ============================================================
-- B. CUSTOMER WITHDRAWALS (approved only)
-- ============================================================
-- Dr  Customer Deposits (2010-01)
-- Cr  Cash / MoMo Float (1010-02 or 1010-03)

DO $$
DECLARE
  v_rec          RECORD;
  v_cash_coa     uuid;
  v_deposit_coa  uuid;
  v_migrated     int := 0;
  v_skipped      int := 0;
BEGIN
  RAISE NOTICE 'Migrating customer withdrawals...';

  FOR v_rec IN
    SELECT
      t.id, t.amount, t.transaction_date, t.created_by,
      t.account_id, t.company_id, t.description, t.payment_method,
      a.account_type, a.customer_id
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.type       = 'withdrawal'
      AND t.status     = 'approved'
      AND t.is_deleted = false
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.source_table = 'transactions' AND je.source_id = t.id
      )
    ORDER BY t.transaction_date ASC
  LOOP
    IF v_rec.payment_method = 'momo' THEN
      v_cash_coa := get_coa_id(v_rec.company_id, '1010-03');
    ELSE
      v_cash_coa := get_coa_id(v_rec.company_id, '1010-02');
    END IF;

    v_deposit_coa := get_coa_id(v_rec.company_id, '2010-01');

    IF v_cash_coa IS NULL OR v_deposit_coa IS NULL THEN
      RAISE WARNING 'Missing COA for withdrawal %, skipping', v_rec.id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    PERFORM create_posted_je(
      v_rec.company_id,
      COALESCE(v_rec.description, 'Customer withdrawal'),
      v_rec.transaction_date::date,
      'customer_withdrawal',
      v_rec.id,
      'transactions',
      v_rec.created_by,
      v_deposit_coa, v_rec.amount,   -- Dr Customer Deposits (reduce liability)
      v_cash_coa,    v_rec.amount,   -- Cr Cash (reduce asset)
      v_rec.customer_id,
      v_rec.account_id,
      v_rec.created_by
    );

    v_migrated := v_migrated + 1;
  END LOOP;

  RAISE NOTICE 'Withdrawals → migrated: %, skipped: %', v_migrated, v_skipped;
END $$;


-- ============================================================
-- C. COMMISSIONS
-- ============================================================
-- Dr  Customer Deposits  (2010-01)   — balance reduces
-- Cr  Commission Income  (4020)      — income recognised

DO $$
DECLARE
  v_rec          RECORD;
  v_deposit_coa  uuid;
  v_income_coa   uuid;
  v_migrated     int := 0;
  v_skipped      int := 0;
BEGIN
  RAISE NOTICE 'Migrating commissions...';

  FOR v_rec IN
    SELECT
      c.id, c.amount, c.created_at, c.company_id,
      c.customer_id, c.account_id, c.transaction_id,
      COALESCE(t.created_by, c.company_id) AS created_by
    FROM commissions c
    LEFT JOIN transactions t ON t.id = c.transaction_id
    WHERE c.status != 'reversed'
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.source_table = 'commissions' AND je.source_id = c.id
      )
    ORDER BY c.created_at ASC
  LOOP
    v_deposit_coa := get_coa_id(v_rec.company_id, '2010-01');
    v_income_coa  := get_coa_id(v_rec.company_id, '4020');

    IF v_deposit_coa IS NULL OR v_income_coa IS NULL THEN
      RAISE WARNING 'Missing COA for commission %, skipping', v_rec.id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    PERFORM create_posted_je(
      v_rec.company_id,
      'Commission deduction from customer savings',
      v_rec.created_at::date,
      'commission',
      v_rec.id,
      'commissions',
      v_rec.created_by,
      v_deposit_coa, v_rec.amount,   -- Dr Customer Deposits
      v_income_coa,  v_rec.amount,   -- Cr Commission Income
      v_rec.customer_id,
      v_rec.account_id,
      NULL
    );

    v_migrated := v_migrated + 1;
  END LOOP;

  RAISE NOTICE 'Commissions → migrated: %, skipped: %', v_migrated, v_skipped;
END $$;


-- ============================================================
-- D. ACCOUNT-TO-ACCOUNT TRANSFERS
-- ============================================================
-- Each transfer_out creates ONE entry:
-- Dr  Customer Deposits (from-account customer)  — 2010-01
-- Cr  Customer Deposits (to-account customer)    — 2010-01
-- (Net effect on total deposits = zero; just moves between customers)

DO $$
DECLARE
  v_rec        RECORD;
  v_from_coa   uuid;
  v_to_coa     uuid;
  v_je_id      uuid;
  v_ref        varchar;
  v_migrated   int := 0;
  v_skipped    int := 0;
BEGIN
  RAISE NOTICE 'Migrating transfers...';

  FOR v_rec IN
    SELECT
      t_out.id            AS out_id,
      t_out.amount,
      t_out.transaction_date,
      t_out.created_by,
      t_out.company_id,
      t_out.description,
      t_out.account_id    AS from_account_id,
      t_in.account_id     AS to_account_id,
      a_out.customer_id   AS from_customer_id,
      a_in.customer_id    AS to_customer_id
    FROM transactions t_out
    JOIN transactions t_in ON
      t_in.type               = 'transfer_in'
      AND t_in.company_id     = t_out.company_id
      AND t_in.amount         = t_out.amount
      AND t_in.transaction_date = t_out.transaction_date
      AND t_in.created_by     = t_out.created_by
    JOIN accounts a_out ON a_out.id = t_out.account_id
    JOIN accounts a_in  ON a_in.id  = t_in.account_id
    WHERE t_out.type      = 'transfer_out'
      AND t_out.is_deleted = false
      AND t_out.status    IN ('approved', 'completed')
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.source_table = 'transactions' AND je.source_id = t_out.id
      )
    ORDER BY t_out.transaction_date ASC
  LOOP
    v_from_coa := get_coa_id(v_rec.company_id, '2010-01');
    v_to_coa   := get_coa_id(v_rec.company_id, '2010-01');

    IF v_from_coa IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Transfer: same COA both sides, just different customers
    v_ref := generate_journal_ref(v_rec.company_id);

    INSERT INTO journal_entries (
      company_id, reference_no, description,
      entry_date, source, source_id, source_table,
      status, created_by, posted_by, posted_at
    ) VALUES (
      v_rec.company_id, v_ref,
      COALESCE(v_rec.description, 'Transfer between customer accounts'),
      v_rec.transaction_date::date,
      'transfer', v_rec.out_id, 'transactions',
      'posted', v_rec.created_by, v_rec.created_by, CURRENT_TIMESTAMP
    ) RETURNING id INTO v_je_id;

    -- Dr: from-customer liability reduces
    INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, customer_id, account_id)
    VALUES (v_je_id, v_from_coa, 'debit', v_rec.amount, v_rec.from_customer_id, v_rec.from_account_id);

    -- Cr: to-customer liability increases
    INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, customer_id, account_id)
    VALUES (v_je_id, v_to_coa, 'credit', v_rec.amount, v_rec.to_customer_id, v_rec.to_account_id);

    v_migrated := v_migrated + 1;
  END LOOP;

  RAISE NOTICE 'Transfers → migrated: %, skipped: %', v_migrated, v_skipped;
END $$;


-- ============================================================
-- E. COMPANY EXPENSES
-- ============================================================
-- Dr  Operating Expenses (5050)
-- Cr  Cash in Vault      (1010-01)

DO $$
DECLARE
  v_rec        RECORD;
  v_exp_coa    uuid;
  v_cash_coa   uuid;
  v_migrated   int := 0;
  v_skipped    int := 0;
BEGIN
  RAISE NOTICE 'Migrating company expenses...';

  FOR v_rec IN
    SELECT
      e.id, e.amount, e.expense_date, e.company_id,
      e.description, e.category,
      COALESCE(e.recorded_by, (
        SELECT id FROM staff WHERE company_id = e.company_id LIMIT 1
      )) AS created_by
    FROM expenses e
    WHERE NOT EXISTS (
      SELECT 1 FROM journal_entries je
      WHERE je.source_table = 'expenses' AND je.source_id = e.id
    )
    ORDER BY e.expense_date ASC
  LOOP
    -- Map expense category to specific COA where possible
    v_exp_coa := CASE v_rec.category
      WHEN 'salary'      THEN get_coa_id(v_rec.company_id, '5010-01')
      WHEN 'transport'   THEN get_coa_id(v_rec.company_id, '5050-03')
      WHEN 'rent'        THEN get_coa_id(v_rec.company_id, '5050-01')
      WHEN 'utilities'   THEN get_coa_id(v_rec.company_id, '5050-01')
      WHEN 'marketing'   THEN get_coa_id(v_rec.company_id, '5050-06')
      WHEN 'stationery'  THEN get_coa_id(v_rec.company_id, '5050-02')
      WHEN 'software'    THEN get_coa_id(v_rec.company_id, '5050-05')
      WHEN 'data'        THEN get_coa_id(v_rec.company_id, '5050-04')
      WHEN 'communication' THEN get_coa_id(v_rec.company_id, '5050-04')
      ELSE                   get_coa_id(v_rec.company_id, '5050')
    END;

    v_cash_coa := get_coa_id(v_rec.company_id, '1010-01');

    IF v_exp_coa IS NULL OR v_cash_coa IS NULL THEN
      RAISE WARNING 'Missing COA for expense %, skipping', v_rec.id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    PERFORM create_posted_je(
      v_rec.company_id,
      v_rec.description,
      v_rec.expense_date::date,
      'expense',
      v_rec.id,
      'expenses',
      v_rec.created_by,
      v_exp_coa,  v_rec.amount,   -- Dr Expense account
      v_cash_coa, v_rec.amount,   -- Cr Cash
      NULL, NULL, NULL
    );

    v_migrated := v_migrated + 1;
  END LOOP;

  RAISE NOTICE 'Expenses → migrated: %, skipped: %', v_migrated, v_skipped;
END $$;


-- ============================================================
-- F. COMPANY REVENUE / PAYMENTS
-- ============================================================
-- Dr  Cash in Vault  (1010-01)
-- Cr  Other Income   (4040) — or specific sub-account by category

DO $$
DECLARE
  v_rec        RECORD;
  v_cash_coa   uuid;
  v_inc_coa    uuid;
  v_migrated   int := 0;
  v_skipped    int := 0;
BEGIN
  RAISE NOTICE 'Migrating company revenue entries...';

  FOR v_rec IN
    SELECT
      r.id, r.amount, r.payment_date, r.company_id,
      r.description, r.category, r.source,
      COALESCE(r.recorded_by, (
        SELECT id FROM staff WHERE company_id = r.company_id LIMIT 1
      )) AS created_by
    FROM revenue r
    WHERE r.status != 'cancelled'
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.source_table = 'revenue' AND je.source_id = r.id
      )
    ORDER BY r.payment_date ASC
  LOOP
    v_inc_coa := CASE v_rec.category
  WHEN 'interest'    THEN get_coa_id(v_rec.company_id, '4010')
  WHEN 'commission'  THEN get_coa_id(v_rec.company_id, '4020')
  WHEN 'fee'         THEN get_coa_id(v_rec.company_id, '4030')
  WHEN 'rental'      THEN get_coa_id(v_rec.company_id, '4040-01')
  WHEN 'recovery'    THEN get_coa_id(v_rec.company_id, '4040-02')
  ELSE                    get_coa_id(v_rec.company_id, '4040')
END;

    v_cash_coa := get_coa_id(v_rec.company_id, '1010-01');

    IF v_inc_coa IS NULL OR v_cash_coa IS NULL THEN
      RAISE WARNING 'Missing COA for revenue %, skipping', v_rec.id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    PERFORM create_posted_je(
      v_rec.company_id,
      v_rec.description,
      v_rec.payment_date::date,
      'revenue',
      v_rec.id,
      'revenue',
      v_rec.created_by,
      v_cash_coa, v_rec.amount,   -- Dr Cash
      v_inc_coa,  v_rec.amount,   -- Cr Income
      NULL, NULL, NULL
    );

    v_migrated := v_migrated + 1;
  END LOOP;

  RAISE NOTICE 'Revenue → migrated: %, skipped: %', v_migrated, v_skipped;
END $$;


-- ============================================================
-- G. FIXED ASSETS
-- ============================================================
-- Dr  Fixed Assets / sub-account  (1050-01 or 1050-02)
-- Cr  Cash in Vault               (1010-01)
-- And record accumulated depreciation if depreciation_rate is set

DO $$
DECLARE
  v_rec         RECORD;
  v_asset_coa   uuid;
  v_cash_coa    uuid;
  v_dep_exp_coa uuid;
  v_dep_acc_coa uuid;
  v_months_held int;
  v_monthly_dep numeric(18,2);
  v_total_dep   numeric(18,2);
  v_migrated    int := 0;
BEGIN
  RAISE NOTICE 'Migrating fixed assets...';

  FOR v_rec IN
    SELECT
      a.id, a.value, a.purchase_date, a.company_id,
      a.name, a.category, a.depreciation_rate, a.useful_life,
      (SELECT id FROM staff WHERE company_id = a.company_id LIMIT 1) AS created_by
    FROM assets a
    WHERE a.status != 'disposed'
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.source_table = 'assets' AND je.source_id = a.id
      )
    ORDER BY a.purchase_date ASC
  LOOP
    -- Map category to COA
    v_asset_coa := CASE LOWER(v_rec.category)
      WHEN 'vehicle'    THEN get_coa_id(v_rec.company_id, '1050-02')
      WHEN 'furniture'  THEN get_coa_id(v_rec.company_id, '1050-01')
      WHEN 'equipment'  THEN get_coa_id(v_rec.company_id, '1050-01')
      ELSE                   get_coa_id(v_rec.company_id, '1050')
    END;

    v_cash_coa    := get_coa_id(v_rec.company_id, '1010-01');
    v_dep_exp_coa := get_coa_id(v_rec.company_id, '5020');
    v_dep_acc_coa := get_coa_id(v_rec.company_id, '1060');

    -- 1. Asset purchase entry
    PERFORM create_posted_je(
      v_rec.company_id,
      'Asset purchase: ' || v_rec.name,
      v_rec.purchase_date::date,
      'manual',
      v_rec.id,
      'assets',
      v_rec.created_by,
      v_asset_coa, v_rec.value,   -- Dr Fixed Asset
      v_cash_coa,  v_rec.value,   -- Cr Cash
      NULL, NULL, NULL
    );

    -- 2. Accumulated depreciation entry (if applicable)
    IF v_rec.depreciation_rate IS NOT NULL AND v_rec.depreciation_rate > 0 THEN
      v_months_held  := GREATEST(1,
        EXTRACT(YEAR FROM AGE(CURRENT_DATE, v_rec.purchase_date))::int * 12 +
        EXTRACT(MONTH FROM AGE(CURRENT_DATE, v_rec.purchase_date))::int
      );
      v_monthly_dep  := ROUND((v_rec.value * (v_rec.depreciation_rate / 100)) / 12, 2);
      v_total_dep    := LEAST(v_monthly_dep * v_months_held, v_rec.value);

      IF v_total_dep > 0 THEN
        PERFORM create_posted_je(
          v_rec.company_id,
          'Accumulated depreciation: ' || v_rec.name,
          CURRENT_DATE,
          'depreciation',
          v_rec.id,
          'assets',
          v_rec.created_by,
          v_dep_exp_coa, v_total_dep,  -- Dr Depreciation Expense
          v_dep_acc_coa, v_total_dep,  -- Cr Accumulated Depreciation
          NULL, NULL, NULL
        );
      END IF;
    END IF;

    v_migrated := v_migrated + 1;
  END LOOP;

  RAISE NOTICE 'Assets → migrated: %', v_migrated;
END $$;


-- ============================================================
-- H. OPENING BALANCES (existing account balances not yet in JEs)
-- ============================================================
-- For every customer account that has a balance but whose
-- transactions don't fully explain that balance (e.g. pre-system data),
-- post a single opening balance entry.
--
-- Dr  Mobile Banker Float  (1010-02)
-- Cr  Customer Deposits    (2010-01)

DO $$
DECLARE
  v_rec         RECORD;
  v_cash_coa    uuid;
  v_deposit_coa uuid;
  v_je_id       uuid;
  v_ref         varchar;
  v_migrated    int := 0;
BEGIN
  RAISE NOTICE 'Migrating opening balances...';

  FOR v_rec IN
    SELECT
      a.id            AS account_id,
      a.company_id,
      a.customer_id,
      a.balance,
      a.opened_at,
      a.account_type,
      -- Net already-migrated activity for this account
      COALESCE((
        SELECT
          SUM(CASE WHEN jel.debit_credit = 'credit' THEN jel.amount ELSE -jel.amount END)
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jel.coa_id
        WHERE jel.account_id    = a.id
          AND coa.account_type  = 'liability'   -- deposit-side lines only
          AND je.status         = 'posted'
      ), 0) AS migrated_balance
    FROM accounts a
    WHERE a.is_deleted = false
      AND a.account_type NOT ILIKE '%loan%'
      AND a.balance > 0
  LOOP
    -- Only post an opening entry for the unexplained difference
    DECLARE
      v_gap numeric(18,2) := v_rec.balance - v_rec.migrated_balance;
    BEGIN
      CONTINUE WHEN v_gap <= 0.01;  -- within rounding tolerance

      v_cash_coa    := get_coa_id(v_rec.company_id, '1010-02');
      v_deposit_coa := get_coa_id(v_rec.company_id, '2010-01');

      CONTINUE WHEN v_cash_coa IS NULL OR v_deposit_coa IS NULL;

      v_ref := generate_journal_ref(v_rec.company_id);

      INSERT INTO journal_entries (
        company_id, reference_no, description,
        entry_date, source, source_id, source_table,
        status, created_by, posted_by, posted_at
      ) VALUES (
        v_rec.company_id, v_ref,
        'Opening balance migration — account ' || v_rec.account_id,
        COALESCE(v_rec.opened_at::date, '2020-01-01'),
        'opening_balance', v_rec.account_id, 'accounts',
        'posted',
        (SELECT id FROM staff WHERE company_id = v_rec.company_id LIMIT 1),
        (SELECT id FROM staff WHERE company_id = v_rec.company_id LIMIT 1),
        CURRENT_TIMESTAMP
      ) RETURNING id INTO v_je_id;

      INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, account_id, customer_id)
      VALUES (v_je_id, v_cash_coa,    'debit',  v_gap, v_rec.account_id, v_rec.customer_id);

      INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, account_id, customer_id)
      VALUES (v_je_id, v_deposit_coa, 'credit', v_gap, v_rec.account_id, v_rec.customer_id);

      v_migrated := v_migrated + 1;
    END;
  END LOOP;

  RAISE NOTICE 'Opening balances → migrated: %', v_migrated;
END $$;


-- ============================================================
-- I. VERIFICATION — TRIAL BALANCE SANITY CHECK
-- ============================================================

DO $$
DECLARE
  v_total_debits  numeric(18,2);
  v_total_credits numeric(18,2);
  v_je_count      int;
  v_line_count    int;
BEGIN
  SELECT
    COUNT(DISTINCT je.id),
    COUNT(jel.id),
    COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0),
    COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0)
  INTO v_je_count, v_line_count, v_total_debits, v_total_credits
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  WHERE je.status = 'posted';

  RAISE NOTICE '══════════════════════════════════════════';
  RAISE NOTICE 'BACKFILL COMPLETE — VERIFICATION SUMMARY';
  RAISE NOTICE '══════════════════════════════════════════';
  RAISE NOTICE 'Journal entries posted : %', v_je_count;
  RAISE NOTICE 'Journal lines created  : %', v_line_count;
  RAISE NOTICE 'Total debits           : %', v_total_debits;
  RAISE NOTICE 'Total credits          : %', v_total_credits;
  RAISE NOTICE 'Difference (must = 0)  : %', v_total_debits - v_total_credits;

  IF ABS(v_total_debits - v_total_credits) > 0.01 THEN
    RAISE WARNING 'TRIAL BALANCE IS OUT OF BALANCE BY %! Review manually.', v_total_debits - v_total_credits;
  ELSE
    RAISE NOTICE 'Trial balance: BALANCED ✓';
  END IF;

  RAISE NOTICE '══════════════════════════════════════════';
END $$;


COMMIT;


-- ============================================================
-- USEFUL QUERIES AFTER MIGRATION
-- ============================================================

-- Full trial balance for a company:
-- SELECT * FROM trial_balance WHERE company_id = '<your-company-id>' ORDER BY account_code;

-- Balance sheet:
-- SELECT * FROM balance_sheet WHERE company_id = '<your-company-id>';

-- P&L:
-- SELECT * FROM profit_and_loss WHERE company_id = '<your-company-id>';

-- General ledger for a specific account:
-- SELECT * FROM general_ledger WHERE company_id = '<your-company-id>' AND account_code = '2010-01' ORDER BY entry_date;

-- All journal entries for a specific transaction:
-- SELECT je.*, jel.* FROM journal_entries je
-- JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
-- WHERE je.source_table = 'transactions' AND je.source_id = '<transaction-id>';
