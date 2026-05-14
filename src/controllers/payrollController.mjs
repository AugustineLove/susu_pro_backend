// ============================================================
// payrollController.mjs
// Complete Ghana-compliant payroll backend
// ============================================================

import pool from "../db.mjs";
import { postJournalEntry, resolveCOA } from "../services/accountingHelper.mjs";

// ─────────────────────────────────────────────────────────────
// GHANA PAYE CALCULATOR
// Computes monthly income tax using the annual bands.
// Annual taxable = monthly taxable × 12
// Tax is computed annually then divided by 12.
// ─────────────────────────────────────────────────────────────
async function computePAYE(client, companyId, monthlyTaxableIncome) {
  const year = new Date().getFullYear();

  // Fetch bands — company-specific first, fallback to system defaults
  const bandsRes = await client.query(
    `SELECT lower_limit, upper_limit, rate
     FROM paye_tax_bands
     WHERE (company_id = $1 OR company_id IS NULL)
       AND effective_year = $2
     ORDER BY company_id NULLS LAST, band_order ASC`,
    [companyId, year]
  );

  const bands = bandsRes.rows;
  const annualIncome = monthlyTaxableIncome * 12;
  let annualTax = 0;
  let remaining = annualIncome;

  for (const band of bands) {
    if (remaining <= 0) break;
    const lower = parseFloat(band.lower_limit);
    const upper = band.upper_limit ? parseFloat(band.upper_limit) : Infinity;
    const bandSize = upper - lower;
    const taxable = Math.min(remaining, bandSize);
    annualTax += taxable * parseFloat(band.rate);
    remaining -= taxable;
  }

  return Math.max(0, parseFloat((annualTax / 12).toFixed(2)));
}

// ─────────────────────────────────────────────────────────────
// COMPUTE ONE STAFF MEMBER'S PAYROLL
// Returns all figures without saving anything.
// ─────────────────────────────────────────────────────────────
async function computeStaffPayroll(client, staffId, companyId) {
  // 1. Fetch salary profile
  const profileRes = await client.query(
    `SELECT sp.*, sg.basic_salary AS grade_salary,
            s.bank_name, s.bank_account_number, s.payment_method AS staff_payment_method,
            s.tin_number, s.ssnit_number, s.full_name, s.staff_id AS staff_id_number,
            s.job_title, s.department, s.ssnit_number, s.national_id,
            s.bank_account_name
     FROM staff_salary_profiles sp
     JOIN staff s ON s.id = sp.staff_id
     LEFT JOIN salary_grades sg ON sg.id = sp.grade_id
     WHERE sp.staff_id = $1 AND sp.company_id = $2
       AND sp.effective_from <= CURRENT_DATE
       AND (sp.effective_to IS NULL OR sp.effective_to >= CURRENT_DATE)
     ORDER BY sp.effective_from DESC
     LIMIT 1`,
    [staffId, companyId]
  );

  if (!profileRes.rows.length)
    throw new Error(`No salary profile found for staff ${staffId}`);

  const profile    = profileRes.rows[0];
  const basicSalary = profile.use_grade_salary && profile.grade_salary
    ? parseFloat(profile.grade_salary)
    : parseFloat(profile.basic_salary);

  // 2. Fetch active allowances
  const allowancesRes = await client.query(
    `SELECT sa.*, at.name, at.taxability, sa.calculation_type, sa.amount
     FROM staff_allowances sa
     JOIN allowance_types at ON at.id = sa.allowance_type_id
     WHERE sa.staff_id = $1 AND sa.company_id = $2
       AND sa.is_active = true
       AND sa.effective_from <= CURRENT_DATE
       AND (sa.effective_to IS NULL OR sa.effective_to >= CURRENT_DATE)`,
    [staffId, companyId]
  );

  // 3. Fetch active other deductions
  const deductionsRes = await client.query(
    `SELECT sd.*, dt.name, dt.tax_treatment, sd.calculation_type, sd.amount
     FROM staff_deductions sd
     JOIN deduction_types dt ON dt.id = sd.deduction_type_id
     WHERE sd.staff_id = $1 AND sd.company_id = $2
       AND sd.is_active = true
       AND sd.effective_from <= CURRENT_DATE
       AND (sd.effective_to IS NULL OR sd.effective_to >= CURRENT_DATE)
       AND (sd.total_limit IS NULL OR sd.amount_paid < sd.total_limit)`,
    [staffId, companyId]
  );

  // 4. Compute allowances
  const allowanceLines = allowancesRes.rows.map(a => {
    const amt = a.calculation_type === "percentage_of_basic"
      ? parseFloat((basicSalary * parseFloat(a.amount) / 100).toFixed(2))
      : parseFloat(a.amount);
    return {
      allowance_type_id: a.allowance_type_id,
      name:        a.name,
      amount:      amt,
      taxability:  a.taxability,
    };
  });

  const totalAllowances = allowanceLines.reduce((s, a) => s + a.amount, 0);
  const grossSalary     = parseFloat((basicSalary + totalAllowances).toFixed(2));

  // 5. SSNIT — based on BASIC salary only (per SSNIT Act 766)
  const ssnitEmployee    = profile.ssnit_exempt ? 0 : parseFloat((basicSalary * 0.055).toFixed(2)); // 5.5%
  const ssnitEmployer    = profile.ssnit_exempt ? 0 : parseFloat((basicSalary * 0.13).toFixed(2));  // 13%
  const tier2            = profile.ssnit_exempt ? 0 : parseFloat((basicSalary * 0.05).toFixed(2));  // 5% from employer share → Tier 2

  // 6. Taxable income
  // Taxable = Gross − SSNIT employee contribution − non-taxable allowances − tax relief
  const nonTaxableAllowances = allowanceLines
    .filter(a => a.taxability === "non_taxable")
    .reduce((s, a) => s + a.amount, 0);

  const taxableIncome = Math.max(0, parseFloat((
    grossSalary - ssnitEmployee - nonTaxableAllowances - parseFloat(profile.tax_relief || 0)
  ).toFixed(2)));

  // 7. PAYE (Ghana)
  const paye = profile.is_tax_exempt ? 0 : await computePAYE(client, companyId, taxableIncome);

  // 8. Other deductions
  const deductionLines = deductionsRes.rows.map(d => {
    let amt;
    if (d.calculation_type === "percentage_of_basic") {
      amt = parseFloat((basicSalary * parseFloat(d.amount) / 100).toFixed(2));
    } else if (d.calculation_type === "percentage_of_gross") {
      amt = parseFloat((grossSalary * parseFloat(d.amount) / 100).toFixed(2));
    } else {
      amt = parseFloat(d.amount);
    }
    // Cap at remaining balance if total_limit set
    if (d.total_limit) {
      const remaining = parseFloat(d.total_limit) - parseFloat(d.amount_paid);
      amt = Math.min(amt, remaining);
    }
    return {
      deduction_type_id: d.deduction_type_id,
      name:   d.name,
      amount: Math.max(0, amt),
      category: "other",
    };
  });

  const totalOtherDeductions = deductionLines.reduce((s, d) => s + d.amount, 0);

  // 9. Net salary
  const netSalary = parseFloat((
    grossSalary - ssnitEmployee - paye - totalOtherDeductions
  ).toFixed(2));

  // All statutory deduction lines for the payslip
  const allDeductionLines = [
    { name: "SSNIT (Employee 5.5%)", amount: ssnitEmployee, category: "ssnit" },
    { name: "PAYE Income Tax",        amount: paye,          category: "paye" },
    ...deductionLines,
  ];

  return {
    staff:            profile,
    basicSalary,
    allowanceLines,
    totalAllowances,
    grossSalary,
    ssnitEmployee,
    ssnitEmployer,
    tier2,
    taxableIncome,
    paye,
    deductionLines,
    totalOtherDeductions,
    allDeductionLines,
    netSalary,
    paymentMethod:     profile.staff_payment_method || profile.payment_method,
    bankName:          profile.bank_name,
    bankAccountNumber: profile.bank_account_number,
  };
}


// ============================================================
// ── SALARY PROFILES ─────────────────────────────────────────
// ============================================================

export const getSalaryProfile = async (req, res) => {
  const { companyId, staffId } = req.params;
  try {
    const r = await pool.query(
      `SELECT sp.*,
              sg.name AS grade_name, sg.basic_salary AS grade_salary, sg.salary_account_number,
              s.full_name, s.role, s.department, s.job_title,
              s.bank_name, s.bank_account_number, s.bank_account_name,
              s.tin_number, s.ssnit_number, s.hire_date, s.employment_type
       FROM staff_salary_profiles sp
       JOIN staff s ON s.id = sp.staff_id
       LEFT JOIN salary_grades sg ON sg.id = sp.grade_id
       WHERE sp.staff_id = $1 AND sp.company_id = $2
       ORDER BY sp.effective_from DESC LIMIT 1`,
      [staffId, companyId]
    );
    return res.json({ status: "success", data: r.rows[0] || null });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const upsertSalaryProfile = async (req, res) => {
  const { companyId, staffId } = req.params;
  const {
    grade_id, basic_salary, use_grade_salary, payment_method,
    is_tax_exempt, tax_relief, ssnit_exempt, effective_from,
    created_by, salary_account_number,
    // staff fields to update too
    tin_number, ssnit_number, bank_name, bank_branch,
    bank_account_name, bank_account_number, hire_date,
    employment_type, department, job_title,
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Update staff table with payroll-relevant fields
    await client.query(
      `UPDATE staff SET
         tin_number = COALESCE($1, tin_number),
         ssnit_number = COALESCE($2, ssnit_number),
         bank_name = COALESCE($3, bank_name),
         bank_branch = COALESCE($4, bank_branch),
         bank_account_name = COALESCE($5, bank_account_name),
         bank_account_number = COALESCE($6, bank_account_number),
         hire_date = COALESCE($7, hire_date),
         employment_type = COALESCE($8, employment_type),
         department = COALESCE($9, department),
         job_title = COALESCE($10, job_title),
         salary_account_number = COALESCE($11, salary_account_number),
         updated_at = NOW()
       WHERE id = $12 AND company_id = $13`,
      [tin_number, ssnit_number, bank_name, bank_branch,
       bank_account_name, bank_account_number, hire_date,
       employment_type, department, job_title, salary_account_number, staffId, companyId]
    );

    // Upsert salary profile
    const r = await client.query(
      `INSERT INTO staff_salary_profiles
         (staff_id, company_id, grade_id, basic_salary, use_grade_salary,
          payment_method, is_tax_exempt, tax_relief, ssnit_exempt,
          effective_from, created_by, salary_account_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (staff_id) DO UPDATE SET
         grade_id        = EXCLUDED.grade_id,
         basic_salary    = EXCLUDED.basic_salary,
         use_grade_salary = EXCLUDED.use_grade_salary,
         payment_method  = EXCLUDED.payment_method,
         is_tax_exempt   = EXCLUDED.is_tax_exempt,
         tax_relief      = EXCLUDED.tax_relief,
         ssnit_exempt    = EXCLUDED.ssnit_exempt,
         effective_from  = EXCLUDED.effective_from,
         salary_account_number = EXCLUDED.salary_account_number,
         updated_at      = NOW()
       RETURNING *`,
      [staffId, companyId, grade_id || null, basic_salary || 0,
       use_grade_salary || false, payment_method || "bank",
       is_tax_exempt || false, tax_relief || 0,
       ssnit_exempt || false, effective_from || new Date().toISOString().slice(0,10),
       created_by, salary_account_number]
    );

    await client.query("COMMIT");
    return res.status(200).json({ status: "success", data: r.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ status: "error", message: e.message });
  } finally {
    client.release();
  }
};

export const getAllStaffWithPayrollInfo = async (req, res) => {
  const { companyId } = req.params;
  try {
    const r = await pool.query(
      `SELECT s.id, s.staff_id, s.full_name, s.role, s.department,
              s.job_title, s.employment_type, s.hire_date, s.status,
              s.is_payroll_active, s.bank_name, s.bank_account_number,
              s.tin_number, s.ssnit_number,
              sp.basic_salary, sp.payment_method, sp.is_tax_exempt,
              sp.ssnit_exempt, sp.grade_id,
              sg.name AS grade_name,
              COALESCE(
                (SELECT SUM(amount) FROM staff_allowances sa
                 WHERE sa.staff_id = s.id AND sa.is_active = true), 0
              ) AS total_allowances,
              COALESCE(
                (SELECT SUM(amount) FROM staff_deductions sd
                 WHERE sd.staff_id = s.id AND sd.is_active = true), 0
              ) AS total_deductions
       FROM staff s
       LEFT JOIN staff_salary_profiles sp ON sp.staff_id = s.id
       LEFT JOIN salary_grades sg ON sg.id = sp.grade_id
       WHERE s.company_id = $1
         AND s.status = 'active'
         AND s.is_payroll_active = true
       ORDER BY s.full_name`,
      [companyId]
    );
    return res.json({ status: "success", data: r.rows, count: r.rowCount });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};


// ============================================================
// ── ALLOWANCES & DEDUCTIONS ──────────────────────────────────
// ============================================================

export const getStaffAllowances = async (req, res) => {
  const { companyId, staffId } = req.params;
  try {
    const r = await pool.query(
      `SELECT sa.*, at.name AS type_name, at.taxability, at.is_recurring
       FROM staff_allowances sa
       JOIN allowance_types at ON at.id = sa.allowance_type_id
       WHERE sa.staff_id = $1 AND sa.company_id = $2
       ORDER BY sa.created_at DESC`,
      [staffId, companyId]
    );
    return res.json({ status: "success", data: r.rows });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const addStaffAllowance = async (req, res) => {
  const { companyId, staffId } = req.params;
  const { allowance_type_id, calculation_type, amount, effective_from, effective_to, created_by } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO staff_allowances
         (staff_id, company_id, allowance_type_id, calculation_type, amount, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [staffId, companyId, allowance_type_id, calculation_type || "fixed",
       amount, effective_from || new Date().toISOString().slice(0,10),
       effective_to || null, created_by]
    );
    return res.status(201).json({ status: "success", data: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const removeStaffAllowance = async (req, res) => {
  const { companyId, allowanceId } = req.params;
  try {
    await pool.query(
      `UPDATE staff_allowances SET is_active = false WHERE id = $1 AND company_id = $2`,
      [allowanceId, companyId]
    );
    return res.json({ status: "success", message: "Allowance removed" });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const getStaffDeductions = async (req, res) => {
  const { companyId, staffId } = req.params;
  try {
    const r = await pool.query(
      `SELECT sd.*, dt.name AS type_name, dt.tax_treatment, dt.is_recurring
       FROM staff_deductions sd
       JOIN deduction_types dt ON dt.id = sd.deduction_type_id
       WHERE sd.staff_id = $1 AND sd.company_id = $2
       ORDER BY sd.created_at DESC`,
      [staffId, companyId]
    );
    return res.json({ status: "success", data: r.rows });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const addStaffDeduction = async (req, res) => {
  const { companyId, staffId } = req.params;
  const { deduction_type_id, calculation_type, amount, total_limit, effective_from, effective_to, created_by } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO staff_deductions
         (staff_id, company_id, deduction_type_id, calculation_type, amount,
          total_limit, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [staffId, companyId, deduction_type_id, calculation_type || "fixed",
       amount, total_limit || null,
       effective_from || new Date().toISOString().slice(0,10),
       effective_to || null, created_by]
    );
    return res.status(201).json({ status: "success", data: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const removeStaffDeduction = async (req, res) => {
  const { companyId, deductionId } = req.params;
  try {
    await pool.query(
      `UPDATE staff_deductions SET is_active = false WHERE id = $1 AND company_id = $2`,
      [deductionId, companyId]
    );
    return res.json({ status: "success", message: "Deduction removed" });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

// Allowance & Deduction type lists
export const getPayrollTypes = async (req, res) => {
  const { companyId } = req.params;
  try {
    const [allowTypes, deductTypes, grades] = await Promise.all([
      pool.query(`SELECT * FROM allowance_types WHERE company_id=$1 AND is_active=true ORDER BY name`, [companyId]),
      pool.query(`SELECT * FROM deduction_types WHERE company_id=$1 AND is_active=true ORDER BY name`, [companyId]),
      pool.query(`SELECT * FROM salary_grades WHERE company_id=$1 AND is_active=true ORDER BY name`, [companyId]),
    ]);
    return res.json({
      status: "success",
      data: {
        allowanceTypes: allowTypes.rows,
        deductionTypes: deductTypes.rows,
        salaryGrades:   grades.rows,
      },
    });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};


// ============================================================
// ── PAYROLL PERIODS ──────────────────────────────────────────
// ============================================================

export const getPayrollPeriods = async (req, res) => {
  const { companyId } = req.params;
  try {
    const r = await pool.query(
      `SELECT pp.*,
              s_created.full_name AS created_by_name,
              s_approved.full_name AS approved_by_name
       FROM payroll_periods pp
       LEFT JOIN staff s_created  ON s_created.id  = pp.created_by
       LEFT JOIN staff s_approved ON s_approved.id = pp.approved_by
       WHERE pp.company_id = $1
       ORDER BY pp.period_start DESC`,
      [companyId]
    );
    return res.json({ status: "success", data: r.rows });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const createPayrollPeriod = async (req, res) => {
  const { companyId } = req.params;
  const { name, period_start, period_end, payment_date, notes, created_by } = req.body;

  if (!name || !period_start || !period_end || !created_by)
    return res.status(400).json({ status: "fail", message: "name, period_start, period_end, created_by required" });

  try {
    const r = await pool.query(
      `INSERT INTO payroll_periods
         (company_id, name, period_start, period_end, payment_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [companyId, name, period_start, period_end, payment_date || null, notes || null, created_by]
    );
    return res.status(201).json({ status: "success", data: r.rows[0] });
  } catch (e) {
    if (e.code === "23505")
      return res.status(409).json({ status: "fail", message: "A payroll period with these dates already exists" });
    return res.status(500).json({ status: "error", message: e.message });
  }
};


// ============================================================
// ── RUN PAYROLL (compute all entries) ───────────────────────
// ============================================================
// Computes every active staff member's payroll figures for
// the given period. Saves/replaces entries as 'computed'.
// Does NOT post to accounting yet — that happens on approval.

export const runPayroll = async (req, res) => {
  const { companyId, periodId } = req.params;
  const { created_by } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Fetch + validate the period
    const periodRes = await client.query(
      `SELECT * FROM payroll_periods WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [periodId, companyId]
    );
    if (!periodRes.rows.length)
      throw new Error("Payroll period not found");

    const period = periodRes.rows[0];
    if (!["draft","reviewed"].includes(period.status))
      throw new Error(`Cannot run payroll — period is '${period.status}'`);

    // 2. Fetch all active payroll-eligible staff
    const staffRes = await client.query(
      `SELECT s.id AS staff_id
       FROM staff s
       JOIN staff_salary_profiles sp ON sp.staff_id = s.id
       WHERE s.company_id = $1
         AND s.status = 'active'
         AND s.is_payroll_active = true
         AND sp.company_id = $1
         AND sp.effective_from <= $2
         AND (sp.effective_to IS NULL OR sp.effective_to >= $3)`,
      [companyId, period.period_end, period.period_start]
    );

    if (staffRes.rowCount === 0)
      throw new Error("No eligible staff found. Ensure staff have salary profiles.");

    // 3. Delete any existing computed entries for this period
    await client.query(
      `DELETE FROM payroll_entry_allowances
       WHERE payroll_entry_id IN (
         SELECT id FROM payroll_entries WHERE payroll_period_id = $1
       )`,
      [periodId]
    );
    await client.query(
      `DELETE FROM payroll_entry_deductions
       WHERE payroll_entry_id IN (
         SELECT id FROM payroll_entries WHERE payroll_period_id = $1
       )`,
      [periodId]
    );
    await client.query(
      `DELETE FROM payroll_entries WHERE payroll_period_id = $1 AND status = 'computed'`,
      [periodId]
    );

    // 4. Compute each staff member
    let totalGross = 0, totalNet = 0, totalTax = 0;
    let totalSsnitEmp = 0, totalSsnitEr = 0, totalTier2 = 0, totalDeductions = 0;
    let count = 0;

    for (const row of staffRes.rows) {
      let computed;
      try {
        computed = await computeStaffPayroll(client, row.staff_id, companyId);
      } catch (err) {
        console.warn(`Skipping staff ${row.staff_id}: ${err.message}`);
        continue;
      }

      // Insert entry
      const entryRes = await client.query(
        `INSERT INTO payroll_entries (
           payroll_period_id, staff_id, company_id,
           basic_salary, total_allowances, gross_salary,
           ssnit_employee, ssnit_employer, tier2_contribution,
           taxable_income, income_tax_paye,
           total_other_deductions, net_salary,
           payment_method, bank_name, bank_account_number,
           status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'computed')
         ON CONFLICT (payroll_period_id, staff_id) DO UPDATE SET
           basic_salary = EXCLUDED.basic_salary,
           total_allowances = EXCLUDED.total_allowances,
           gross_salary = EXCLUDED.gross_salary,
           ssnit_employee = EXCLUDED.ssnit_employee,
           ssnit_employer = EXCLUDED.ssnit_employer,
           tier2_contribution = EXCLUDED.tier2_contribution,
           taxable_income = EXCLUDED.taxable_income,
           income_tax_paye = EXCLUDED.income_tax_paye,
           total_other_deductions = EXCLUDED.total_other_deductions,
           net_salary = EXCLUDED.net_salary,
           payment_method = EXCLUDED.payment_method,
           bank_name = EXCLUDED.bank_name,
           bank_account_number = EXCLUDED.bank_account_number,
           status = 'computed',
           computed_at = NOW()
         RETURNING id`,
        [
          periodId, row.staff_id, companyId,
          computed.basicSalary, computed.totalAllowances, computed.grossSalary,
          computed.ssnitEmployee, computed.ssnitEmployer, computed.tier2,
          computed.taxableIncome, computed.paye,
          computed.totalOtherDeductions, computed.netSalary,
          computed.paymentMethod, computed.bankName, computed.bankAccountNumber,
        ]
      );
      const entryId = entryRes.rows[0].id;

      // Insert allowance lines
      for (const a of computed.allowanceLines) {
        await client.query(
          `INSERT INTO payroll_entry_allowances
             (payroll_entry_id, allowance_type_id, name, amount, taxability)
           VALUES ($1,$2,$3,$4,$5)`,
          [entryId, a.allowance_type_id, a.name, a.amount, a.taxability]
        );
      }

      // Insert deduction lines
      for (const d of computed.allDeductionLines) {
        await client.query(
          `INSERT INTO payroll_entry_deductions
             (payroll_entry_id, deduction_type_id, name, amount, category)
           VALUES ($1,$2,$3,$4,$5)`,
          [entryId, d.deduction_type_id || null, d.name, d.amount, d.category]
        );
      }

      // Accumulate totals
      totalGross     += computed.grossSalary;
      totalNet       += computed.netSalary;
      totalTax       += computed.paye;
      totalSsnitEmp  += computed.ssnitEmployee;
      totalSsnitEr   += computed.ssnitEmployer;
      totalTier2     += computed.tier2;
      totalDeductions += computed.ssnitEmployee + computed.paye + computed.totalOtherDeductions;
      count++;
    }

    // 5. Update period totals
    await client.query(
      `UPDATE payroll_periods SET
         total_gross           = $1,
         total_net             = $2,
         total_tax             = $3,
         total_ssnit_employee  = $4,
         total_ssnit_employer  = $5,
         total_tier2           = $6,
         total_deductions      = $7,
         employee_count        = $8,
         status                = 'reviewed',
         updated_at            = NOW()
       WHERE id = $9`,
      [totalGross, totalNet, totalTax, totalSsnitEmp, totalSsnitEr,
       totalTier2, totalDeductions, count, periodId]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status:  "success",
      message: `Payroll computed for ${count} staff members`,
      data: {
        period_id:      periodId,
        employee_count: count,
        total_gross:    parseFloat(totalGross.toFixed(2)),
        total_net:      parseFloat(totalNet.toFixed(2)),
        total_tax:      parseFloat(totalTax.toFixed(2)),
        total_ssnit_employee: parseFloat(totalSsnitEmp.toFixed(2)),
        total_ssnit_employer: parseFloat(totalSsnitEr.toFixed(2)),
        total_tier2:    parseFloat(totalTier2.toFixed(2)),
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("runPayroll error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};


// ============================================================
// ── APPROVE PAYROLL + POST TO ACCOUNTING ────────────────────
// ============================================================
//
// Journal entries posted on approval:
//
//   GROSS SALARY EXPENSE
//     Dr  Salaries & Wages (5010-01)          total_gross
//     Cr  Salaries Payable (2040)             total_net
//     Cr  PAYE Tax Payable (2050)             total_paye
//     Cr  SSNIT Payable    (use 2060 or new)  total_ssnit_employee
//
//   EMPLOYER SSNIT EXPENSE
//     Dr  Staff Allowances & Benefits (5010-02)  total_ssnit_employer
//     Cr  SSNIT Payable                          total_ssnit_employer
//
// ============================================================

export const approvePayroll = async (req, res) => {
  const { companyId, periodId } = req.params;
  const { approved_by } = req.body;

  if (!approved_by)
    return res.status(400).json({ status: "fail", message: "approved_by is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const periodRes = await client.query(
      `SELECT * FROM payroll_periods WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [periodId, companyId]
    );
    if (!periodRes.rows.length) throw new Error("Payroll period not found");

    const period = periodRes.rows[0];
    if (period.status !== "reviewed")
      throw new Error(`Payroll must be in 'reviewed' status before approval. Current: '${period.status}'`);

    // ── Resolve COA accounts ──────────────────────────
    const salWagesCoaId   = await resolveCOA(client, companyId, "5010-01"); // Salaries & Wages expense
    const staffBenCoaId   = await resolveCOA(client, companyId, "5010-02"); // Staff Benefits (employer SSNIT)
    const salPayableCoaId = await resolveCOA(client, companyId, "2040");    // Salaries Payable
    const taxPayableCoaId = await resolveCOA(client, companyId, "2050");    // Tax Payable
    const ssnitPayCoaId   = await resolveCOA(client, companyId, "2060");    // SSNIT / Commissions Payable (reuse)

    const gross    = parseFloat(period.total_gross);
    const net      = parseFloat(period.total_net);
    const paye     = parseFloat(period.total_tax);
    const ssnitEmp = parseFloat(period.total_ssnit_employee);
    const ssnitEr  = parseFloat(period.total_ssnit_employer);

    // ── JE 1: Salary expense ──────────────────────────
    // Dr Salary Expense  = gross
    // Cr Salaries Payable = net
    // Cr PAYE Payable     = paye
    // Cr SSNIT Payable    = ssnit employee
    const ref1Res = await client.query("SELECT generate_journal_ref($1) AS ref", [companyId]);
    const je1Id   = (await client.query(
      `INSERT INTO journal_entries
         (company_id, reference_no, description, entry_date,
          source, source_id, source_table, status, created_by, posted_by, posted_at)
       VALUES ($1,$2,$3,$4,'expense',$5,'payroll_periods','posted',$6,$6,NOW())
       RETURNING id`,
      [companyId, ref1Res.rows[0].ref,
       `Payroll expense — ${period.name}`,
       period.payment_date || new Date().toISOString().slice(0,10),
       periodId, approved_by]
    )).rows[0].id;

    // Dr: Salary expense (gross)
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, description)
       VALUES ($1,$2,'debit',$3,$4)`,
      [je1Id, salWagesCoaId, gross, `Gross salary — ${period.name}`]
    );
    // Cr: Net salaries payable
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, description)
       VALUES ($1,$2,'credit',$3,$4)`,
      [je1Id, salPayableCoaId, net, `Net salaries payable — ${period.name}`]
    );
    // Cr: PAYE payable
    if (paye > 0) {
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, description)
         VALUES ($1,$2,'credit',$3,$4)`,
        [je1Id, taxPayableCoaId, paye, `PAYE income tax payable — ${period.name}`]
      );
    }
    // Cr: Employee SSNIT payable
    if (ssnitEmp > 0) {
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, description)
         VALUES ($1,$2,'credit',$3,$4)`,
        [je1Id, ssnitPayCoaId, ssnitEmp, `Employee SSNIT payable (5.5%) — ${period.name}`]
      );
    }

    // ── JE 2: Employer SSNIT ──────────────────────────
    // Dr Staff Benefits = employer SSNIT
    // Cr SSNIT Payable  = employer SSNIT
    if (ssnitEr > 0) {
      const ref2Res = await client.query("SELECT generate_journal_ref($1) AS ref", [companyId]);
      const je2Id   = (await client.query(
        `INSERT INTO journal_entries
           (company_id, reference_no, description, entry_date,
            source, source_id, source_table, status, created_by, posted_by, posted_at)
         VALUES ($1,$2,$3,$4,'expense',$5,'payroll_periods','posted',$6,$6,NOW())
         RETURNING id`,
        [companyId, ref2Res.rows[0].ref,
         `Employer SSNIT contribution — ${period.name}`,
         period.payment_date || new Date().toISOString().slice(0,10),
         periodId, approved_by]
      )).rows[0].id;

      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, description)
         VALUES ($1,$2,'debit',$3,$4)`,
        [je2Id, staffBenCoaId, ssnitEr, `Employer SSNIT (13%) — ${period.name}`]
      );
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, coa_id, debit_credit, amount, description)
         VALUES ($1,$2,'credit',$3,$4)`,
        [je2Id, ssnitPayCoaId, ssnitEr, `Employer SSNIT payable — ${period.name}`]
      );
    }

    // ── Approve entries + generate payslips ──────────
    const entriesRes = await client.query(
      `SELECT pe.*, s.full_name, s.staff_id AS staff_id_number, s.tin_number,
              s.ssnit_number, s.job_title, s.department, s.bank_name, s.bank_account_number
       FROM payroll_entries pe
       JOIN staff s ON s.id = pe.staff_id
       WHERE pe.payroll_period_id = $1 AND pe.status != 'excluded'`,
      [periodId]
    );

    for (const entry of entriesRes.rows) {
      // Fetch allowance/deduction lines for this entry
      const [allowLines, deductLines] = await Promise.all([
        client.query(
          `SELECT * FROM payroll_entry_allowances WHERE payroll_entry_id = $1`,
          [entry.id]
        ),
        client.query(
          `SELECT * FROM payroll_entry_deductions WHERE payroll_entry_id = $1`,
          [entry.id]
        ),
      ]);

      const year  = new Date(period.period_start).getFullYear();
      const month = new Date(period.period_start).getMonth() + 1;
      const psNum = await client.query(
        "SELECT generate_payslip_number($1,$2,$3) AS num",
        [companyId, year, month]
      );

      await client.query(
        `INSERT INTO payslips (
           payroll_entry_id, payroll_period_id, staff_id, company_id,
           staff_name, staff_id_number, job_title, department,
           tin_number, ssnit_number, bank_name, bank_account_number,
           period_label, period_start, period_end, payment_date,
           basic_salary, total_allowances, gross_salary,
           ssnit_employee, ssnit_employer, tier2_contribution,
           taxable_income, income_tax_paye, total_deductions, net_salary,
           allowances_json, deductions_json, payslip_number
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
           $27,$28,$29
         ) ON CONFLICT (payroll_entry_id) DO NOTHING`,
        [
          entry.id, periodId, entry.staff_id, companyId,
          entry.full_name, entry.staff_id_number, entry.job_title, entry.department,
          entry.tin_number, entry.ssnit_number, entry.bank_name, entry.bank_account_number,
          period.name, period.period_start, period.period_end, period.payment_date,
          entry.basic_salary, entry.total_allowances, entry.gross_salary,
          entry.ssnit_employee, entry.ssnit_employer, entry.tier2_contribution,
          entry.taxable_income, entry.income_tax_paye,
          parseFloat(entry.ssnit_employee) + parseFloat(entry.income_tax_paye) + parseFloat(entry.total_other_deductions),
          entry.net_salary,
          JSON.stringify(allowLines.rows),
          JSON.stringify(deductLines.rows),
          psNum.rows[0].num,
        ]
      );

      // Mark entry as approved
      await client.query(
        `UPDATE payroll_entries SET status = 'approved' WHERE id = $1`,
        [entry.id]
      );
    }

    // ── Update period status ──────────────────────────
    await client.query(
      `UPDATE payroll_periods SET
         status      = 'approved',
         approved_by = $1,
         approved_at = NOW(),
         accounting_je_id = $2,
         updated_at  = NOW()
       WHERE id = $3`,
      [approved_by, je1Id, periodId]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status:  "success",
      message: `Payroll approved. ${entriesRes.rowCount} payslips generated. Accounting entries posted.`,
      data:    { period_id: periodId, payslips_generated: entriesRes.rowCount },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("approvePayroll error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};


// ============================================================
// ── MARK PAYROLL AS PAID ─────────────────────────────────────
// ============================================================
// When salaries are actually disbursed to bank accounts:
//   Dr  Salaries Payable (2040)   total_net  ← liability cleared
//   Cr  Bank Account    (1020-01) total_net  ← cash goes out

export const markPayrollPaid = async (req, res) => {
  const { companyId, periodId } = req.params;
  const { paid_by, payment_date } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const periodRes = await client.query(
      `SELECT * FROM payroll_periods WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [periodId, companyId]
    );
    if (!periodRes.rows.length) throw new Error("Period not found");

    const period = periodRes.rows[0];
    if (period.status !== "approved") throw new Error("Only approved payrolls can be marked paid");

    const net          = parseFloat(period.total_net);
    const salPayableId = await resolveCOA(client, companyId, "2040");
    const bankCoaId    = await resolveCOA(client, companyId, "1020-01");
    const payDate      = payment_date || period.payment_date || new Date().toISOString().slice(0,10);

    await postJournalEntry(client, {
      companyId,
      description: `Salary payment disbursed — ${period.name}`,
      entryDate:   payDate,
      source:      "expense",
      sourceId:    periodId,
      sourceTable: "payroll_periods",
      createdBy:   paid_by,
      lines: [
        { coaId: salPayableId, dc: "debit",  amount: net, description: "Salaries payable cleared" },
        { coaId: bankCoaId,    dc: "credit", amount: net, description: "Bank payment to staff" },
      ],
    });

    await client.query(
      `UPDATE payroll_periods SET status='paid', paid_by=$1, paid_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [paid_by, periodId]
    );
    await client.query(
      `UPDATE payroll_entries SET status='paid' WHERE payroll_period_id=$1`,
      [periodId]
    );

    await client.query("COMMIT");
    return res.json({ status: "success", message: "Payroll marked as paid and accounting entry posted" });

  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};


// ============================================================
// ── PAYROLL ENTRIES & PAYSLIPS ───────────────────────────────
// ============================================================

export const getPayrollEntries = async (req, res) => {
  const { companyId, periodId } = req.params;
  try {
    const r = await pool.query(
      `SELECT pe.*,
              s.full_name, s.staff_id AS staff_id_number,
              s.role, s.department, s.job_title,
              COALESCE(
                json_agg(pea.*) FILTER (WHERE pea.id IS NOT NULL), '[]'
              ) AS allowances,
              COALESCE(
                json_agg(ped.*) FILTER (WHERE ped.id IS NOT NULL), '[]'
              ) AS deductions
       FROM payroll_entries pe
       JOIN staff s ON s.id = pe.staff_id
       LEFT JOIN payroll_entry_allowances pea ON pea.payroll_entry_id = pe.id
       LEFT JOIN payroll_entry_deductions ped ON ped.payroll_entry_id = pe.id
       WHERE pe.payroll_period_id = $1 AND pe.company_id = $2
       GROUP BY pe.id, s.id
       ORDER BY s.full_name`,
      [periodId, companyId]
    );
    return res.json({ status: "success", data: r.rows, count: r.rowCount });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const getPayslip = async (req, res) => {
  const { companyId, payslipId } = req.params;
  try {
    const r = await pool.query(
      `SELECT ps.*, c.company_name, c.address AS company_address, c.phone AS company_phone
       FROM payslips ps
       JOIN companies c ON c.id = ps.company_id
       WHERE ps.id = $1 AND ps.company_id = $2`,
      [payslipId, companyId]
    );
    if (!r.rows.length)
      return res.status(404).json({ status: "fail", message: "Payslip not found" });
    return res.json({ status: "success", data: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const getStaffPayslips = async (req, res) => {
  const { companyId, staffId } = req.params;
  try {
    const r = await pool.query(
      `SELECT ps.id, ps.payslip_number, ps.period_label, ps.period_start,
              ps.period_end, ps.payment_date, ps.gross_salary, ps.net_salary,
              ps.income_tax_paye, ps.ssnit_employee, ps.total_deductions,
              ps.generated_at
       FROM payslips ps
       WHERE ps.staff_id = $1 AND ps.company_id = $2
       ORDER BY ps.period_start DESC`,
      [staffId, companyId]
    );
    return res.json({ status: "success", data: r.rows });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

export const adjustPayrollEntry = async (req, res) => {
  const { companyId, entryId } = req.params;
  const { net_salary, notes, adjusted_by } = req.body;
  try {
    const r = await pool.query(
      `UPDATE payroll_entries SET
         net_salary           = COALESCE($1, net_salary),
         notes                = COALESCE($2, notes),
         is_manually_adjusted = true,
         status               = 'adjusted',
         adjusted_by          = $3,
         adjusted_at          = NOW()
       WHERE id = $4 AND company_id = $5 AND status IN ('computed','adjusted')
       RETURNING *`,
      [net_salary, notes, adjusted_by, entryId, companyId]
    );
    if (!r.rows.length)
      return res.status(404).json({ status: "fail", message: "Entry not found or already locked" });
    return res.json({ status: "success", data: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};

// Preview a single staff member's payroll (before running)
export const previewStaffPayroll = async (req, res) => {
  const { companyId, staffId } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const computed = await computeStaffPayroll(client, staffId, companyId);
    await client.query("ROLLBACK"); // read-only — rollback any implicit changes
    return res.json({ status: "success", data: computed });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(400).json({ status: "fail", message: e.message });
  } finally {
    client.release();
  }
};

// Payroll dashboard stats
export const getPayrollStats = async (req, res) => {
  const { companyId } = req.params;
  try {
    const [latestPeriod, ytdStats, staffCount] = await Promise.all([
      pool.query(
        `SELECT * FROM payroll_periods WHERE company_id=$1 ORDER BY period_start DESC LIMIT 1`,
        [companyId]
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(total_gross), 0) AS ytd_gross,
           COALESCE(SUM(total_net), 0)   AS ytd_net,
           COALESCE(SUM(total_tax), 0)   AS ytd_paye,
           COALESCE(SUM(total_ssnit_employee), 0) AS ytd_ssnit_emp,
           COALESCE(SUM(total_ssnit_employer), 0) AS ytd_ssnit_er,
           COUNT(*) AS total_payroll_runs
         FROM payroll_periods
         WHERE company_id = $1
           AND status IN ('paid','approved')
           AND EXTRACT(YEAR FROM period_start) = EXTRACT(YEAR FROM CURRENT_DATE)`,
        [companyId]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM staff
         WHERE company_id=$1 AND status='active' AND is_payroll_active=true`,
        [companyId]
      ),
    ]);

    return res.json({
      status: "success",
      data: {
        latestPeriod:    latestPeriod.rows[0] || null,
        ytd:             ytdStats.rows[0],
        activeStaff:     parseInt(staffCount.rows[0].count),
      },
    });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
};
