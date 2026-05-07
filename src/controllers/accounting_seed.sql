-- ============================================================
-- SUSU BANKING SYSTEM — CHART OF ACCOUNTS SEED
-- File 2 of 3
-- ============================================================
-- This inserts the default chart of accounts for every company.
-- Run once per company, or use the function at the bottom to
-- seed all existing companies in one shot.
--
-- Account code convention:
--   1xxx = Assets
--   2xxx = Liabilities
--   3xxx = Equity
--   4xxx = Income
--   5xxx = Expenses
--
-- Sub-account convention:
--   1010      = parent
--   1010-01   = sub-account of 1010
-- ============================================================


-- ============================================================
-- HELPER FUNCTION: seed one company
-- ============================================================

CREATE OR REPLACE FUNCTION seed_chart_of_accounts(
  p_company_id uuid,
  p_created_by uuid   -- staff/admin id doing the seeding
)
RETURNS void AS $$
DECLARE
  -- parent IDs (resolved after insert so sub-accounts can ref them)
  v_cash_vault          uuid;
  v_bank_accounts       uuid;
  v_receivables         uuid;
  v_fixed_assets        uuid;
  v_accum_depreciation  uuid;
  v_customer_deposits   uuid;
  v_loans_payable       uuid;
  v_payables            uuid;
  v_share_capital       uuid;
  v_retained_earnings   uuid;
  v_interest_income     uuid;
  v_fee_income          uuid;
  v_commission_income   uuid;
  v_other_income        uuid;
  v_staff_costs         uuid;
  v_depreciation_exp    uuid;
  v_operating_exp       uuid;
  v_commission_exp      uuid;
  v_interest_exp        uuid;
BEGIN

  -- ══════════════════════════════════════════════════════════
  -- ASSETS  (1xxx)
  -- ══════════════════════════════════════════════════════════

  -- 1010 Cash & Cash Equivalents
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '1010', 'Cash & Cash Equivalents',
    'Physical cash held in vaults and tills by mobile bankers',
    'asset', 'cash_and_cash_equivalents', 'debit',
    true, true, p_created_by
  ) RETURNING id INTO v_cash_vault;

  -- 1010-01 Cash in Vault
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, is_system_account, created_by
  ) VALUES (
    p_company_id, '1010-01', 'Cash in Vault',
    'Main office vault cash',
    'asset', 'cash_and_cash_equivalents', 'debit',
    v_cash_vault, true, true, p_created_by
  );

  -- 1010-02 Mobile Banker Float
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '1010-02', 'Mobile Banker Float',
    'Cash allocated to mobile bankers for daily collections (maps to budgets table)',
    'asset', 'cash_and_cash_equivalents', 'debit',
    v_cash_vault, true, true, false, p_created_by
  );

  -- 1010-03 Mobile Money Float (MoMo)
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, is_system_account, created_by
  ) VALUES (
    p_company_id, '1010-03', 'Mobile Money Float',
    'MTN / Telecel / AirtelTigo MoMo wallet balances',
    'asset', 'cash_and_cash_equivalents', 'debit',
    v_cash_vault, true, true, p_created_by
  );

  -- 1020 Bank Accounts
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, created_by
  ) VALUES (
    p_company_id, '1020', 'Bank Accounts',
    'Company accounts held at commercial banks',
    'asset', 'bank_accounts', 'debit',
    true, p_created_by
  ) RETURNING id INTO v_bank_accounts;

  -- 1020-01 Primary Bank Account
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '1020-01', 'Primary Bank Account',
    'Main operating bank account',
    'asset', 'bank_accounts', 'debit',
    v_bank_accounts, true, p_created_by
  );

  -- 1030 Accounts Receivable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '1030', 'Accounts Receivable',
    'Amounts owed to the company',
    'asset', 'accounts_receivable', 'debit',
    true, false, p_created_by
  ) RETURNING id INTO v_receivables;

  -- 1030-01 Loan Principal Receivable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '1030-01', 'Loan Principal Receivable',
    'Outstanding loan principal owed by borrowers',
    'asset', 'accounts_receivable', 'debit',
    v_receivables, true, true, false, p_created_by
  );

  -- 1030-02 Interest Receivable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '1030-02', 'Interest Receivable',
    'Accrued interest not yet collected',
    'asset', 'other_receivables', 'debit',
    v_receivables, true, true, false, p_created_by
  );

  -- 1040 Prepaid Expenses
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '1040', 'Prepaid Expenses',
    'Expenses paid in advance (rent, insurance)',
    'asset', 'other_assets', 'debit', p_created_by
  );

  -- 1050 Fixed Assets
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '1050', 'Fixed Assets (Gross)',
    'Company-owned physical assets at cost (maps to assets table)',
    'asset', 'fixed_assets', 'debit',
    true, false, p_created_by
  ) RETURNING id INTO v_fixed_assets;

  -- 1050-01 Furniture & Equipment
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '1050-01', 'Furniture & Equipment',
    'Office furniture, computers, phones',
    'asset', 'fixed_assets', 'debit',
    v_fixed_assets, true, p_created_by
  );

  -- 1050-02 Vehicles
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '1050-02', 'Vehicles',
    'Motorcycles and vehicles used for collections',
    'asset', 'fixed_assets', 'debit',
    v_fixed_assets, true, p_created_by
  );

  -- 1060 Accumulated Depreciation (contra-asset — credit normal balance)
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '1060', 'Accumulated Depreciation',
    'Contra-asset — total depreciation charged against fixed assets',
    'asset', 'accumulated_depreciation', 'credit',
    true, false, p_created_by
  ) RETURNING id INTO v_accum_depreciation;


  -- ══════════════════════════════════════════════════════════
  -- LIABILITIES  (2xxx)
  -- ══════════════════════════════════════════════════════════

  -- 2010 Customer Deposits (Susu Savings)
  -- CRITICAL: Every susu savings balance = liability to the company
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '2010', 'Customer Deposits (Susu)',
    'Total susu savings balances owed back to customers — this is a liability',
    'liability', 'customer_deposits', 'credit',
    true, false, p_created_by
  ) RETURNING id INTO v_customer_deposits;

  -- 2010-01 Daily Susu Deposits
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '2010-01', 'Daily Susu Deposits',
    'Daily contribution savings accounts',
    'liability', 'customer_deposits', 'credit',
    v_customer_deposits, true, true, false, p_created_by
  );

  -- 2010-02 Fixed Deposit Balances
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '2010-02', 'Fixed Deposit Balances',
    'Fixed / locked savings account balances',
    'liability', 'customer_deposits', 'credit',
    v_customer_deposits, true, true, false, p_created_by
  );

  -- 2020 Loans Payable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '2020', 'Loans Payable',
    'Funds borrowed by the company from external sources',
    'liability', 'loans_payable', 'credit', p_created_by
  ) RETURNING id INTO v_loans_payable;

  -- 2030 Accounts Payable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '2030', 'Accounts Payable',
    'Unpaid vendor bills and supplier invoices',
    'liability', 'accounts_payable', 'credit', p_created_by
  ) RETURNING id INTO v_payables;

  -- 2040 Salaries Payable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '2040', 'Salaries Payable',
    'Earned but unpaid staff salaries',
    'liability', 'accrued_liabilities', 'credit',
    v_payables, true, p_created_by
  );

  -- 2050 Tax Payable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '2050', 'Tax Payable',
    'VAT, income tax and withholding tax owed to GRA',
    'liability', 'accrued_liabilities', 'credit', p_created_by
  );

  -- 2060 Commissions Payable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '2060', 'Commissions Payable',
    'Agent commissions earned but not yet paid out',
    'liability', 'accrued_liabilities', 'credit',
    true, false, p_created_by
  );

  -- 2070 Interest Payable
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '2070', 'Interest Payable',
    'Interest accrued on customer deposits not yet paid',
    'liability', 'accrued_liabilities', 'credit', p_created_by
  );


  -- ══════════════════════════════════════════════════════════
  -- EQUITY  (3xxx)
  -- ══════════════════════════════════════════════════════════

  -- 3010 Share Capital
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '3010', 'Share Capital',
    'Capital contributed by owners / shareholders',
    'equity', 'share_capital', 'credit', p_created_by
  ) RETURNING id INTO v_share_capital;

  -- 3020 Retained Earnings
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '3020', 'Retained Earnings',
    'Accumulated profits from prior periods',
    'equity', 'retained_earnings', 'credit',
    true, false, p_created_by
  ) RETURNING id INTO v_retained_earnings;

  -- 3030 Current Year Profit / Loss
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '3030', 'Current Year Profit / Loss',
    'Net income for the current fiscal year (auto-calculated)',
    'equity', 'current_year_profit', 'credit',
    true, false, p_created_by
  );


  -- ══════════════════════════════════════════════════════════
  -- INCOME  (4xxx)
  -- ══════════════════════════════════════════════════════════

  -- 4010 Interest Income
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '4010', 'Interest Income',
    'Interest earned on loans disbursed to customers',
    'income', 'interest_income', 'credit',
    true, false, p_created_by
  ) RETURNING id INTO v_interest_income;

  -- 4010-01 Loan Interest Income
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '4010-01', 'Loan Interest Income',
    'Interest charged on customer loans',
    'income', 'interest_income', 'credit',
    v_interest_income, true, true, false, p_created_by
  );

  -- 4010-02 Late Payment Interest
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '4010-02', 'Late Payment Interest',
    'Penalty interest on overdue loan repayments',
    'income', 'interest_income', 'credit',
    v_interest_income, true, p_created_by
  );

  -- 4020 Commission Income
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '4020', 'Commission Income',
    'Commissions deducted from customer savings (maps to commissions table)',
    'income', 'commission_income', 'credit',
    true, false, p_created_by
  ) RETURNING id INTO v_commission_income;

  -- 4030 Service / Processing Fees
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, created_by
  ) VALUES (
    p_company_id, '4030', 'Service & Processing Fees',
    'Account opening fees, withdrawal fees, card fees',
    'income', 'fee_income', 'credit',
    true, p_created_by
  ) RETURNING id INTO v_fee_income;

  -- 4030-01 Account Opening Fees
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '4030-01', 'Account Opening Fees',
    'One-time fee charged when a new account is opened',
    'income', 'fee_income', 'credit',
    v_fee_income, true, p_created_by
  );

  -- 4030-02 Withdrawal / Transaction Fees
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '4030-02', 'Withdrawal & Transaction Fees',
    'Per-transaction fees on withdrawals',
    'income', 'fee_income', 'credit',
    v_fee_income, true, p_created_by
  );

  -- 4040 Other Income
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '4040', 'Other Income',
    'Miscellaneous income not classified above (maps to revenue table)',
    'income', 'other_income', 'credit', p_created_by
  ) RETURNING id INTO v_other_income;

  -- 4040-01 Rental Income
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '4040-01', 'Rental Income',
    'Income from renting out company property',
    'income', 'other_income', 'credit',
    v_other_income, true, p_created_by
  );

  -- 4040-02 Recovery Income
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '4040-02', 'Recovery Income',
    'Bad debt recoveries and written-off loan collections',
    'income', 'other_income', 'credit',
    v_other_income, true, p_created_by
  );


  -- ══════════════════════════════════════════════════════════
  -- EXPENSES  (5xxx)
  -- ══════════════════════════════════════════════════════════

  -- 5010 Staff Costs
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '5010', 'Staff Costs',
    'All staff-related expenditure',
    'expense', 'staff_costs', 'debit', p_created_by
  ) RETURNING id INTO v_staff_costs;

  -- 5010-01 Salaries & Wages
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '5010-01', 'Salaries & Wages',
    'Monthly gross pay for all employees',
    'expense', 'staff_costs', 'debit',
    v_staff_costs, true, p_created_by
  );

  -- 5010-02 Staff Allowances & Bonuses
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '5010-02', 'Staff Allowances & Bonuses',
    'Transport, housing allowances, performance bonuses',
    'expense', 'staff_costs', 'debit',
    v_staff_costs, true, p_created_by
  );

  -- 5020 Depreciation Expense
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '5020', 'Depreciation Expense',
    'Periodic depreciation on fixed assets (maps to assets table)',
    'expense', 'depreciation_expense', 'debit',
    true, false, p_created_by
  ) RETURNING id INTO v_depreciation_exp;

  -- 5030 Commission Expense
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '5030', 'Commission Expense',
    'Commissions paid to mobile bankers / agents',
    'expense', 'commission_expense', 'debit',
    true, false, p_created_by
  ) RETURNING id INTO v_commission_exp;

  -- 5040 Interest Expense
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '5040', 'Interest Expense',
    'Interest paid on borrowed funds or customer deposit interest',
    'expense', 'interest_expense', 'debit', p_created_by
  ) RETURNING id INTO v_interest_exp;

  -- 5050 Operating Expenses
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    is_system_account, allow_manual_entry, created_by
  ) VALUES (
    p_company_id, '5050', 'Operating Expenses',
    'Day-to-day running costs (maps to expenses table)',
    'expense', 'operating_expense', 'debit',
    true, false, p_created_by
  ) RETURNING id INTO v_operating_exp;

  -- 5050-01 Rent & Utilities
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '5050-01', 'Rent & Utilities',
    'Office rent, electricity, water',
    'expense', 'operating_expense', 'debit',
    v_operating_exp, true, p_created_by
  );

  -- 5050-02 Office Supplies & Stationery
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '5050-02', 'Office Supplies & Stationery',
    'Printing, passbooks, receipt books',
    'expense', 'operating_expense', 'debit',
    v_operating_exp, true, p_created_by
  );

  -- 5050-03 Transport & Fuel
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '5050-03', 'Transport & Fuel',
    'Fuel and transport for mobile bankers',
    'expense', 'operating_expense', 'debit',
    v_operating_exp, true, p_created_by
  );

  -- 5050-04 Communication & Data
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '5050-04', 'Communication & Data',
    'Phone airtime, SMS costs, internet data bundles',
    'expense', 'operating_expense', 'debit',
    v_operating_exp, true, p_created_by
  );

  -- 5050-05 Software & Subscriptions
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '5050-05', 'Software & Subscriptions',
    'System subscriptions, app fees, cloud services',
    'expense', 'operating_expense', 'debit',
    v_operating_exp, true, p_created_by
  );

  -- 5050-06 Marketing & Advertising
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance,
    parent_id, is_sub_account, created_by
  ) VALUES (
    p_company_id, '5050-06', 'Marketing & Advertising',
    'Flyers, promotions, social media ads',
    'expense', 'operating_expense', 'debit',
    v_operating_exp, true, p_created_by
  );

  -- 5060 Bad Debt Expense
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '5060', 'Bad Debt Expense',
    'Loans written off as uncollectable',
    'expense', 'other_expense', 'debit', p_created_by
  );

  -- 5070 Miscellaneous Expenses
  INSERT INTO chart_of_accounts (
    company_id, code, name, description,
    account_type, category, normal_balance, created_by
  ) VALUES (
    p_company_id, '5070', 'Miscellaneous Expenses',
    'Any expense that does not fit a specific category above',
    'expense', 'other_expense', 'debit', p_created_by
  );

  RAISE NOTICE 'Chart of accounts seeded for company %', p_company_id;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- SEED ALL EXISTING COMPANIES
-- ============================================================
-- Finds a super-admin or the first staff member per company
-- to use as created_by, then seeds the chart of accounts.
-- Safe to run multiple times — skips companies already seeded.

DO $$
DECLARE
  v_company   RECORD;
  v_creator   uuid;
BEGIN
  FOR v_company IN
    SELECT c.id AS company_id
    FROM companies c
    WHERE NOT EXISTS (
      SELECT 1 FROM chart_of_accounts coa WHERE coa.company_id = c.id
    )
  LOOP
    -- Pick any staff member from this company as the creator
    SELECT id INTO v_creator
    FROM staff
    WHERE company_id = v_company.company_id
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_creator IS NULL THEN
      RAISE WARNING 'No staff found for company %, skipping', v_company.company_id;
      CONTINUE;
    END IF;

    PERFORM seed_chart_of_accounts(v_company.company_id, v_creator);
  END LOOP;
END;
$$;
