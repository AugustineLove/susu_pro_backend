// controllers/issueController.mjs
import pool from '../db.mjs';

export const STATUSES   = ['open', 'in_progress', 'awaiting_info', 'resolved', 'closed', 'rejected'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const CATEGORIES = [
  'deposit', 'withdrawal', 'accounting', 'customer', 'reports',
  'system_bug', 'access', 'staff_conduct', 'other',
];


const ADMIN_ROLES = ['admin', 'administrator', 'super admin', 'superadmin', 'manager', 'owner', 'hr', 'accountant'];

const loadActor = async (db, staffId) => {
  if (!staffId) return null;
  const r = await db.query(
    `SELECT id, full_name, role FROM staff WHERE id = $1`,
    [staffId]
  );
  if (r.rowCount === 0) return null;
  const s = r.rows[0];
  return {
    id: s.id,
    name: s.full_name,
    isAdmin: ADMIN_ROLES.includes(String(s.role || '').toLowerCase()),
  };
};

const logHistory = (db, issueId, actorId, action, from, to) =>
  db.query(
    `INSERT INTO issue_history (issue_id, actor_id, action, from_value, to_value)
     VALUES ($1,$2,$3,$4,$5)`,
    [issueId, actorId, action, from ?? null, to ?? null]
  );

const fail = (status, message) => Object.assign(new Error(message), { status });

// ═════════════════════════════════════════════════════════════
// POST /issues  — any staff can report
// ═════════════════════════════════════════════════════════════
export const createIssue = async (req, res) => {
  const {
    company_id, staff_id, title, description,
    category = 'other', priority = 'medium',
    related_customer_id = null, related_transaction_id = null, related_reference = null,
  } = req.body;

  if (!company_id || !staff_id || !title?.trim() || !description?.trim())
    return res.status(400).json({ status: 'fail', message: 'company_id, staff_id, title and description are required' });
  if (!CATEGORIES.includes(category))
    return res.status(400).json({ status: 'fail', message: 'Invalid category' });
  if (!PRIORITIES.includes(priority))
    return res.status(400).json({ status: 'fail', message: 'Invalid priority' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actor = await loadActor(client, staff_id);
    if (!actor) throw fail(401, 'Staff not found');

    const ins = await client.query(
      `INSERT INTO issues
         (company_id, title, description, category, priority, reported_by,
          related_customer_id, related_transaction_id, related_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [company_id, title.trim(), description.trim(), category, priority, staff_id,
       related_customer_id, related_transaction_id, related_reference?.trim() || null]
    );

    await logHistory(client, ins.rows[0].id, staff_id, 'created', null, 'open');
    await client.query('COMMIT');

    return res.status(201).json({ status: 'success', message: 'Issue reported', data: ins.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('createIssue error:', err.message);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  } finally {
    client.release();
  }
};

// ═════════════════════════════════════════════════════════════
// GET /issues/:company_id?staff_id=&scope=mine|all&status=&priority=&category=&assigned=&search=&page=&limit=
// Non-admins are ALWAYS restricted to their own issues.
// ═════════════════════════════════════════════════════════════
export const getIssues = async (req, res) => {
  try {
    const { company_id } = req.params;
    const { staff_id, scope = 'mine', status, priority, category, assigned, search } = req.query;

    const actor = await loadActor(pool, staff_id);
    if (!actor) return res.status(401).json({ status: 'fail', message: 'Staff not found' });

    const page   = Math.max(parseInt(req.query.page) || 1, 1);
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const where  = ['i.company_id = $1', 'i.is_deleted = false'];
    const values = [company_id];
    let p = 2;

    if (!actor.isAdmin || scope === 'mine') {
      where.push(`i.reported_by = $${p++}`);
      values.push(actor.id);
    }
    if (status && status !== 'all') {
      if (status === 'active') where.push(`i.status IN ('open','in_progress','awaiting_info')`);
      else { where.push(`i.status = $${p++}`); values.push(status); }
    }
    if (priority && priority !== 'all') { where.push(`i.priority = $${p++}`); values.push(priority); }
    if (category && category !== 'all') { where.push(`i.category = $${p++}`); values.push(category); }
    if (assigned && assigned !== 'all') {
      if (assigned === 'unassigned') where.push('i.assigned_to IS NULL');
      else { where.push(`i.assigned_to = $${p++}`); values.push(assigned); }
    }
    if (search) {
      where.push(`(i.title ILIKE $${p} OR i.ticket_no ILIKE $${p} OR i.description ILIKE $${p} OR i.related_reference ILIKE $${p})`);
      values.push(`%${search}%`);
      p++;
    }

    const whereSql = 'WHERE ' + where.join(' AND ');

    const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM issues i ${whereSql}`, values);
    const total = countRes.rows[0].total;

    const result = await pool.query(
      `SELECT
         i.*,
         rb.full_name  AS reported_by_name,
         asg.full_name AS assigned_to_name,
         (SELECT COUNT(*)::int FROM issue_comments c
           WHERE c.issue_id = i.id ${actor.isAdmin ? '' : 'AND c.is_internal = false'}) AS comment_count
       FROM issues i
       LEFT JOIN staff rb  ON rb.id  = i.reported_by
       LEFT JOIN staff asg ON asg.id = i.assigned_to
       ${whereSql}
       ORDER BY
         CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'awaiting_info' THEN 2 ELSE 3 END,
         CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         i.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      [...values, limit, offset]
    );

    return res.status(200).json({
      status: 'success',
      is_admin: actor.isAdmin,
      page, limit, total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      data: result.rows,
    });
  } catch (err) {
    console.error('getIssues error:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch issues' });
  }
};

// ═════════════════════════════════════════════════════════════
// GET /issues/:company_id/stats?staff_id=&scope=
// ═════════════════════════════════════════════════════════════
export const getIssueStats = async (req, res) => {
  try {
    const { company_id } = req.params;
    const { staff_id, scope = 'mine' } = req.query;

    const actor = await loadActor(pool, staff_id);
    if (!actor) return res.status(401).json({ status: 'fail', message: 'Staff not found' });

    const values = [company_id];
    let extra = '';
    if (!actor.isAdmin || scope === 'mine') { extra = 'AND reported_by = $2'; values.push(actor.id); }

    const r = await pool.query(
      `SELECT
         COUNT(*)::int                                                  AS total,
         COUNT(*) FILTER (WHERE status = 'open')::int                   AS open,
         COUNT(*) FILTER (WHERE status = 'in_progress')::int            AS in_progress,
         COUNT(*) FILTER (WHERE status = 'awaiting_info')::int          AS awaiting_info,
         COUNT(*) FILTER (WHERE status = 'resolved')::int               AS resolved,
         COUNT(*) FILTER (WHERE status IN ('closed','rejected'))::int   AS closed,
         COUNT(*) FILTER (WHERE priority = 'critical'
                            AND status IN ('open','in_progress','awaiting_info'))::int AS critical_active,
         COUNT(*) FILTER (WHERE assigned_to IS NULL
                            AND status IN ('open','in_progress','awaiting_info'))::int AS unassigned
       FROM issues
       WHERE company_id = $1 AND is_deleted = false ${extra}`,
      values
    );

    return res.status(200).json({ status: 'success', is_admin: actor.isAdmin, data: r.rows[0] });
  } catch (err) {
    console.error('getIssueStats error:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch stats' });
  }
};

// ═════════════════════════════════════════════════════════════
// GET /issues/:company_id/assignees  — staff list for the assignee dropdown
// ═════════════════════════════════════════════════════════════
export const getAssignees = async (req, res) => {
  try {
    const { company_id } = req.params;
    const r = await pool.query(
      `SELECT id, full_name, role FROM staff WHERE company_id = $1 ORDER BY full_name`,
      [company_id]
    );
    return res.status(200).json({ status: 'success', data: r.rows });
  } catch (err) {
    console.error('getAssignees error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch staff' });
  }
};

// ═════════════════════════════════════════════════════════════
// GET /issues/detail/:id?staff_id=   — issue + thread + audit trail
// ═════════════════════════════════════════════════════════════
export const getIssueDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const { staff_id } = req.query;

    const actor = await loadActor(pool, staff_id);
    if (!actor) return res.status(401).json({ status: 'fail', message: 'Staff not found' });

    const issueRes = await pool.query(
      `SELECT i.*,
              rb.full_name  AS reported_by_name,
              asg.full_name AS assigned_to_name,
              rsv.full_name AS resolved_by_name,
              cu.name       AS related_customer_name
       FROM issues i
       LEFT JOIN staff rb     ON rb.id  = i.reported_by
       LEFT JOIN staff asg    ON asg.id = i.assigned_to
       LEFT JOIN staff rsv    ON rsv.id = i.resolved_by
       LEFT JOIN customers cu ON cu.id  = i.related_customer_id
       WHERE i.id = $1 AND i.is_deleted = false`,
      [id]
    );
    if (issueRes.rowCount === 0)
      return res.status(404).json({ status: 'fail', message: 'Issue not found' });

    const issue = issueRes.rows[0];
    if (!actor.isAdmin && issue.reported_by !== actor.id)
      return res.status(403).json({ status: 'fail', message: 'You can only view issues you reported' });

    const [comments, history] = await Promise.all([
      pool.query(
        `SELECT c.id, c.body, c.is_internal, c.created_at, c.author_id, s.full_name AS author_name
         FROM issue_comments c
         LEFT JOIN staff s ON s.id = c.author_id
         WHERE c.issue_id = $1 ${actor.isAdmin ? '' : 'AND c.is_internal = false'}
         ORDER BY c.created_at ASC`,
        [id]
      ),
      pool.query(
        `SELECT h.id, h.action, h.from_value, h.to_value, h.created_at, s.full_name AS actor_name
         FROM issue_history h
         LEFT JOIN staff s ON s.id = h.actor_id
         WHERE h.issue_id = $1
         ORDER BY h.created_at ASC`,
        [id]
      ),
    ]);

    return res.status(200).json({
      status: 'success',
      is_admin: actor.isAdmin,
      data: { issue, comments: comments.rows, history: history.rows },
    });
  } catch (err) {
    console.error('getIssueDetail error:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch issue' });
  }
};

// ═════════════════════════════════════════════════════════════
// PATCH /issues/:id
// Admin: status, priority, category, assigned_to, resolution_note
// Reporter: may only cancel (-> closed) while unresolved, or reopen (-> open) once resolved
// ═════════════════════════════════════════════════════════════
export const updateIssue = async (req, res) => {
  const { id } = req.params;
  const { staff_id, status, priority, category, assigned_to, resolution_note } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actor = await loadActor(client, staff_id);
    if (!actor) throw fail(401, 'Staff not found');

    const cur = await client.query(
      `SELECT * FROM issues WHERE id = $1 AND is_deleted = false FOR UPDATE`,
      [id]
    );
    if (cur.rowCount === 0) throw fail(404, 'Issue not found');
    const issue = cur.rows[0];

    // ── Permission gate ──────────────────────────────────
    if (!actor.isAdmin) {
      if (issue.reported_by !== actor.id) throw fail(403, 'You can only update issues you reported');
      if (priority !== undefined || category !== undefined || assigned_to !== undefined || resolution_note !== undefined)
        throw fail(403, 'Only an admin can change priority, category, assignee or resolution');

      const cancelling = status === 'closed' && ['open', 'awaiting_info', 'resolved'].includes(issue.status);
      const reopening  = status === 'open'   && issue.status === 'resolved';
      if (!cancelling && !reopening) throw fail(403, 'You are not allowed to make that status change');
    }

    // ── Validation ───────────────────────────────────────
    if (status !== undefined && !STATUSES.includes(status))     throw fail(400, 'Invalid status');
    if (priority !== undefined && !PRIORITIES.includes(priority)) throw fail(400, 'Invalid priority');
    if (category !== undefined && !CATEGORIES.includes(category)) throw fail(400, 'Invalid category');

    const note = resolution_note !== undefined ? String(resolution_note).trim() : undefined;
    const newStatus = status ?? issue.status;

    if (actor.isAdmin && ['resolved', 'rejected'].includes(newStatus) && status !== undefined && status !== issue.status) {
      const finalNote = note !== undefined ? note : issue.resolution_note;
      if (!finalNote) throw fail(400, `A resolution note is required to mark an issue as ${newStatus}`);
    }

    // ── Build the update ─────────────────────────────────
    const sets = [];
    const vals = [];
    let p = 1;
    const set = (col, v) => { sets.push(`${col} = $${p++}`); vals.push(v); };

    if (status !== undefined && status !== issue.status) {
      set('status', status);
      await logHistory(client, id, actor.id, 'status', issue.status, status);

      if (status === 'resolved') { sets.push('resolved_at = NOW()'); set('resolved_by', actor.id); }
      if (status === 'closed' || status === 'rejected') sets.push('closed_at = NOW()');
      if (['open', 'in_progress', 'awaiting_info'].includes(status)) {
        sets.push('resolved_at = NULL', 'closed_at = NULL', 'resolved_by = NULL');
      }
    }

    if (priority !== undefined && priority !== issue.priority) {
      set('priority', priority);
      await logHistory(client, id, actor.id, 'priority', issue.priority, priority);
    }

    if (category !== undefined && category !== issue.category) {
      set('category', category);
      await logHistory(client, id, actor.id, 'category', issue.category, category);
    }

    if (assigned_to !== undefined && (assigned_to || null) !== issue.assigned_to) {
      let toName = null;
      let fromName = null;
      if (assigned_to) {
        const a = await client.query('SELECT full_name FROM staff WHERE id = $1', [assigned_to]);
        if (a.rowCount === 0) throw fail(400, 'Assignee not found');
        toName = a.rows[0].full_name;
      }
      if (issue.assigned_to) {
        const f = await client.query('SELECT full_name FROM staff WHERE id = $1', [issue.assigned_to]);
        fromName = f.rows[0]?.full_name ?? null;
      }
      set('assigned_to', assigned_to || null);
      await logHistory(client, id, actor.id, 'assignee', fromName, toName);

      // Picking up an untouched issue = it is now being worked on
      if (assigned_to && issue.status === 'open' && status === undefined) {
        set('status', 'in_progress');
        await logHistory(client, id, actor.id, 'status', 'open', 'in_progress');
      }
    }

    if (note !== undefined && note !== (issue.resolution_note || '')) {
      set('resolution_note', note || null);
      await logHistory(client, id, actor.id, 'resolution', null, note ? 'updated' : 'cleared');
    }

    if (sets.length === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ status: 'success', message: 'No changes', data: issue });
    }

    sets.push('updated_at = NOW()');
    vals.push(id);
    const upd = await client.query(
      `UPDATE issues SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      vals
    );

    await client.query('COMMIT');
    return res.status(200).json({ status: 'success', message: 'Issue updated', data: upd.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('updateIssue error:', err.message);
    return res.status(err.status || 500).json({ status: err.status && err.status < 500 ? 'fail' : 'error', message: err.message });
  } finally {
    client.release();
  }
};

// ═════════════════════════════════════════════════════════════
// POST /issues/:id/comments
// Reporter and admin can reply. Only admin can post internal notes.
// If the reporter answers an 'awaiting_info' issue, it goes back to in_progress.
// ═════════════════════════════════════════════════════════════
export const addComment = async (req, res) => {
  const { id } = req.params;
  const { staff_id, body, is_internal = false } = req.body;

  if (!body?.trim()) return res.status(400).json({ status: 'fail', message: 'Comment cannot be empty' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actor = await loadActor(client, staff_id);
    if (!actor) throw fail(401, 'Staff not found');

    const cur = await client.query(
      `SELECT id, status, reported_by FROM issues WHERE id = $1 AND is_deleted = false FOR UPDATE`,
      [id]
    );
    if (cur.rowCount === 0) throw fail(404, 'Issue not found');
    const issue = cur.rows[0];

    if (!actor.isAdmin && issue.reported_by !== actor.id)
      throw fail(403, 'You can only comment on issues you reported');
    if (is_internal && !actor.isAdmin)
      throw fail(403, 'Only an admin can post internal notes');
    if (['closed', 'rejected'].includes(issue.status) && !actor.isAdmin)
      throw fail(400, 'This issue is closed. Reopen it to add comments.');

    const ins = await client.query(
      `INSERT INTO issue_comments (issue_id, author_id, body, is_internal)
       VALUES ($1,$2,$3,$4)
       RETURNING id, body, is_internal, created_at, author_id`,
      [id, actor.id, body.trim(), !!is_internal]
    );

    if (!actor.isAdmin && issue.status === 'awaiting_info') {
      await client.query(`UPDATE issues SET status = 'in_progress', updated_at = NOW() WHERE id = $1`, [id]);
      await logHistory(client, id, actor.id, 'status', 'awaiting_info', 'in_progress');
    } else {
      await client.query(`UPDATE issues SET updated_at = NOW() WHERE id = $1`, [id]);
    }

    await client.query('COMMIT');
    return res.status(201).json({
      status: 'success',
      data: { ...ins.rows[0], author_name: actor.name },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('addComment error:', err.message);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  } finally {
    client.release();
  }
};

// ═════════════════════════════════════════════════════════════
// DELETE /issues/:id  — admin only, soft delete
// ═════════════════════════════════════════════════════════════
export const deleteIssue = async (req, res) => {
  const { id } = req.params;
  const { staff_id } = req.body;
  try {
    const actor = await loadActor(pool, staff_id);
    if (!actor) return res.status(401).json({ status: 'fail', message: 'Staff not found' });
    if (!actor.isAdmin) return res.status(403).json({ status: 'fail', message: 'Only an admin can delete issues' });

    const r = await pool.query(
      `UPDATE issues SET is_deleted = true, updated_at = NOW() WHERE id = $1 AND is_deleted = false RETURNING id`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ status: 'fail', message: 'Issue not found' });
    return res.status(200).json({ status: 'success', message: 'Issue deleted' });
  } catch (err) {
    console.error('deleteIssue error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to delete issue' });
  }
};
