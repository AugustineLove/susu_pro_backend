// ============================================================
// cashVarianceController.mjs
//
// SHORTAGE: staff handed in LESS than system total
//   Dr  Cash Shortage Expense  (1070-01)   ← loss recorded
//   Cr  Mobile Banker Float    (1010-02)   ← float reduced by the missing amount
//
// EXCESS: staff handed in MORE than system total
//   Dr  Mobile Banker Float    (1010-02)   ← float increased by extra cash
//   Cr  Cash Over / Excess     (1070-02)   ← gain recorded
// ============================================================

import pool from "../db.mjs";
import { postJournalEntry, resolveCOA } from "../services/accountingHelper.mjs";
import { sendCustomerMessageBackend } from "./smsController.mjs";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function makeCompanyName(name) {
  return (name || "SuSu Pro").replace(/\s+/g, "");
}

async function getCompanyName(client, companyId) {
  const r = await client.query(
    "SELECT company_name FROM companies WHERE id = $1",
    [companyId]
  );
  return r.rows[0]?.company_name || "SuSu Pro";
}

// ─────────────────────────────────────────────────────────────
// GET SYSTEM TOTAL FOR A STAFF ON A DATE
// Sums all completed/approved deposits recorded by this staff
// on the given date.  This is the number the physical cash
// should match.
// ─────────────────────────────────────────────────────────────
export const getSystemTotal = async (req, res) => {
  const { companyId } = req.params;
  const { staff_id, date } = req.query;

  if (!staff_id || !date)
    return res.status(400).json({ status: "fail", message: "staff_id and date are required" });

  try {
    // Deposits collected (field staff_id column = the mobile banker who recorded it)
    const txRes = await pool.query(
      `SELECT
         COUNT(*)                           AS transaction_count,
         COALESCE(SUM(t.amount), 0)         AS system_total,
         COALESCE(SUM(CASE WHEN t.payment_method = 'momo' THEN t.amount ELSE 0 END), 0) AS momo_total,
         COALESCE(SUM(CASE WHEN t.payment_method != 'momo' OR t.payment_method IS NULL THEN t.amount ELSE 0 END), 0) AS cash_total,
         json_agg(json_build_object(
           'id',          t.id,
           'amount',      t.amount,
           'type',        t.type,
           'account_id',  t.account_id,
           'customer',    cu.name,
           'account_no',  a.account_number,
           'method',      t.payment_method,
           'time',        t.transaction_date
         ) ORDER BY t.transaction_date) AS transactions
       FROM transactions t
       JOIN accounts a  ON a.id  = t.account_id
       JOIN customers cu ON cu.id = a.customer_id
       WHERE t.company_id   = $1
         AND t.staff_id     = $2
         AND t.type         = 'deposit'
         AND t.status       IN ('approved','completed')
         AND t.is_deleted   = false
         AND t.transaction_date::date = $3::date`,
      [companyId, staff_id, date]
    );

    // Check if a variance record already exists for this day
    const existingRes = await pool.query(
      `SELECT * FROM cash_variances
       WHERE company_id = $1 AND staff_id = $2 AND variance_date = $3`,
      [companyId, staff_id, date]
    );

    // Fetch staff info
    const staffRes = await pool.query(
      `SELECT id, full_name, staff_id AS staff_number, role, phone, department
       FROM staff WHERE id = $1`,
      [staff_id]
    );

    const row = txRes.rows[0];
    return res.json({
      status: "success",
      data: {
        staff:             staffRes.rows[0] || null,
        date,
        system_total:      parseFloat(row.system_total),
        cash_total:        parseFloat(row.cash_total),
        momo_total:        parseFloat(row.momo_total),
        transaction_count: parseInt(row.transaction_count),
        transactions:      row.transactions || [],
        existing_variance: existingRes.rows[0] || null,
      },
    });
  } catch (err) {
    console.error("getSystemTotal error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// RECORD VARIANCE
// Manager submits the physical cash amount.
// System calculates the variance and posts a journal entry.
// ─────────────────────────────────────────────────────────────
export const recordVariance = async (req, res) => {
  const { companyId } = req.params;
  const {
    staff_id,
    variance_date,
    physical_cash,
    notes,
    recorded_by,
    transactions_count,
    attachment_url,
  } = req.body;

  if (!staff_id || !variance_date || physical_cash === undefined || physical_cash === null)
    return res.status(400).json({
      status:  "fail",
      message: "staff_id, variance_date and physical_cash are required",
    });

  if (!recorded_by)
    return res.status(400).json({ status: "fail", message: "recorded_by is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. Compute system total for the day ───────────────
    const sysRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS system_total, COUNT(*) AS tx_count
       FROM transactions
       WHERE company_id   = $1
         AND staff_id     = $2
         AND type         = 'deposit'
         AND status       IN ('approved','completed')
         AND is_deleted   = false
         AND transaction_date::date = $3::date`,
      [companyId, staff_id, variance_date]
    );

    const systemTotal  = parseFloat(sysRes.rows[0].system_total);
    const txCount      = parseInt(sysRes.rows[0].tx_count);
    const physicalAmt  = parseFloat(physical_cash);
    const varianceAmt  = systemTotal - physicalAmt; // positive = shortage

    const vType =
      varianceAmt >  0.005 ? "shortage" :
      varianceAmt < -0.005 ? "excess"   : "balanced";

    // ── 2. Check for existing record ──────────────────────
    const existingRes = await client.query(
      `SELECT id, status FROM cash_variances
       WHERE company_id = $1 AND staff_id = $2 AND variance_date = $3`,
      [companyId, staff_id, variance_date]
    );

    if (existingRes.rows.length > 0 && existingRes.rows[0].status === "resolved") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        status:  "fail",
        message: "A resolved variance record already exists for this staff on this date",
      });
    }

    // ── 3. Insert / update variance record ────────────────
    let varianceId;

    if (existingRes.rows.length > 0) {
      // Update existing open record
      const upd = await client.query(
        `UPDATE cash_variances SET
           physical_cash      = $1,
           system_total       = $2,
           notes              = COALESCE($3, notes),
           transactions_count = $4,
           attachment_url     = COALESCE($5, attachment_url),
           recorded_by        = $6,
           updated_at         = NOW()
         WHERE id = $7
         RETURNING id`,
        [physicalAmt, systemTotal, notes, txCount, attachment_url, recorded_by, existingRes.rows[0].id]
      );
      varianceId = upd.rows[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO cash_variances (
           company_id, staff_id, variance_date,
           system_total, physical_cash,
           notes, transactions_count, attachment_url,
           recorded_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [companyId, staff_id, variance_date, systemTotal, physicalAmt,
         notes || null, transactions_count || txCount, attachment_url || null,
         recorded_by]
      );
      varianceId = ins.rows[0].id;
    }

    // ── 4. Post journal entry if not balanced ─────────────
    let jeId = null;

    if (vType !== "balanced") {
      const floatCoaId = await resolveCOA(client, companyId, "1070");

      if (vType === "shortage") {
        // Dr Cash Shortage Expense  ← loss
        // Cr Mobile Banker Float    ← float reduced by missing amount
        const shortageCoaId = await resolveCOA(client, companyId, "5075");

        jeId = await postJournalEntry(client, {
          companyId,
          description: `Cash shortage — ${(await client.query(
            "SELECT full_name FROM staff WHERE id=$1",[staff_id]
          )).rows[0]?.full_name} — ${variance_date}`,
          entryDate:   variance_date,
          source:      "manual",
          sourceId:    varianceId,
          sourceTable: "cash_variances",
          createdBy:   recorded_by,
          lines: [
            {
              coaId:   shortageCoaId,
              dc:      "debit",
              amount:  Math.abs(varianceAmt),
              description: `Cash shortage by staff on ${variance_date}`,
              staffId: staff_id,
            },
            {
              coaId:   floatCoaId,
              dc:      "credit",
              amount:  Math.abs(varianceAmt),
              description: `Float reduced — cash not handed in`,
              staffId: staff_id,
            },
          ],
        });

      } else {
        // EXCESS
        // Dr Mobile Banker Float    ← float increased by extra cash
        // Cr Cash Over (Excess)     ← income/gain recorded
        const excessCoaId = await resolveCOA(client, companyId, "4050");

        jeId = await postJournalEntry(client, {
          companyId,
          description: `Cash excess — ${(await client.query(
            "SELECT full_name FROM staff WHERE id=$1",[staff_id]
          )).rows[0]?.full_name} — ${variance_date}`,
          entryDate:   variance_date,
          source:      "manual",
          sourceId:    varianceId,
          sourceTable: "cash_variances",
          createdBy:   recorded_by,
          lines: [
            {
              coaId:   floatCoaId,
              dc:      "debit",
              amount:  Math.abs(varianceAmt),
              description: `Extra cash handed in — cash increased`,
              staffId: staff_id,
            },
            {
              coaId:   excessCoaId,
              dc:      "credit",
              amount:  Math.abs(varianceAmt),
              description: `Cash over — gain recorded`,
              staffId: staff_id,
            },
          ],
        });
      }

      // Store JE reference on the variance record
      await client.query(
        `UPDATE cash_variances
         SET accounting_je_id = $1, je_posted_at = NOW()
         WHERE id = $2`,
        [jeId, varianceId]
      );
    }

    // ── 5. Mark balanced as resolved immediately ──────────
    if (vType === "balanced") {
      await client.query(
        `UPDATE cash_variances SET status = 'resolved', resolved_at = NOW(), resolved_by = $1
         WHERE id = $2`,
        [recorded_by, varianceId]
      );
    }

    // ── 6. Fetch final record ─────────────────────────────
    const finalRes = await client.query(
      `SELECT cv.*, s.full_name AS staff_name, s.phone AS staff_phone
       FROM cash_variances cv
       JOIN staff s ON s.id = cv.staff_id
       WHERE cv.id = $1`,
      [varianceId]
    );
    const variance = finalRes.rows[0];

    await client.query("COMMIT");

    // ── 7. Send SMS to staff (after commit) ───────────────
    // let smsSent = false;
    // if (variance.staff_phone && vType !== "balanced") {
    //   try {
    //     const companyName = await getCompanyName(pool, companyId);
    //     const direction   = vType === "shortage" ? "short" : "over";
    //     const message     =
    //       `Dear ${variance.staff_name}, your cash reconciliation for ` +
    //       `${variance_date} shows a ${direction} of GHS ${Math.abs(varianceAmt).toFixed(2)}. ` +
    //       `System total: GHS ${systemTotal.toFixed(2)}, ` +
    //       `Physical: GHS ${physicalAmt.toFixed(2)}. ` +
    //       `Please contact your manager. Ref: ${varianceId.slice(0, 8).toUpperCase()}`;

    //     await sendCustomerMessageBackend(
    //       variance.staff_phone,
    //       makeCompanyName(companyName),
    //       message
    //     );
    //     smsSent = true;
    //     await pool.query(
    //       `UPDATE cash_variances SET sms_sent=true, sms_sent_at=NOW() WHERE id=$1`,
    //       [varianceId]
    //     );
    //   } catch (smsErr) {
    //     console.warn("SMS failed:", smsErr.message);
    //   }
    // }

    return res.status(201).json({
      status:  "success",
      message: vType === "balanced"
        ? "Cash balanced — no variance recorded"
        : `${vType === "shortage" ? "Shortage" : "Excess"} of GHS ${Math.abs(varianceAmt).toFixed(2)} recorded and posted to accounting`,
      data: {
        ...variance,
        variance_amount: varianceAmt,
        variance_type:   vType,
        journal_entry_id: jeId,
        sms_sent:        smsSent,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("recordVariance error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};


// ─────────────────────────────────────────────────────────────
// GET ALL VARIANCES (company-wide, filterable)
// ─────────────────────────────────────────────────────────────
export const getVariances = async (req, res) => {
  const { companyId } = req.params;
  const {
    page = 1, limit = 30,
    staff_id, variance_type, status,
    startDate, endDate, search,
  } = req.query;

  const offset = (Number(page) - 1) * Number(limit);
  const conds  = ["cv.company_id = $1"];
  const vals   = [companyId];
  let   pi     = 2;

  if (staff_id)      { conds.push(`cv.staff_id = $${pi++}`);          vals.push(staff_id); }
  if (variance_type) { conds.push(`cv.variance_type = $${pi++}`);     vals.push(variance_type); }
  if (status)        { conds.push(`cv.status = $${pi++}`);            vals.push(status); }
  if (startDate)     { conds.push(`cv.variance_date >= $${pi++}`);    vals.push(startDate); }
  if (endDate)       { conds.push(`cv.variance_date <= $${pi++}`);    vals.push(endDate); }
  if (search)        { conds.push(`s.full_name ILIKE $${pi++}`);      vals.push(`%${search}%`); }

  const where = "WHERE " + conds.join(" AND ");

  try {
    const [data, count] = await Promise.all([
      pool.query(
        `SELECT
           cv.*,
           s.full_name        AS staff_name,
           s.staff_id         AS staff_number,
           s.role,
           s.department,
           s.phone            AS staff_phone,
           r.full_name        AS recorded_by_name
         FROM cash_variances cv
         JOIN staff s  ON s.id  = cv.staff_id
         JOIN staff r  ON r.id  = cv.recorded_by
         ${where}
         ORDER BY cv.variance_date DESC, cv.recorded_at DESC
         LIMIT $${pi} OFFSET $${pi+1}`,
        [...vals, Number(limit), offset]
      ),
      pool.query(
        `SELECT COUNT(*) AS total
         FROM cash_variances cv
         JOIN staff s ON s.id = cv.staff_id
         ${where}`,
        vals
      ),
    ]);

    return res.json({
      status:     "success",
      data:       data.rows,
      pagination: {
        total:      Number(count.rows[0].total),
        page:       Number(page),
        limit:      Number(limit),
        totalPages: Math.ceil(Number(count.rows[0].total) / Number(limit)),
      },
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// GET VARIANCE SUMMARY (per-staff breakdown)
// ─────────────────────────────────────────────────────────────
export const getVarianceSummary = async (req, res) => {
  const { companyId } = req.params;
  const { startDate, endDate } = req.query;

  const dateFilter = startDate && endDate
    ? `AND cv.variance_date BETWEEN '${startDate}' AND '${endDate}'`
    : startDate
    ? `AND cv.variance_date >= '${startDate}'`
    : "";

  try {
    const r = await pool.query(
      `SELECT
         s.id              AS staff_id,
         s.full_name,
         s.staff_id        AS staff_number,
         s.role,
         s.department,
         COUNT(cv.id)                                                    AS total_records,
         COUNT(cv.id) FILTER (WHERE cv.variance_type = 'shortage')      AS shortage_count,
         COUNT(cv.id) FILTER (WHERE cv.variance_type = 'excess')        AS excess_count,
         COUNT(cv.id) FILTER (WHERE cv.variance_type = 'balanced')      AS balanced_count,
         COALESCE(SUM(ABS(cv.variance_amount)) FILTER (WHERE cv.variance_type='shortage'), 0) AS total_shortage,
         COALESCE(SUM(ABS(cv.variance_amount)) FILTER (WHERE cv.variance_type='excess'),  0) AS total_excess,
         COALESCE(SUM(cv.variance_amount), 0)                           AS net_variance,
         COUNT(cv.id) FILTER (WHERE cv.status = 'open')                 AS open_count,
         MAX(cv.variance_date)                                          AS last_variance_date
       FROM staff s
       LEFT JOIN cash_variances cv ON cv.staff_id = s.id AND cv.company_id = $1
         ${dateFilter}
       WHERE s.company_id = $1
         AND s.status     = 'active'
       GROUP BY s.id
       HAVING COUNT(cv.id) > 0
       ORDER BY ABS(COALESCE(SUM(cv.variance_amount),0)) DESC`,
      [companyId]
    );

    // Company-wide totals
    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(ABS(variance_amount)) FILTER (WHERE variance_type='shortage'), 0) AS total_shortage,
         COALESCE(SUM(ABS(variance_amount)) FILTER (WHERE variance_type='excess'),   0) AS total_excess,
         COALESCE(SUM(variance_amount), 0)                                              AS net_variance,
         COUNT(*) FILTER (WHERE status = 'open')                                        AS open_count,
         COUNT(*)                                                                        AS total_count
       FROM cash_variances
       WHERE company_id = $1 ${dateFilter}`,
      [companyId]
    );

    return res.json({
      status: "success",
      data:   r.rows,
      totals: totals.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// GET SINGLE VARIANCE
// ─────────────────────────────────────────────────────────────
export const getVarianceById = async (req, res) => {
  const { companyId, varianceId } = req.params;
  try {
    const r = await pool.query(
      `SELECT cv.*,
              s.full_name AS staff_name, s.staff_id AS staff_number,
              s.role, s.department, s.phone AS staff_phone,
              r.full_name AS recorded_by_name,
              res.full_name AS resolved_by_name
       FROM cash_variances cv
       JOIN staff s   ON s.id = cv.staff_id
       JOIN staff r   ON r.id = cv.recorded_by
       LEFT JOIN staff res ON res.id = cv.resolved_by
       WHERE cv.id = $1 AND cv.company_id = $2`,
      [varianceId, companyId]
    );
    if (!r.rows.length)
      return res.status(404).json({ status: "fail", message: "Variance record not found" });
    return res.json({ status: "success", data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};


// ─────────────────────────────────────────────────────────────
// RESOLVE VARIANCE
// Manager marks a shortage/excess as resolved (investigated).
// Posts a reversal JE if needed (e.g. staff returns cash).
// ─────────────────────────────────────────────────────────────
export const resolveVariance = async (req, res) => {
  const { companyId, varianceId } = req.params;
  const { resolved_by, resolution_note, reverse_je } = req.body;

  if (!resolved_by)
    return res.status(400).json({ status: "fail", message: "resolved_by is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const vRes = await client.query(
      `SELECT * FROM cash_variances WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [varianceId, companyId]
    );
    if (!vRes.rows.length) throw new Error("Variance record not found");

    const v = vRes.rows[0];
    if (v.status === "resolved")
      throw new Error("Already resolved");

    // If manager wants to reverse the JE (e.g. cash was found/returned)
    if (reverse_je && v.accounting_je_id) {
      await client.query(
        `UPDATE journal_entries SET status = 'reversed', reversed_at = NOW()
         WHERE id = $1`,
        [v.accounting_je_id]
      );
    }

    await client.query(
      `UPDATE cash_variances SET
         status          = 'resolved',
         resolved_by     = $1,
         resolved_at     = NOW(),
         resolution_note = $2,
         updated_at      = NOW()
       WHERE id = $3`,
      [resolved_by, resolution_note || null, varianceId]
    );

    await client.query("COMMIT");
    return res.json({ status: "success", message: "Variance resolved" });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(400).json({ status: "fail", message: err.message });
  } finally {
    client.release();
  }
};
