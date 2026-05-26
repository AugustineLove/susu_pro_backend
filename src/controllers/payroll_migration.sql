-- ============================================================
-- PAYROLL SYSTEM — COMPLETE DATABASE MIGRATION
-- Ghana-compliant: PAYE, SSNIT Tier 1/2/3, Allowances,
-- Deductions, Payslips, Payroll runs, Accounting integration
-- ============================================================
-- Run AFTER the main accounting migration.
-- ============================================================


-- ============================================================
-- 1. EXTEND STAFF TABLE
-- Add payroll-specific columns without breaking existing data
-- ============================================================

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS date_of_birth      date,
  ADD COLUMN IF NOT EXISTS gender             varchar(10),
  ADD COLUMN IF NOT EXISTS national_id        varchar(50),       -- Ghana Card / Passport
  ADD COLUMN IF NOT EXISTS tin_number         varchar(30),       -- Tax Identification Number
  ADD COLUMN IF NOT EXISTS ssnit_number       varchar(30),       -- SSNIT contributor number
  ADD COLUMN IF NOT EXISTS bank_name          varchar(100),
  ADD COLUMN IF NOT EXISTS bank_branch        varchar(100),
  ADD COLUMN IF NOT EXISTS bank_account_name  varchar(150),
  ADD COLUMN IF NOT EXISTS bank_account_number varchar(30),
  ADD COLUMN IF NOT EXISTS department         varchar(100),
  ADD COLUMN IF NOT EXISTS job_title          varchar(100),
  ADD COLUMN IF NOT EXISTS employment_type    varchar(30)  DEFAULT 'full_time',  -- full_time | part_time | contract
  ADD COLUMN IF NOT EXISTS hire_date          date,
  ADD COLUMN IF NOT EXISTS termination_date   date,
  ADD COLUMN IF NOT EXISTS is_payroll_active  boolean      DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at         timestamp    DEFAULT CURRENT_TIMESTAMP;

-- employment_type constraint
ALTER TABLE staff
  ADD CONSTRAINT staff_employment_type_check
  CHECK (employment_type IN ('full_time','part_time','contract','casual'));


-- ============================================================
-- 2. SALARY GRADES
-- Defines pay bands — staff are assigned to a grade.
-- HR sets grades; payroll inherits from grade unless overridden.
-- ============================================================

CREATE TABLE salary_grades (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          varchar(50)  NOT NULL,        -- e.g. "Grade A", "Senior Officer"
  description   text,
  basic_salary  numeric(14,2) NOT NULL,
  is_active     boolean      NOT NULL DEFAULT true,
  created_by    uuid         NOT NULL REFERENCES staff(id),
  created_at    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, name)
);


-- ============================================================
-- 3. STAFF SALARY PROFILES
-- One profile per staff member. Holds their compensation
-- structure: basic + grade + individual overrides.
-- ============================================================

CREATE TABLE staff_salary_profiles (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id            uuid          NOT NULL UNIQUE REFERENCES staff(id) ON DELETE CASCADE,
  company_id          uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  grade_id            uuid          REFERENCES salary_grades(id),

  -- Basic salary — either from grade or explicitly set here
  basic_salary        numeric(14,2) NOT NULL DEFAULT 0,
  use_grade_salary    boolean       NOT NULL DEFAULT false,  -- if true, pull from grade

  -- Payment method
  payment_method      varchar(20)   NOT NULL DEFAULT 'bank',  -- bank | cash | momo
  currency            varchar(10)   NOT NULL DEFAULT 'GHS',

  -- Tax settings
  is_tax_exempt       boolean       NOT NULL DEFAULT false,
  tax_relief          numeric(14,2) NOT NULL DEFAULT 0,       -- personal relief etc.

  -- SSNIT
  ssnit_exempt        boolean       NOT NULL DEFAULT false,

  -- Effective dates
  effective_from      date          NOT NULL DEFAULT CURRENT_DATE,
  effective_to        date,

  -- Audit
  created_by          uuid          NOT NULL REFERENCES staff(id),
  created_at          timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 4. ALLOWANCE TYPES
-- Company-defined allowance definitions (transport, housing…)
-- ============================================================

CREATE TYPE allowance_taxability AS ENUM ('taxable', 'non_taxable', 'partially_taxable');

CREATE TABLE allowance_types (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         varchar(100) NOT NULL,           -- "Housing Allowance", "Transport"
  description  text,
  is_recurring boolean      NOT NULL DEFAULT true,   -- every month vs one-off
  taxability   allowance_taxability NOT NULL DEFAULT 'taxable',
  is_active    boolean      NOT NULL DEFAULT true,
  created_by   uuid         NOT NULL REFERENCES staff(id),
  created_at   timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, name)
);


-- ============================================================
-- 5. STAFF ALLOWANCES
-- Which allowances each staff member receives, and how much.
-- ============================================================

CREATE TYPE allowance_calc AS ENUM ('fixed', 'percentage_of_basic');

CREATE TABLE staff_allowances (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id         uuid          NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  company_id       uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  allowance_type_id uuid         NOT NULL REFERENCES allowance_types(id),
  calculation_type allowance_calc NOT NULL DEFAULT 'fixed',
  amount           numeric(14,2) NOT NULL DEFAULT 0,    -- fixed GHS or % value
  effective_from   date          NOT NULL DEFAULT CURRENT_DATE,
  effective_to     date,
  is_active        boolean       NOT NULL DEFAULT true,
  created_by       uuid          NOT NULL REFERENCES staff(id),
  created_at       timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 6. DEDUCTION TYPES
-- Loan repayments, advances, cooperative, welfare fund, etc.
-- ============================================================

CREATE TYPE deduction_taxability AS ENUM ('pre_tax', 'post_tax');

CREATE TABLE deduction_types (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         varchar(100) NOT NULL,
  description  text,
  is_recurring boolean      NOT NULL DEFAULT false,
  tax_treatment deduction_taxability NOT NULL DEFAULT 'post_tax',
  is_active    boolean      NOT NULL DEFAULT true,
  created_by   uuid         NOT NULL REFERENCES staff(id),
  created_at   timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, name)
);


-- ============================================================
-- 7. STAFF DEDUCTIONS
-- What is deducted from each staff member per pay period.
-- ============================================================

CREATE type deduction_calc AS ENUM ('fixed', 'percentage_of_basic', 'percentage_of_gross');

CREATE TABLE staff_deductions (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id          uuid          NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  company_id        uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deduction_type_id uuid          NOT NULL REFERENCES deduction_types(id),
  calculation_type  deduction_calc NOT NULL DEFAULT 'fixed',
  amount            numeric(14,2) NOT NULL DEFAULT 0,
  -- If this deduction has a total limit (e.g. loan amount):
  total_limit       numeric(14,2),
  amount_paid       numeric(14,2) NOT NULL DEFAULT 0,
  effective_from    date          NOT NULL DEFAULT CURRENT_DATE,
  effective_to      date,
  is_active         boolean       NOT NULL DEFAULT true,
  created_by        uuid          NOT NULL REFERENCES staff(id),
  created_at        timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 8. PAYROLL PERIODS
-- A payroll run covers one pay period (usually one month).
-- ============================================================

CREATE TYPE payroll_period_status AS ENUM (
  'draft',       -- being configured
  'processing',  -- calculations running
  'reviewed',    -- HR has reviewed, awaiting approval
  'approved',    -- approved, ready to pay
  'paid',        -- disbursed / payment processed
  'cancelled'
);

CREATE TABLE payroll_periods (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            varchar(100)  NOT NULL,   -- "April 2025 Payroll"
  period_start    date          NOT NULL,
  period_end      date          NOT NULL,
  payment_date    date,                     -- when salaries are actually paid
  status          payroll_period_status NOT NULL DEFAULT 'draft',
  total_gross     numeric(14,2) NOT NULL DEFAULT 0,
  total_net       numeric(14,2) NOT NULL DEFAULT 0,
  total_tax       numeric(14,2) NOT NULL DEFAULT 0,
  total_ssnit_employee  numeric(14,2) NOT NULL DEFAULT 0,
  total_ssnit_employer  numeric(14,2) NOT NULL DEFAULT 0,
  total_tier2     numeric(14,2) NOT NULL DEFAULT 0,
  total_deductions numeric(14,2) NOT NULL DEFAULT 0,
  employee_count  int           NOT NULL DEFAULT 0,
  notes           text,
  -- Journal entry posted on approval
  accounting_je_id uuid         REFERENCES journal_entries(id),
  -- Workflow
  created_by      uuid          NOT NULL REFERENCES staff(id),
  reviewed_by     uuid          REFERENCES staff(id),
  reviewed_at     timestamp,
  approved_by     uuid          REFERENCES staff(id),
  approved_at     timestamp,
  paid_by         uuid          REFERENCES staff(id),
  paid_at         timestamp,
  created_at      timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, period_start, period_end),
  CHECK (period_end > period_start)
);


-- ============================================================
-- 9. PAYROLL ENTRIES (one row per staff per payroll period)
-- This is the computed payslip data before it's locked.
-- ============================================================

CREATE TYPE payroll_entry_status AS ENUM (
  'computed',   -- auto-calculated
  'adjusted',   -- manually changed
  'approved',   -- locked
  'paid',
  'excluded'    -- staff excluded from this run
);

CREATE TABLE payroll_entries (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_period_id     uuid          NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  staff_id              uuid          NOT NULL REFERENCES staff(id),
  company_id            uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Earnings
  basic_salary          numeric(14,2) NOT NULL DEFAULT 0,
  total_allowances      numeric(14,2) NOT NULL DEFAULT 0,
  gross_salary          numeric(14,2) NOT NULL DEFAULT 0,  -- basic + allowances

  -- Ghana SSNIT (computed from gross)
  -- Tier 1: 13% employer + 5.5% employee (of basic salary only, per SSNIT rules)
  ssnit_employee        numeric(14,2) NOT NULL DEFAULT 0,  -- 5.5% of basic
  ssnit_employer        numeric(14,2) NOT NULL DEFAULT 0,  -- 13% of basic
  -- Tier 2: 5% of basic (from employer's 13%, 5% goes to Tier 2)
  tier2_contribution    numeric(14,2) NOT NULL DEFAULT 0,  -- 5% of basic (from employer share)

  -- Taxable income = gross - SSNIT employee share - tax reliefs
  taxable_income        numeric(14,2) NOT NULL DEFAULT 0,
  income_tax_paye       numeric(14,2) NOT NULL DEFAULT 0,  -- Ghana PAYE

  -- Other deductions (loans, advances, welfare, etc.)
  total_other_deductions numeric(14,2) NOT NULL DEFAULT 0,

  -- Net pay
  net_salary            numeric(14,2) NOT NULL DEFAULT 0,

  -- Payment details
  payment_method        varchar(20)   NOT NULL DEFAULT 'bank',
  bank_name             varchar(100),
  bank_account_number   varchar(30),

  -- Status & overrides
  status                payroll_entry_status NOT NULL DEFAULT 'computed',
  notes                 text,
  is_manually_adjusted  boolean       NOT NULL DEFAULT false,

  -- Audit
  computed_at           timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  adjusted_by           uuid          REFERENCES staff(id),
  adjusted_at           timestamp,

  UNIQUE (payroll_period_id, staff_id)
);


-- ============================================================
-- 10. PAYROLL ENTRY ALLOWANCE LINES
-- Breakdown of each allowance in a payroll entry
-- ============================================================

CREATE TABLE payroll_entry_allowances (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_entry_id  uuid          NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  allowance_type_id uuid          NOT NULL REFERENCES allowance_types(id),
  name              varchar(100)  NOT NULL,
  amount            numeric(14,2) NOT NULL,
  taxability        allowance_taxability NOT NULL DEFAULT 'taxable'
);


-- ============================================================
-- 11. PAYROLL ENTRY DEDUCTION LINES
-- Breakdown of each deduction in a payroll entry
-- ============================================================

CREATE TABLE payroll_entry_deductions (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_entry_id    uuid          NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  deduction_type_id   uuid          REFERENCES deduction_types(id),
  name                varchar(100)  NOT NULL,   -- "SSNIT", "PAYE", "Loan", etc.
  amount              numeric(14,2) NOT NULL,
  category            varchar(30)   NOT NULL    -- 'ssnit' | 'paye' | 'tier2' | 'other'
);


-- ============================================================
-- 12. PAYSLIPS (locked, printable record)
-- Generated when payroll is approved. Immutable.
-- ============================================================

CREATE TABLE payslips (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_entry_id    uuid          NOT NULL UNIQUE REFERENCES payroll_entries(id),
  payroll_period_id   uuid          NOT NULL REFERENCES payroll_periods(id),
  staff_id            uuid          NOT NULL REFERENCES staff(id),
  company_id          uuid          NOT NULL REFERENCES companies(id),

  -- Snapshot of staff info at time of payslip (never changes even if staff updates)
  staff_name          varchar(255)  NOT NULL,
  staff_id_number     varchar(50)   NOT NULL,
  job_title           varchar(100),
  department          varchar(100),
  tin_number          varchar(30),
  ssnit_number        varchar(30),
  bank_name           varchar(100),
  bank_account_number varchar(30),

  -- Period
  period_label        varchar(100)  NOT NULL,  -- "April 2025"
  period_start        date          NOT NULL,
  period_end          date          NOT NULL,
  payment_date        date,

  -- All computed figures (snapshot — never recalculated)
  basic_salary        numeric(14,2) NOT NULL,
  total_allowances    numeric(14,2) NOT NULL,
  gross_salary        numeric(14,2) NOT NULL,
  ssnit_employee      numeric(14,2) NOT NULL,
  ssnit_employer      numeric(14,2) NOT NULL,
  tier2_contribution  numeric(14,2) NOT NULL,
  taxable_income      numeric(14,2) NOT NULL,
  income_tax_paye     numeric(14,2) NOT NULL,
  total_deductions    numeric(14,2) NOT NULL,
  net_salary          numeric(14,2) NOT NULL,

  -- Full line-item snapshot as JSON (portable, printable)
  allowances_json     jsonb         NOT NULL DEFAULT '[]',
  deductions_json     jsonb         NOT NULL DEFAULT '[]',

  -- Reference
  payslip_number      varchar(50)   NOT NULL,  -- e.g. "PS-2025-04-001"
  generated_at        timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, payslip_number)
);

CREATE SEQUENCE payslip_seq START 1;
CREATE OR REPLACE FUNCTION generate_payslip_number(p_company_id uuid, p_year int, p_month int)
RETURNS varchar AS $$
BEGIN
  RETURN 'PS-' || p_year || '-' || LPAD(p_month::text,2,'0') || '-' || LPAD(nextval('payslip_seq')::text,4,'0');
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 13. GHANA PAYE TAX BANDS (2024 rates)
-- Stored in DB so they can be updated without code changes.
-- ============================================================

CREATE TABLE paye_tax_bands (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid          REFERENCES companies(id) ON DELETE CASCADE,
  -- NULL company_id = system default (applies to all)
  effective_year int         NOT NULL,
  band_order   int           NOT NULL,
  lower_limit  numeric(14,2) NOT NULL,
  upper_limit  numeric(14,2),           -- NULL = unlimited
  rate         numeric(5,4)  NOT NULL,  -- 0.0500 = 5%
  description  varchar(50),
  UNIQUE (company_id, effective_year, band_order)
);

-- Insert 2024 Ghana PAYE bands (annual)
-- Source: GRA Ghana 2024
INSERT INTO paye_tax_bands (company_id, effective_year, band_order, lower_limit, upper_limit, rate, description) VALUES
  (NULL, 2024, 1,      0.00,   4380.00, 0.0000, 'First GHS 4,380 — 0%'),
  (NULL, 2024, 2,   4380.00,   5100.00, 0.0500, 'Next GHS 720 — 5%'),
  (NULL, 2024, 3,   5100.00,   6900.00, 0.1000, 'Next GHS 1,800 — 10%'),
  (NULL, 2024, 4,   6900.00,  10380.00, 0.1750, 'Next GHS 3,480 — 17.5%'),
  (NULL, 2024, 5,  10380.00,  41580.00, 0.2500, 'Next GHS 31,200 — 25%'),
  (NULL, 2024, 6,  41580.00, 240000.00, 0.3000, 'Next GHS 198,420 — 30%'),
  (NULL, 2024, 7, 240000.00,       NULL, 0.3500, 'Exceeding GHS 240,000 — 35%');


-- ============================================================
-- 14. INDEXES
-- ============================================================

CREATE INDEX idx_payroll_periods_company    ON payroll_periods(company_id, period_start DESC);
CREATE INDEX idx_payroll_entries_period     ON payroll_entries(payroll_period_id);
CREATE INDEX idx_payroll_entries_staff      ON payroll_entries(staff_id);
CREATE INDEX idx_payslips_staff             ON payslips(staff_id, period_start DESC);
CREATE INDEX idx_payslips_period            ON payslips(payroll_period_id);
CREATE INDEX idx_staff_salary_profile_staff ON staff_salary_profiles(staff_id);
CREATE INDEX idx_staff_allowances_staff     ON staff_allowances(staff_id);
CREATE INDEX idx_staff_deductions_staff     ON staff_deductions(staff_id);


-- ============================================================
-- 15. SEED DEFAULT ALLOWANCE TYPES (common in Ghana)
-- These get created once per company during onboarding.
-- ============================================================

CREATE OR REPLACE FUNCTION seed_payroll_defaults(
  p_company_id uuid,
  p_created_by uuid
) RETURNS void AS $$
BEGIN
  -- Allowance types
  INSERT INTO allowance_types (company_id, name, description, is_recurring, taxability, created_by) VALUES
    (p_company_id, 'Housing Allowance',   'Monthly housing support',            true,  'taxable',     p_created_by),
    (p_company_id, 'Transport Allowance', 'Monthly transport support',           true,  'non_taxable', p_created_by),
    (p_company_id, 'Meal Allowance',      'Daily/monthly meal support',          true,  'non_taxable', p_created_by),
    (p_company_id, 'Medical Allowance',   'Healthcare support',                  true,  'non_taxable', p_created_by),
    (p_company_id, 'Performance Bonus',   'Discretionary performance bonus',     false, 'taxable',     p_created_by),
    (p_company_id, 'Overtime Pay',        'Pay for overtime hours',              false, 'taxable',     p_created_by),
    (p_company_id, 'Responsibility Allowance', 'Extra duties allowance',         true,  'taxable',     p_created_by)
  ON CONFLICT (company_id, name) DO NOTHING;

  -- Deduction types
  INSERT INTO deduction_types (company_id, name, description, is_recurring, tax_treatment, created_by) VALUES
    (p_company_id, 'Staff Loan Repayment', 'Monthly deduction for staff loan',  true,  'post_tax', p_created_by),
    (p_company_id, 'Salary Advance',       'Recovery of salary advance',        false, 'post_tax', p_created_by),
    (p_company_id, 'Welfare Fund',         'Monthly staff welfare contribution', true,  'post_tax', p_created_by),
    (p_company_id, 'Cooperative',          'Staff cooperative deduction',        true,  'post_tax', p_created_by),
    (p_company_id, 'Uniform Deduction',    'Deduction for uniform cost',         false, 'post_tax', p_created_by),
    (p_company_id, 'Absenteeism',          'Deduction for unauthorised absence', false, 'post_tax', p_created_by)
  ON CONFLICT (company_id, name) DO NOTHING;

  RAISE NOTICE 'Payroll defaults seeded for company %', p_company_id;
END;
$$ LANGUAGE plpgsql;