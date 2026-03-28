const { randomUUID } = require('crypto');
const { query, getClient } = require('../config/database');
const { auditLog } = require('../middleware/auditLog');

const getChecklistTemplates = async (req, res, next) => {
  try {
    const { application_type, session } = req.query;
    let sql = 'SELECT * FROM checklist_templates WHERE is_active = true';
    const params = [];
    if (application_type) { params.push(application_type); sql += ` AND application_type = $${params.length}`; }
    if (session) { params.push(session); sql += ` AND session = $${params.length}`; }
    sql += ' ORDER BY application_type, session, sort_order';
    const result = await query(sql, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const listChecklists = async (req, res, next) => {
  try {
    const { date, application_id, session, status, date_from, date_to } = req.query;
    let sql = `
      SELECT c.*, a.name AS application_name, a.type AS application_type,
             u.name AS submitted_by_name
      FROM checklists c
      JOIN applications a ON c.application_id = a.id
      LEFT JOIN users u ON c.submitted_by = u.id
      WHERE 1=1
    `;
    const params = [];

    // Non-admin users can only see their own applications' checklists
    if (req.user.role !== 'admin') {
      params.push(req.user.id);
      sql += ` AND a.manager_user_id = $${params.length}`;
    }

    if (date) { params.push(date); sql += ` AND c.date = $${params.length}`; }
    if (application_id) { params.push(application_id); sql += ` AND c.application_id = $${params.length}`; }
    if (session) { params.push(session); sql += ` AND c.session = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND c.status = $${params.length}`; }
    if (date_from) { params.push(date_from); sql += ` AND c.date >= $${params.length}`; }
    if (date_to) { params.push(date_to); sql += ` AND c.date <= $${params.length}`; }

    sql += ' ORDER BY c.date DESC, a.name, c.session';
    const result = await query(sql, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const getChecklist = async (req, res, next) => {
  try {
    const checklistResult = await query(
      `SELECT c.*, a.name AS application_name, u.name AS submitted_by_name
       FROM checklists c
       JOIN applications a ON c.application_id = a.id
       LEFT JOIN users u ON c.submitted_by = u.id
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (checklistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Checklist not found', code: 'NOT_FOUND' });
    }

    const checklist = checklistResult.rows[0];

    // Access control: non-admin can only view own app's checklists
    if (req.user.role !== 'admin') {
      const appCheck = await query(
        'SELECT id FROM applications WHERE id = $1 AND manager_user_id = $2',
        [checklist.application_id, req.user.id]
      );
      if (appCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied', code: 'FORBIDDEN' });
      }
    }

    const itemsResult = await query(
      `SELECT ci.*, cf.justification, cf.occurred_at, cf.impact, cf.steps_taken,
              cf.status AS failure_status, cf.resolved_at, cf.escalated_to,
              u.name AS escalated_to_name
       FROM checklist_items ci
       LEFT JOIN checklist_failures cf ON cf.checklist_item_id = ci.id
       LEFT JOIN users u ON cf.escalated_to = u.id
       WHERE ci.checklist_id = $1
       ORDER BY ci.sort_order`,
      [req.params.id]
    );

    res.json({ data: { ...checklist, items: itemsResult.rows } });
  } catch (err) { next(err); }
};

const submitChecklist = async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { application_id, session, items } = req.body;
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    // Verify application assignment (non-admin must own the app)
    if (req.user.role !== 'admin') {
      const appCheck = await client.query(
        'SELECT id FROM applications WHERE id = $1 AND manager_user_id = $2 AND is_active = true',
        [application_id, userId]
      );
      if (appCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not assigned to this application', code: 'FORBIDDEN' });
      }
    }

    // Check for existing submission
    const existing = await client.query(
      'SELECT id, status FROM checklists WHERE application_id = $1 AND date = $2 AND session = $3',
      [application_id, today, session]
    );

    if (existing.rows.length > 0 && existing.rows[0].status === 'locked') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Checklist already submitted and locked', code: 'ALREADY_SUBMITTED' });
    }

    // Determine if late (BOD after 10am, EOD after 6pm — configurable)
    const hour = new Date().getHours();
    const isLate = (session === 'BOD' && hour >= 10) || (session === 'EOD' && hour >= 20);

    let checklistId;
    if (existing.rows.length > 0) {
      // Update existing draft
      await client.query(
        `UPDATE checklists SET submitted_by = $1, status = 'locked', is_late = $2,
         submitted_at = NOW(), updated_at = NOW(), override_by = $3
         WHERE id = $4`,
        [userId, isLate, req.user.role === 'admin' ? userId : null, existing.rows[0].id]
      );
      checklistId = existing.rows[0].id;
      // Clear existing items
      await client.query('DELETE FROM checklist_items WHERE checklist_id = $1', [checklistId]);
    } else {
      const newChecklist = await client.query(
        `INSERT INTO checklists (id, application_id, submitted_by, date, session, status, is_late, submitted_at)
         VALUES ($1, $2, $3, $4, $5, 'locked', $6, NOW()) RETURNING id`,
        [randomUUID(), application_id, userId, today, session, isLate]
      );
      checklistId = newChecklist.rows[0].id;
    }

    // Insert items and failures
    for (const item of items) {
      const itemResult = await client.query(
        `INSERT INTO checklist_items (id, checklist_id, item_key, label, result, notes, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [randomUUID(), checklistId, item.item_key, item.label, item.result, item.notes || null, item.sort_order || 0]
      );

      if (item.result === 'fail' && item.failure) {
        const f = item.failure;
        await client.query(
          `INSERT INTO checklist_failures
           (id, checklist_item_id, justification, occurred_at, impact, steps_taken, status, resolved_at, escalated_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), itemResult.rows[0].id, f.justification, f.occurred_at, f.impact,
           f.steps_taken, f.status, f.resolved_at || null, f.escalated_to || null]
        );
      }
    }

    await client.query('COMMIT');
    await auditLog(userId, 'SUBMIT_CHECKLIST', 'checklists', checklistId,
      { application_id, session }, req.ip);

    res.status(201).json({ data: { id: checklistId, message: 'Checklist submitted successfully' } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

const getTodaySummary = async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await query(
      `SELECT a.id, a.name, a.type,
              MAX(CASE WHEN c.session = 'BOD' THEN c.status END) AS bod_status,
              MAX(CASE WHEN c.session = 'BOD' THEN c.is_late::text END) AS bod_late,
              MAX(CASE WHEN c.session = 'EOD' THEN c.status END) AS eod_status,
              MAX(CASE WHEN c.session = 'EOD' THEN c.is_late::text END) AS eod_late,
              COUNT(DISTINCT ci.id) FILTER (WHERE ci.result = 'fail') AS failure_count
       FROM applications a
       LEFT JOIN checklists c ON c.application_id = a.id AND c.date = $1
       LEFT JOIN checklist_items ci ON ci.checklist_id = c.id
       WHERE a.is_active = true
       GROUP BY a.id, a.name, a.type
       ORDER BY a.name`,
      [today]
    );
    res.json({ data: result.rows, date: today });
  } catch (err) { next(err); }
};

const getHealthSummary = async (req, res, next) => {
  try {
    // Last 7 days failure trend per application
    const result = await query(
      `SELECT a.id, a.name,
              COUNT(ci.id) FILTER (WHERE ci.result = 'fail') AS total_failures,
              COUNT(ci.id) FILTER (WHERE ci.result = 'pass') AS total_passes,
              MAX(c.date) AS last_submission
       FROM applications a
       LEFT JOIN checklists c ON c.application_id = a.id AND c.date >= NOW() - INTERVAL '7 days'
       LEFT JOIN checklist_items ci ON ci.checklist_id = c.id
       WHERE a.is_active = true
       GROUP BY a.id, a.name
       ORDER BY total_failures DESC`
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

module.exports = {
  getChecklistTemplates, listChecklists, getChecklist,
  submitChecklist, getTodaySummary, getHealthSummary
};
