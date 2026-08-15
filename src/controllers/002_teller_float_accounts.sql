-- ─────────────────────────────────────────────────────────────────────────
-- OPTIONAL / FUTURE: dedicated per-teller float accounts.
--
-- You don't need this yet — with one teller, the shared "1010-02" account
-- scoped by journal_entry_lines.staff_id already gives you an accurate
-- per-teller float. Run this migration when you're ready to:
--   - give each teller their own COA row (own code, own audit trail)
--   - track a formal opening balance per shift/assignment
--   - open/close a teller's float independently of others
--
-- tellerFloatController.mjs already checks this table first and falls
-- back to the shared account automatically, so provisioning a teller
-- here is the ONLY change needed to switch them over — no controller
-- edits required.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS teller_float_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id),
  staff_id        UUID NOT NULL REFERENCES staff(id),
  coa_id          UUID NOT NULL REFERENCES chart_of_accounts(id),
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one ACTIVE float account per teller at a time (they can be
-- deactivated and re-provisioned later without breaking history).
CREATE UNIQUE INDEX IF NOT EXISTS teller_float_accounts_active_staff_uidx
  ON teller_float_accounts (company_id, staff_id)
  WHERE is_active = true;

-- ─────────────────────────────────────────────────────────────────────────
-- Example provisioning for a teller (run once per teller you migrate):
--
--   1. Create their dedicated COA row as a sub-account of "1010-02":
--
--      INSERT INTO chart_of_accounts
--        (company_id, code, name, account_type, category, normal_balance,
--         parent_id, is_sub_account, created_by)
--      SELECT
--        company_id, '1010-02-' || LEFT(id::text, 8), 'Teller Float — <name>',
--        'asset', 'current_asset', 'debit', id, true, '<admin_staff_id>'
--      FROM chart_of_accounts
--      WHERE company_id = '<company_id>' AND code = '1010-02'
--      RETURNING id;
--
--   2. Link it to the teller:
--
--      INSERT INTO teller_float_accounts (company_id, staff_id, coa_id, opening_balance)
--      VALUES ('<company_id>', '<staff_id>', '<new_coa_id_from_step_1>', 0);
--
-- From that point, every deposit/withdrawal your write-side controllers
-- post for that teller should resolve the float COA via the same lookup
-- (company_id + staff_id → teller_float_accounts) instead of the hardcoded
-- "1010-02" string, so their cash lands on their own account. Happy to
-- wire that resolver into stakeMoney / approveTransaction / reverseWithdrawal
-- when you're ready to onboard a second teller — say the word.
-- ─────────────────────────────────────────────────────────────────────────
