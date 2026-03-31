import pool from '../db.mjs';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const calcFixed = (principal, annualRate, months) => {
  const totalInterest = principal * (annualRate / 100);
  const monthly = (principal + totalInterest) / months;
  const totalPayable = principal + totalInterest;
  return { monthly, totalInterest, totalPayable };
};

const calcReducing = (principal, annualRate, months) => {
  const mr = annualRate / 100 / 12;
  const monthly = principal * (mr * Math.pow(1 + mr, months)) / (Math.pow(1 + mr, months) - 1);
  const totalPayable = monthly * months;
  const totalInterest = totalPayable - principal;
  return { monthly, totalInterest, totalPayable };
};

const calcFlat = (principal, annualRate, months) => {
  const totalInterest = principal * (annualRate / 100) * (months / 12);
  const monthly = (principal + totalInterest) / months;
  const totalPayable = principal + totalInterest;
  return { monthly, totalInterest, totalPayable };
};

const calculateLoan = (principal, annualRate, months, method) => {
  switch (method) {
    case 'reducing': return calcReducing(principal, annualRate, months);
    case 'flat':     return calcFlat(principal, annualRate, months);
    default:         return calcFixed(principal, annualRate, months);
  }
};

const addMonths = (dateStr, months) => {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
};

const addMonthsFromNow = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
};


// ─────────────────────────────────────────────────────────────────────────────
// INDIVIDUAL LOAN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/loans/individual
 *
 * Body: {
 *   customer_id, loan_category, loan_amount, interest_rate, duration,
 *   interest_method, request_date, disbursement_date?, disbursed_amount?,
 *   purpose, collateral?, collateral_value?, guarantor_name, guarantor_phone,
 *   guarantor_relationship?, guarantor_address?, description?,
 *   company_id, created_by, created_by_type
 * }
 */
export const createIndividualLoan = async (req, res) => {
  const {
    customer_id,
    loan_category,
    loan_amount,
    interest_rate,
    duration,
    interest_method = 'fixed',
    request_date,
    disbursement_date,
    disbursed_amount,
    purpose,
    collateral,
    collateral_value,
    guarantor_name,
    guarantor_phone,
    guarantor_relationship,
    guarantor_address,
    description,
    company_id,
    created_by,
    created_by_type,
  } = req.body;

  // Required field check
  const missing = [];
  if (!customer_id)   missing.push('customer_id');
  if (!loan_amount)   missing.push('loan_amount');
  if (!interest_rate) missing.push('interest_rate');
  if (!duration)      missing.push('duration');
  if (!request_date)  missing.push('request_date');
  if (!purpose)       missing.push('purpose');
  if (!guarantor_name)  missing.push('guarantor_name');
  if (!guarantor_phone) missing.push('guarantor_phone');
  if (!company_id)    missing.push('company_id');
  if (!created_by)    missing.push('created_by');
  if (!created_by_type) missing.push('created_by_type');

  if (missing.length) {
    return res.status(400).json({
      status: 'fail',
      message: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  const principal = parseFloat(loan_amount);
  const rate      = parseFloat(interest_rate);
  const months    = parseInt(duration);

  if (isNaN(principal) || principal <= 0) return res.status(400).json({ status: 'fail', message: 'loan_amount must be a positive number' });
  if (isNaN(rate) || rate < 0)            return res.status(400).json({ status: 'fail', message: 'interest_rate must be a non-negative number' });
  if (isNaN(months) || months <= 0)       return res.status(400).json({ status: 'fail', message: 'duration must be a positive integer (months)' });

  // Auto-calculate
  const { monthly, totalPayable } = calculateLoan(principal, rate, months, interest_method);
  const maturity = addMonths(request_date, months);
  const nextPayment = addMonths(request_date, 1);
  const actualDisbursed = disbursed_amount ? parseFloat(disbursed_amount) : principal;

  // Collateral string – merge name + value if both provided
  const collateralStr = collateral
    ? (collateral_value ? `${collateral} (Value: ${collateral_value})` : collateral)
    : null;

  // Guarantor string – merge name + phone + relationship + address
  const guarantorStr = [
    guarantor_name,
    guarantor_phone,
    guarantor_relationship,
    guarantor_address,
  ].filter(Boolean).join(' | ');

  const id = uuidv4();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO loans (
        id, customer_id, loantype, loan_category, loanamount, disbursedamount,
        interestrateloan, loanterm, interestmethod,
        monthlypayment, totalpayable,
        amountpaid, outstandingbalance, balance,
        status, request_date, disbursementdate, maturitydate, nextpaymentdate,
        days_overdue, collateral, purpose,
        guarantor, guarantorphone, guarantor_relationship, guarantor_address,
        description,
        company_id, created_by, created_by_type
      ) VALUES (
        $1,$2,'individual',$3,$4,$5,
        $6,$7,$8,
        $9,$10,
        0,$11,$11,
        'pending',$12,$13,$14,$15,
        0,$16,$17,
        $18,$19,$20,$21,
        $22,
        $23,$24,$25
      ) RETURNING *`,
      [
        id, customer_id, loan_category, principal, actualDisbursed,
        rate, months, interest_method,
        parseFloat(monthly.toFixed(2)), parseFloat(totalPayable.toFixed(2)),
        parseFloat(totalPayable.toFixed(2)),
        request_date, disbursement_date || null, maturity, nextPayment,
        collateralStr, purpose,
        guarantorStr, guarantor_phone, guarantor_relationship || null, guarantor_address || null,
        description || null,
        company_id, created_by, created_by_type,
      ]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      status: 'success',
      message: 'Individual loan created successfully',
      data: result.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('createIndividualLoan error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GROUP LOAN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/loans/group
 *
 * Creates one parent group loan + one child loan per member.
 *
 * Body: {
 *   group_name,
 *   start_date,
 *   members: [{ customer_id, name, phone, loan_share }],
 *   guarantor_name?,   // optional for group
 *   guarantor_phone?,  // optional for group
 *   notes?,
 *   company_id, created_by, created_by_type
 * }
 *
 * Group rules:
 *   - Duration: fixed 6 months
 *   - Interest: fixed 20% on each member's share
 */
export const createGroupLoan = async (req, res) => {
  const {
    group_name,
    start_date,
    members,
    guarantor_name,
    guarantor_phone,
    notes,
    company_id,
    created_by,
    created_by_type,
  } = req.body;

  console.log(req.body);
  // Required fields
  const missing = [];
  if (!group_name)     missing.push('group_name');
  if (!start_date)     missing.push('start_date');
  if (!company_id)     missing.push('company_id');
  if (!created_by)     missing.push('created_by');
  if (!created_by_type) missing.push('created_by_type');

  if (missing.length) {
    return res.status(400).json({ status: 'fail', message: `Missing required fields: ${missing.join(', ')}` });
  }

  if (!Array.isArray(members) || members.length < 2) {
    return res.status(400).json({ status: 'fail', message: 'members must be an array with at least 2 entries' });
  }

  // Validate each member
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (!m.customer_id) return res.status(400).json({ status: 'fail', message: `members[${i}].customer_id is required` });
    if (!m.loan_share || parseFloat(m.loan_share) <= 0) return res.status(400).json({ status: 'fail', message: `members[${i}].loan_share must be a positive number` });
  }

  const GROUP_RATE     = 20;       // 20% fixed
  const GROUP_DURATION = 6;        // 6 months fixed
  const INTEREST_METHOD = 'fixed';

  const totalGroupAmount = members.reduce((sum, m) => sum + parseFloat(m.loan_share), 0);
  const { monthly: groupMonthly, totalPayable: groupTotalPayable } = calculateLoan(totalGroupAmount, GROUP_RATE, GROUP_DURATION, INTEREST_METHOD);
  const maturity   = addMonths(start_date, GROUP_DURATION);
  const nextPayment = addMonths(start_date, 1);

  const groupId = uuidv4();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert parent group loan record
    const groupResult = await client.query(
      `INSERT INTO loans (
        id, customer_id, loantype, group_name, loanamount, disbursedamount,
        interestrateloan, loanterm, interestmethod,
        monthlypayment, totalpayable,
        amountpaid, outstandingbalance, balance,
        status, request_date, maturitydate, nextpaymentdate,
        days_overdue, purpose,
        guarantor, guarantorphone,
        description,
        company_id, created_by, created_by_type
      ) VALUES (
        $1,$2,'group',$3,$4,$4,
        $5,$6,$7,
        $8,$9,
        0,$9,$9,
        'pending',$10,$11,$12,
        0,'Group loan',
        $13,$14,
        $15,
        $16,$17,$18
      ) RETURNING *`,
      [
        groupId,
        members[0].customer_id,   // primary customer = first member
        group_name,
        parseFloat(totalGroupAmount.toFixed(2)),
        GROUP_RATE, GROUP_DURATION, INTEREST_METHOD,
        parseFloat(groupMonthly.toFixed(2)),
        parseFloat(groupTotalPayable.toFixed(2)),
        start_date, maturity, nextPayment,
        guarantor_name || null, guarantor_phone || null,
        notes || null,
        company_id, created_by, created_by_type,
      ]
    );

    // 2. Insert one child loan per member
    const memberLoans = [];
    for (const member of members) {
      const share   = parseFloat(member.loan_share);
      const { monthly, totalPayable } = calculateLoan(share, GROUP_RATE, GROUP_DURATION, INTEREST_METHOD);
      const memberId = uuidv4();

      const memberResult = await client.query(
        `INSERT INTO loans (
          id, customer_id, loantype, group_id, group_name,
          loanamount, disbursedamount,
          interestrateloan, loanterm, interestmethod,
          monthlypayment, totalpayable,
          amountpaid, outstandingbalance, balance,
          status, request_date, maturitydate, nextpaymentdate,
          days_overdue, purpose,
          company_id, created_by, created_by_type
        ) VALUES (
          $1,$2,'group_member',$3,$4,
          $5,$5,
          $6,$7,$8,
          $9,$10,
          0,$10,$10,
          'pending',$11,$12,$13,
          0,'Group loan member share',
          $14,$15,$16
        ) RETURNING *`,
        [
          memberId,
          member.customer_id,
          groupId,
          group_name,
          parseFloat(share.toFixed(2)),
          GROUP_RATE, GROUP_DURATION, INTEREST_METHOD,
          parseFloat(monthly.toFixed(2)),
          parseFloat(totalPayable.toFixed(2)),
          start_date, maturity, nextPayment,
          company_id, created_by, created_by_type,
        ]
      );
      memberLoans.push(memberResult.rows[0]);
    }

    await client.query('COMMIT');
    return res.status(201).json({
      status: 'success',
      message: 'Group loan created successfully',
      data: {
        group_loan: groupResult.rows[0],
        member_loans: memberLoans,
        summary: {
          total_disbursed: parseFloat(totalGroupAmount.toFixed(2)),
          total_interest:  parseFloat((totalGroupAmount * GROUP_RATE / 100).toFixed(2)),
          total_repayment: parseFloat(groupTotalPayable.toFixed(2)),
          monthly_payment: parseFloat(groupMonthly.toFixed(2)),
          duration_months: GROUP_DURATION,
          interest_rate:   GROUP_RATE,
          maturity_date:   maturity,
        },
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('createGroupLoan error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    client.release();
  }
};


/**
 * GET /api/loans/group/:groupId/members
 * Returns the parent group loan + all member loans
 */
export const getGroupLoanWithMembers = async (req, res) => {
  const { groupId } = req.params;

  try {
    const groupResult = await pool.query(
      `SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.id = $1 AND l.loantype = 'group'`,
      [groupId]
    );

    if (!groupResult.rows.length) {
      return res.status(404).json({ status: 'fail', message: 'Group loan not found' });
    }

    const membersResult = await pool.query(
      `SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.group_id = $1 AND l.loantype = 'group_member'
       ORDER BY l.created_at ASC`,
      [groupId]
    );

    return res.status(200).json({
      status: 'success',
      data: {
        group_loan: groupResult.rows[0],
        members: membersResult.rows,
      },
    });
  } catch (error) {
    console.error('getGroupLoanWithMembers error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// P2P LOAN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/loans/p2p
 *
 * Body: {
 *   recipient_name, recipient_phone?, amount, date_sent,
 *   reason, relationship?,  notes?,
 *   company_id, created_by, created_by_type
 * }
 *
 * P2P rules:
 *   - No interest (rate = 0)
 *   - No fixed duration — open-ended
 *   - Status starts as 'active'
 *   - No guarantor required
 */
export const createP2PLoan = async (req, res) => {
  const {
    recipient_name,
    recipient_phone,
    amount,
    date_sent,
    reason,
    relationship,
    notes,
    company_id,
    created_by,
    created_by_type,
    // customer_id is optional for P2P — they may not be a registered customer
    customer_id,
  } = req.body;
  console.log(req.body);

  const missing = [];
  if (!recipient_name) missing.push('recipient_name');
  if (!amount)         missing.push('amount');
  if (!date_sent)      missing.push('date_sent');
  if (!reason)         missing.push('reason');
  if (!company_id)     missing.push('company_id');
  if (!created_by)     missing.push('created_by');
  if (!created_by_type) missing.push('created_by_type');

  if (missing.length) {
    return res.status(400).json({ status: 'fail', message: `Missing required fields: ${missing.join(', ')}` });
  }

  const principal = parseFloat(amount);
  if (isNaN(principal) || principal <= 0) {
    return res.status(400).json({ status: 'fail', message: 'amount must be a positive number' });
  }

  const id = uuidv4();
  // For P2P without a registered customer, use created_by as the customer reference
  const effectiveCustomerId = customer_id || created_by;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO loans (
        id, customer_id, loantype, recipient_name, recipient_phone,
        loanamount, disbursedamount,
        interestrateloan, loanterm, interestmethod,
        monthlypayment, totalpayable,
        amountpaid, outstandingbalance, balance,
        status, request_date, disbursementdate,
        days_overdue, purpose, relationship, description,
        company_id, created_by, created_by_type
      ) VALUES (
        $1,$2,'p2p',$3,$4,
        $5,$5,
        0,NULL,'none',
        0,$5,
        0,$5,$5,
        'active',$6,$6,
        0,$7,$8,$9,
        $10,$11,$12
      ) RETURNING *`,
      [
        id, effectiveCustomerId, recipient_name, recipient_phone || null,
        parseFloat(principal.toFixed(2)),
        date_sent,
        reason, relationship || null, notes || null,
        company_id, created_by, created_by_type,
      ]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      status: 'success',
      message: 'P2P loan entry created successfully',
      data: result.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('createP2PLoan error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    client.release();
  }
};


/**
 * PATCH /api/loans/p2p/:id/status
 *
 * Body: { status: 'active' | 'inactive' | 'ended' }
 */
export const updateP2PStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowed = ['active', 'inactive', 'ended'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ status: 'fail', message: `status must be one of: ${allowed.join(', ')}` });
  }

  try {
    const result = await pool.query(
      `UPDATE loans SET status = $1, updated_at = NOW()
       WHERE id = $2 AND loantype = 'p2p'
       RETURNING *`,
      [status, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ status: 'fail', message: 'P2P entry not found' });
    }

    return res.status(200).json({
      status: 'success',
      message: `P2P entry status updated to '${status}'`,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('updateP2PStatus error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// LOAN REPAYMENT  (works for all 3 types)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/loans/:id/repayment
 *
 * Body: { amount_paid, payment_date?, note?, company_id, created_by }
 *
 * - Deducts from outstanding_balance and balance
 * - Adds to amount_paid
 * - Logs repayment in loan_repayments table
 * - Auto-sets status to 'completed' if balance reaches 0
 * - For P2P: sets status to 'ended' when fully repaid
 */
export const logRepayment = async (req, res) => {
  const { id } = req.params;
  const { amount_paid, payment_date, note, company_id, created_by } = req.body;

  if (!amount_paid || parseFloat(amount_paid) <= 0) {
    return res.status(400).json({ status: 'fail', message: 'amount_paid must be a positive number' });
  }
  if (!company_id) return res.status(400).json({ status: 'fail', message: 'company_id is required' });
  if (!created_by) return res.status(400).json({ status: 'fail', message: 'created_by is required' });

  const payment = parseFloat(amount_paid);
  const payDate = payment_date || new Date().toISOString().split('T')[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the loan row
    const loanRes = await client.query(
      `SELECT id, loantype, outstandingbalance, balance, amountpaid, status, loanamount, totalpayable
       FROM loans WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (!loanRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'fail', message: 'Loan not found' });
    }

    const loan = loanRes.rows[0];

    if (['completed', 'ended'].includes(loan.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ status: 'fail', message: 'Loan is already fully repaid' });
    }

    const currentBalance = parseFloat(loan.outstandingbalance);
    const actualPayment  = Math.min(payment, currentBalance); // can't overpay
    const newBalance     = parseFloat((currentBalance - actualPayment).toFixed(2));
    const newAmountPaid  = parseFloat((parseFloat(loan.amountpaid) + actualPayment).toFixed(2));

    // Determine new status
    let newStatus = loan.status;
    if (newBalance <= 0) {
      newStatus = loan.loantype === 'p2p' ? 'ended' : 'completed';
    }

    // Update next_payment_date (only for active regular loans)
    const nextPaymentDate = newBalance > 0 ? addMonthsFromNow(1) : null;

    // Update the loan
    await client.query(
      `UPDATE loans SET
        amountpaid = $1,
        outstandingbalance = $2,
        balance = $2,
        status = $3,
        nextpaymentdate = $4,
        updated_at = NOW()
       WHERE id = $5`,
      [newAmountPaid, newBalance, newStatus, nextPaymentDate, id]
    );

    // Log in repayments table
    const repaymentId = uuidv4();
    await client.query(
      `INSERT INTO loan_repayments (
        id, loan_id, amount, payment_date, note,
        balance_after, company_id, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [repaymentId, id, parseFloat(actualPayment.toFixed(2)), payDate, note || null, newBalance, company_id, created_by]
    );

    // If group member loan — update parent group loan totals
    if (loan.loantype === 'group_member') {
      await client.query(
        `UPDATE loans SET
          amountpaid = (
            SELECT COALESCE(SUM(amountpaid), 0)
            FROM loans
            WHERE group_id = (SELECT group_id FROM loans WHERE id = $1) AND loantype = 'group_member'
          ),
          outstandingbalance = (
            SELECT COALESCE(SUM(outstandingbalance), 0)
            FROM loans
            WHERE group_id = (SELECT group_id FROM loans WHERE id = $1) AND loantype = 'group_member'
          ),
          balance = (
            SELECT COALESCE(SUM(balance), 0)
            FROM loans
            WHERE group_id = (SELECT group_id FROM loans WHERE id = $1) AND loantype = 'group_member'
          ),
          updated_at = NOW()
        WHERE id = (SELECT group_id FROM loans WHERE id = $1) AND loantype = 'group'`,
        [id]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({
      status: 'success',
      message: 'Repayment logged successfully',
      data: {
        loan_id: id,
        amount_paid: parseFloat(actualPayment.toFixed(2)),
        new_balance: newBalance,
        total_paid: newAmountPaid,
        new_status: newStatus,
        payment_date: payDate,
        repayment_id: repaymentId,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('logRepayment error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET LOANS  (filtered by type)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/loans?company_id=&type=&status=&page=&limit=
 * type: 'individual' | 'group' | 'group_member' | 'p2p'
 */
export const getLoans = async (req, res) => {
  try {
    const {
      company_id,
      type,
      status,
      page = 1,
      limit = 20,
    } = req.query;

    // ─────────────────────────────────────────────
    // VALIDATION
    // ─────────────────────────────────────────────
    if (!company_id) {
      return res.status(400).json({
        status: "fail",
        message: "company_id is required",
      });
    }

    const pageNum = Math.max(parseInt(page), 1);
    const limitNum = Math.max(parseInt(limit), 1);
    const offset = (pageNum - 1) * limitNum;

    // ─────────────────────────────────────────────
    // BUILD QUERY CONDITIONS
    // ─────────────────────────────────────────────
    let conditions;
    let values;
    let idx = 1;

    // Always filter by company
    conditions.push(`l.company_id = $${idx++}`);
    values.push(company_id);

    // Exclude internal group member records
    conditions.push(`l.loantype != 'group_member'`);

    // Optional filters
    if (type) {
      conditions.push(`l.loantype = $${idx++}`);
      values.push(type);
    }

    if (status) {
      conditions.push(`l.status = $${idx++}`);
      values.push(status);
    }

    const whereClause = conditions.join(" AND ");

    // ─────────────────────────────────────────────
    // MAIN QUERY
    // ─────────────────────────────────────────────
    const dataQuery = `
      SELECT 
        l.*,
        c.name AS customer_name,
        c.phone_number AS customer_phone,
        c.email AS customer_email,

        -- Optional: count members if group loan
        (
          SELECT COUNT(*) 
          FROM loans m 
          WHERE m.group_id = l.id
        ) AS member_count

      FROM loans l
      LEFT JOIN customers c ON l.customer_id = c.id
      WHERE ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const countQuery = `
      SELECT COUNT(*) 
      FROM loans l
      WHERE ${whereClause}
    `;

    const [dataRes, countRes] = await Promise.all([
      pool.query(dataQuery, [...values, limitNum, offset]),
      pool.query(countQuery, values),
    ]);

    const total = parseInt(countRes.rows[0].count, 10);

    // ─────────────────────────────────────────────
    // RESPONSE
    // ─────────────────────────────────────────────
    return res.status(200).json({
      status: "success",
      data: dataRes.rows,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("getLoans error:", error.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};


/**
 * GET /api/loans/:id
 * Returns a single loan. If group, includes member loans.
 */
export const getLoanById = async (req, res) => {
  const { id } = req.params;

  try {
    const loanRes = await pool.query(
      `SELECT l.*,
        c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.id = $1`,
      [id]
    );

    if (!loanRes.rows.length) {
      return res.status(404).json({ status: 'fail', message: 'Loan not found' });
    }

    const loan = loanRes.rows[0];
    let members = [];
    let repayments = [];

    // If it's a parent group loan, fetch members
    if (loan.loantype === 'group') {
      const membersRes = await pool.query(
        `SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
         FROM loans l
         LEFT JOIN customers c ON l.customer_id = c.id
         WHERE l.group_id = $1 AND l.loantype = 'group_member'
         ORDER BY l.created_at ASC`,
        [id]
      );
      members = membersRes.rows;
    }

    // Repayment history for all loan types
    const repayRes = await pool.query(
      `SELECT * FROM loan_repayments WHERE loan_id = $1 ORDER BY payment_date DESC`,
      [id]
    );
    repayments = repayRes.rows;

    return res.status(200).json({
      status: 'success',
      data: { ...loan, members, repayments },
    });
  } catch (error) {
    console.error('getLoanById error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};


/**
 * GET /api/loans/customer/:customerId
 * All loans belonging to a customer across all types
 */
export const getCustomerLoans = async (req, res) => {
  const { customerId } = req.params;
  const { company_id } = req.query;

  if (!company_id) return res.status(400).json({ status: 'fail', message: 'company_id is required' });

  try {
    const result = await pool.query(
      `SELECT * FROM loans
       WHERE customer_id = $1 AND company_id = $2
       ORDER BY created_at DESC`,
      [customerId, company_id]
    );

    return res.status(200).json({ status: 'success', data: result.rows });
  } catch (error) {
    console.error('getCustomerLoans error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// LOAN APPROVAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/loans/:id/approve
 * Body: { approved_by, approved_by_type, disbursement_date? }
 */
export const approveLoan = async (req, res) => {
  const { id } = req.params;
  const { approved_by, approved_by_type, disbursement_date } = req.body;

  if (!approved_by || !approved_by_type) {
    return res.status(400).json({ status: 'fail', message: 'approved_by and approved_by_type are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loanRes = await client.query(
      `SELECT id, loantype, status, loanterm, request_date FROM loans WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (!loanRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'fail', message: 'Loan not found' });
    }

    const loan = loanRes.rows[0];

    if (loan.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ status: 'fail', message: `Loan is already '${loan.status}' and cannot be approved` });
    }

    const disbDate = disbursement_date || new Date().toISOString().split('T')[0];

    const result = await client.query(
      `UPDATE loans SET
        status = 'active',
        disbursementdate = $1,
        approved_by = $2,
        approved_by_type = $3,
        approved_at = NOW(),
        updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [disbDate, approved_by, approved_by_type, id]
    );

    // If parent group loan, approve all member loans too
    if (loan.loantype === 'group') {
      await client.query(
        `UPDATE loans SET
          status = 'active',
          disbursementdate = $1,
          approved_by = $2,
          approved_by_type = $3,
          approved_at = NOW(),
          updated_at = NOW()
         WHERE group_id = $4 AND loantype = 'group_member'`,
        [disbDate, approved_by, approved_by_type, id]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({
      status: 'success',
      message: 'Loan approved successfully',
      data: result.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('approveLoan error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    client.release();
  }
};


/**
 * PATCH /api/loans/:id/reject
 * Body: { rejected_by, rejected_by_type, rejection_reason }
 */
export const rejectLoan = async (req, res) => {
  const { id } = req.params;
  const { rejected_by, rejected_by_type, rejection_reason } = req.body;

  if (!rejected_by || !rejected_by_type) {
    return res.status(400).json({ status: 'fail', message: 'rejected_by and rejected_by_type are required' });
  }

  try {
    const result = await pool.query(
      `UPDATE loans SET
        status = 'rejected',
        description = COALESCE(description || ' | Rejection: ' || $1, 'Rejection: ' || $1),
        updated_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [rejection_reason || 'No reason provided', id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ status: 'fail', message: 'Loan not found or not in pending status' });
    }

    return res.status(200).json({ status: 'success', message: 'Loan rejected', data: result.rows[0] });
  } catch (error) {
    console.error('rejectLoan error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// REPAYMENT HISTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/loans/:id/repayments
 */
export const getLoanRepayments = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM loan_repayments WHERE loan_id = $1 ORDER BY payment_date DESC`,
      [id]
    );
    return res.status(200).json({ status: 'success', data: result.rows });
  } catch (error) {
    console.error('getLoanRepayments error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};
