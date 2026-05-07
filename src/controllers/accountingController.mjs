import pool from "../db.mjs";

// ─────────────────────────────────────────────────────────────
// CHART OF ACCOUNTS
// ─────────────────────────────────────────────────────────────

export const getChartOfAccounts = async (req, res) => {
  const { companyId } = req.params;
  try {
    const result = await pool.query(
      `SELECT
        coa.*,
        p.name AS parent_name,
        p.code AS parent_code,
        -- current balance from posted entries
        COALESCE((
          SELECT
            CASE coa.normal_balance
              WHEN 'debit'  THEN SUM(jel.amount) FILTER (WHERE jel.debit_credit='debit')
                             - SUM(jel.amount) FILTER (WHERE jel.debit_credit='credit')
              WHEN 'credit' THEN SUM(jel.amount) FILTER (WHERE jel.debit_credit='credit')
                             - SUM(jel.amount) FILTER (WHERE jel.debit_credit='debit')
            END
          FROM journal_entry_lines jel
          JOIN journal_entries je ON je.id = jel.journal_entry_id
          WHERE jel.coa_id = coa.id AND je.status = 'posted'
        ), 0) AS current_balance
      FROM chart_of_accounts coa
      LEFT JOIN chart_of_accounts p ON p.id = coa.parent_id
      WHERE coa.company_id = $1
        AND coa.is_deleted  = false
      ORDER BY coa.code`,
      [companyId]
    );
    return res.json({ status: "success", data: result.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: err.message });
  }
};

export const getAccountById = async (req, res) => {
  const { companyId, accountId } = req.params;
  try {
    const result = await pool.query(
      `SELECT coa.*,
        p.name AS parent_name,
        COALESCE((
          SELECT
            CASE coa.normal_balance
              WHEN 'debit'  THEN SUM(jel.amount) FILTER (WHERE jel.debit_credit='debit')
                             - SUM(jel.amount) FILTER (WHERE jel.debit_credit='credit')
              WHEN 'credit' THEN SUM(jel.amount) FILTER (WHERE jel.debit_credit='credit')
                             - SUM(jel.amount) FILTER (WHERE jel.debit_credit='debit')
            END
          FROM journal_entry_lines jel
          JOIN journal_entries je ON je.id = jel.journal_entry_id
          WHERE jel.coa_id = coa.id AND je.status = 'posted'
        ), 0) AS current_balance
      FROM chart_of_accounts coa
      LEFT JOIN chart_of_accounts p ON p.id = coa.parent_id
      WHERE coa.id = $1 AND coa.company_id = $2 AND coa.is_deleted = false`,
      [accountId, companyId]
    );
    if (!result.rows[0])
      return res.status(404).json({ status: "fail", message: "Account not found" });
    return res.json({ status: "success", data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

export const createAccount = async (req, res) => {
  const { companyId } = req.params;
  const {
    code, name, description,
    account_type, category,
    parent_id, opening_balance, opening_date,
    created_by
  } = req.body;

  if (!code || !name || !account_type || !category || !created_by)
    return res.status(400).json({ status: "fail", message: "code, name, account_type, category and created_by are required" });

  // normal_balance derived from type
  const normalBalance = ["asset", "expense"].includes(account_type) ? "debit" : "credit";
  const isSubAccount  = !!parent_id;

  try {
    const result = await pool.query(
      `INSERT INTO chart_of_accounts
        (company_id, code, name, description, account_type, category, normal_balance,
         parent_id, is_sub_account, opening_balance, opening_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [companyId, code, name, description || null, account_type, category,
       normalBalance, parent_id || null, isSubAccount,
       opening_balance || 0, opening_date || null, created_by]
    );
    return res.status(201).json({ status: "success", data: result.rows[0] });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ status: "fail", message: `Account code ${code} already exists for this company` });
    return res.status(500).json({ status: "error", message: err.message });
  }
};

export const updateAccount = async (req, res) => {
  const { companyId, accountId } = req.params;
  const { name, description, is_active } = req.body;

  try {
    const result = await pool.query(
      `UPDATE chart_of_accounts
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           is_active = COALESCE($3, is_active),
           updated_at = NOW()
       WHERE id = $4 AND company_id = $5 AND is_system_account = false
       RETURNING *`,
      [name, description, is_active, accountId, companyId]
    );
    if (!result.rows[0])
      return res.status(404).json({ status: "fail", message: "Account not found or is a system account" });
    return res.json({ status: "success", data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

export const deleteAccount = async (req, res) => {
  const { companyId, accountId } = req.params;
  try {
    // check if it has any journal lines
    const used = await pool.query(
      `SELECT 1 FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.coa_id = $1 AND je.status = 'posted' LIMIT 1`,
      [accountId]
    );
    if (used.rowCount > 0)
      return res.status(409).json({ status: "fail", message: "Cannot delete — this account has posted transactions" });

    await pool.query(
      `UPDATE chart_of_accounts SET is_deleted = true, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND is_system_account = false`,
      [accountId, companyId]
    );
    return res.json({ status: "success", message: "Account deleted" });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// JOURNAL ENTRIES
// ─────────────────────────────────────────────────────────────

export const getJournalEntries = async (req, res) => {
  const { companyId } = req.params;
  const {
    page = 1, limit = 20,
    status, source, startDate, endDate, search
  } = req.query;

  const offset     = (Number(page) - 1) * Number(limit);
  const conditions = ["je.company_id = $1"];
  const values     = [companyId];
  let   pi         = 2;

  if (status)    { conditions.push(`je.status = $${pi++}`);     values.push(status); }
  if (source)    { conditions.push(`je.source = $${pi++}`);     values.push(source); }
  if (search)    { conditions.push(`(je.reference_no ILIKE $${pi} OR je.description ILIKE $${pi})`); values.push(`%${search}%`); pi++; }
  if (startDate) { conditions.push(`je.entry_date >= $${pi++}`); values.push(startDate); }
  if (endDate)   { conditions.push(`je.entry_date <= $${pi++}`); values.push(endDate); }

  const where = "WHERE " + conditions.join(" AND ");

  try {
    const [data, count] = await Promise.all([
      pool.query(
        `SELECT
          je.*,
          -- aggregate lines as JSON
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id',           jel.id,
              'coa_id',       jel.coa_id,
              'account_code', coa.code,
              'account_name', coa.name,
              'account_type', coa.account_type,
              'debit_credit', jel.debit_credit,
              'amount',       jel.amount,
              'description',  jel.description,
              'customer_id',  jel.customer_id,
              'account_id',   jel.account_id
            ) ORDER BY jel.debit_credit DESC, jel.id
          ) AS lines,
          SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit')  AS total_debits,
          SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit') AS total_credits
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN chart_of_accounts  coa  ON coa.id = jel.coa_id
        ${where}
        GROUP BY je.id
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT $${pi} OFFSET $${pi+1}`,
        [...values, Number(limit), offset]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT je.id) AS total
         FROM journal_entries je ${where}`,
        values
      )
    ]);

    return res.json({
      status: "success",
      data:   data.rows,
      pagination: {
        total:      Number(count.rows[0].total),
        page:       Number(page),
        limit:      Number(limit),
        totalPages: Math.ceil(Number(count.rows[0].total) / Number(limit))
      }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

export const createManualJournalEntry = async (req, res) => {
  const { companyId } = req.params;
  const { description, entry_date, memo, lines, created_by } = req.body;
  // lines: [{ coa_id, debit_credit, amount, description, customer_id, account_id }]

  if (!lines || lines.length < 2)
    return res.status(400).json({ status: "fail", message: "A journal entry needs at least 2 lines" });

  const totalDebits  = lines.filter(l => l.debit_credit === "debit") .reduce((s, l) => s + Number(l.amount), 0);
  const totalCredits = lines.filter(l => l.debit_credit === "credit").reduce((s, l) => s + Number(l.amount), 0);

  if (Math.abs(totalDebits - totalCredits) > 0.01)
    return res.status(400).json({
      status: "fail",
      message: `Entry is unbalanced — debits ${totalDebits} ≠ credits ${totalCredits}`
    });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const refRes = await client.query("SELECT generate_journal_ref($1) AS ref", [companyId]);
    const ref    = refRes.rows[0].ref;

    const jeRes = await client.query(
      `INSERT INTO journal_entries
        (company_id, reference_no, description, memo, entry_date, source, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'manual','draft',$6)
       RETURNING *`,
      [companyId, ref, description, memo || null, entry_date || new Date(), created_by]
    );
    const jeId = jeRes.rows[0].id;

    for (const line of lines) {
      await client.query(
        `INSERT INTO journal_entry_lines
          (journal_entry_id, coa_id, debit_credit, amount, description, customer_id, account_id, staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [jeId, line.coa_id, line.debit_credit, Number(line.amount),
         line.description || null, line.customer_id || null,
         line.account_id  || null, line.staff_id   || null]
      );
    }

    // Post immediately
    await client.query(
      `UPDATE journal_entries SET status='posted', posted_by=$1, posted_at=NOW() WHERE id=$2`,
      [created_by, jeId]
    );

    await client.query("COMMIT");

    const final = await pool.query(
      `SELECT je.*,
        JSON_AGG(JSON_BUILD_OBJECT(
          'account_code', coa.code, 'account_name', coa.name,
          'debit_credit', jel.debit_credit, 'amount', jel.amount
        )) AS lines
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       JOIN chart_of_accounts  coa  ON coa.id = jel.coa_id
       WHERE je.id = $1 GROUP BY je.id`,
      [jeId]
    );

    return res.status(201).json({ status: "success", data: final.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// GENERAL LEDGER
// ─────────────────────────────────────────────────────────────

export const getGeneralLedger = async (req, res) => {
  const { companyId } = req.params;
  const { coa_id, startDate, endDate, page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const conditions = ["je.company_id = $1", "je.status = 'posted'"];
  const values     = [companyId];
  let   pi         = 2;

  if (coa_id)    { conditions.push(`jel.coa_id = $${pi++}`);      values.push(coa_id); }
  if (startDate) { conditions.push(`je.entry_date >= $${pi++}`);  values.push(startDate); }
  if (endDate)   { conditions.push(`je.entry_date <= $${pi++}`);  values.push(endDate); }

  const where = "WHERE " + conditions.join(" AND ");

  try {
    const [data, count] = await Promise.all([
      pool.query(
        `SELECT
          jel.id            AS line_id,
          je.entry_date,
          je.reference_no,
          je.description    AS entry_description,
          jel.description   AS line_description,
          je.source,
          coa.id            AS coa_id,
          coa.code          AS account_code,
          coa.name          AS account_name,
          coa.account_type,
          coa.normal_balance,
          jel.debit_credit,
          jel.amount,
          -- running balance
          SUM(
            CASE
              WHEN coa.normal_balance = 'debit'  AND jel.debit_credit = 'debit'  THEN  jel.amount
              WHEN coa.normal_balance = 'debit'  AND jel.debit_credit = 'credit' THEN -jel.amount
              WHEN coa.normal_balance = 'credit' AND jel.debit_credit = 'credit' THEN  jel.amount
              WHEN coa.normal_balance = 'credit' AND jel.debit_credit = 'debit'  THEN -jel.amount
            END
          ) OVER (PARTITION BY jel.coa_id ORDER BY je.entry_date, jel.id) AS running_balance,
          jel.customer_id,
          jel.account_id,
          cu.name           AS customer_name
        FROM journal_entry_lines jel
        JOIN journal_entries   je  ON je.id  = jel.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jel.coa_id
        LEFT JOIN customers    cu  ON cu.id  = jel.customer_id
        ${where}
        ORDER BY je.entry_date DESC, jel.id DESC
        LIMIT $${pi} OFFSET $${pi+1}`,
        [...values, Number(limit), offset]
      ),
      pool.query(
        `SELECT COUNT(*) AS total
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         ${where}`,
        values
      )
    ]);

    return res.json({
      status: "success",
      data:   data.rows,
      pagination: {
        total:      Number(count.rows[0].total),
        page:       Number(page),
        limit:      Number(limit),
        totalPages: Math.ceil(Number(count.rows[0].total) / Number(limit))
      }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// TRIAL BALANCE
// ─────────────────────────────────────────────────────────────

export const getTrialBalance = async (req, res) => {
  const { companyId } = req.params;
  const { startDate, endDate } = req.query;

  const dateFilter = startDate && endDate
    ? `AND je.entry_date BETWEEN '${startDate}' AND '${endDate}'`
    : "";

  try {
    const result = await pool.query(
      `SELECT
        coa.id            AS coa_id,
        coa.code          AS account_code,
        coa.name          AS account_name,
        coa.account_type,
        coa.category,
        coa.normal_balance,
        coa.is_sub_account,
        coa.parent_id,
        COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0) AS total_debits,
        COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0) AS total_credits,
        CASE coa.normal_balance
          WHEN 'debit'  THEN
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0) -
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0)
          WHEN 'credit' THEN
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0) -
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0)
        END AS net_balance
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_lines jel ON jel.coa_id = coa.id
      LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
        AND je.status = 'posted'
        AND je.company_id = $1
        ${dateFilter}
      WHERE coa.company_id = $1
        AND coa.is_active   = true
        AND coa.is_deleted  = false
      GROUP BY coa.id
      ORDER BY coa.code`,
      [companyId]
    );

    const rows = result.rows;

    // Summary totals
    const summary = {
      total_debits:  rows.reduce((s, r) => s + Number(r.total_debits),  0),
      total_credits: rows.reduce((s, r) => s + Number(r.total_credits), 0),
      is_balanced:   Math.abs(
        rows.reduce((s, r) => s + Number(r.total_debits), 0) -
        rows.reduce((s, r) => s + Number(r.total_credits), 0)
      ) < 0.01
    };

    return res.json({ status: "success", data: rows, summary });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// PROFIT & LOSS
// ─────────────────────────────────────────────────────────────

export const getProfitAndLoss = async (req, res) => {
  const { companyId } = req.params;
  const { startDate, endDate } = req.query;

  const dateFilter = startDate && endDate
    ? `AND je.entry_date BETWEEN '${startDate}' AND '${endDate}'`
    : "";

  try {
    const result = await pool.query(
      `SELECT
        coa.code, coa.name, coa.account_type, coa.category,
        coa.is_sub_account, coa.parent_id,
        CASE coa.normal_balance
          WHEN 'credit' THEN
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0) -
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0)
          WHEN 'debit' THEN
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0) -
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0)
        END AS amount
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_lines jel ON jel.coa_id = coa.id
      LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
        AND je.status = 'posted'
        AND je.company_id = $1
        ${dateFilter}
      WHERE coa.company_id  = $1
        AND coa.account_type IN ('income', 'expense')
        AND coa.is_active    = true
        AND coa.is_deleted   = false
      GROUP BY coa.id
      ORDER BY coa.account_type DESC, coa.code`,
      [companyId]
    );

    const income   = result.rows.filter(r => r.account_type === "income");
    const expenses = result.rows.filter(r => r.account_type === "expense");

    const totalIncome   = income.reduce((s, r)   => s + Number(r.amount), 0);
    const totalExpenses = expenses.reduce((s, r) => s + Number(r.amount), 0);
    const netProfit     = totalIncome - totalExpenses;

    return res.json({
      status: "success",
      data: { income, expenses },
      summary: { totalIncome, totalExpenses, netProfit }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// BALANCE SHEET
// ─────────────────────────────────────────────────────────────

export const getBalanceSheet = async (req, res) => {
  const { companyId } = req.params;
  const { asOf } = req.query; // optional date

  const dateFilter = asOf ? `AND je.entry_date <= '${asOf}'` : "";

  try {
    const result = await pool.query(
      `SELECT
        coa.code, coa.name, coa.account_type, coa.category,
        coa.is_sub_account, coa.parent_id,
        CASE coa.normal_balance
          WHEN 'debit'  THEN
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0) -
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0)
          WHEN 'credit' THEN
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'credit'), 0) -
            COALESCE(SUM(jel.amount) FILTER (WHERE jel.debit_credit = 'debit'),  0)
        END AS amount
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_lines jel ON jel.coa_id = coa.id
      LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
        AND je.status = 'posted'
        AND je.company_id = $1
        ${dateFilter}
      WHERE coa.company_id  = $1
        AND coa.account_type IN ('asset', 'liability', 'equity')
        AND coa.is_active    = true
        AND coa.is_deleted   = false
      GROUP BY coa.id
      ORDER BY
        CASE coa.account_type WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 ELSE 3 END,
        coa.code`,
      [companyId]
    );

    const assets      = result.rows.filter(r => r.account_type === "asset");
    const liabilities = result.rows.filter(r => r.account_type === "liability");
    const equity      = result.rows.filter(r => r.account_type === "equity");

    const totalAssets      = assets.reduce((s, r)      => s + Number(r.amount), 0);
    const totalLiabilities = liabilities.reduce((s, r) => s + Number(r.amount), 0);
    const totalEquity      = equity.reduce((s, r)      => s + Number(r.amount), 0);

    return res.json({
      status: "success",
      data:   { assets, liabilities, equity },
      summary: {
        totalAssets,
        totalLiabilities,
        totalEquity,
        isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
      }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// ACCOUNTING PERIODS
// ─────────────────────────────────────────────────────────────

export const getPeriods = async (req, res) => {
  const { companyId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM accounting_periods WHERE company_id = $1 ORDER BY start_date DESC`,
      [companyId]
    );
    return res.json({ status: "success", data: result.rows });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};

export const createPeriod = async (req, res) => {
  const { companyId } = req.params;
  const { name, start_date, end_date } = req.body;

  if (!name || !start_date || !end_date)
    return res.status(400).json({ status: "fail", message: "name, start_date and end_date required" });

  try {
    const result = await pool.query(
      `INSERT INTO accounting_periods (company_id, name, start_date, end_date)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [companyId, name, start_date, end_date]
    );
    return res.status(201).json({ status: "success", data: result.rows[0] });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ status: "fail", message: "A period with these dates already exists" });
    return res.status(500).json({ status: "error", message: err.message });
  }
};

export const closePeriod = async (req, res) => {
  const { companyId, periodId } = req.params;
  const { closed_by } = req.body;
  try {
    const result = await pool.query(
      `UPDATE accounting_periods
       SET status = 'closed', closed_by = $1, closed_at = NOW()
       WHERE id = $2 AND company_id = $3 AND status = 'open'
       RETURNING *`,
      [closed_by, periodId, companyId]
    );
    if (!result.rows[0])
      return res.status(404).json({ status: "fail", message: "Period not found or already closed" });
    return res.json({ status: "success", data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};
