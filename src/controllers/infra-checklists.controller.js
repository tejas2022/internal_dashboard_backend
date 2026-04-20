const { randomUUID } = require('crypto');
const { query, getClient } = require('../config/database');

// GET /infra-checklists/categories
const getCategories = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT ic.*, u.name AS manager_name
       FROM infra_categories ic
       LEFT JOIN users u ON ic.manager_user_id = u.id
       WHERE ic.is_active = true ORDER BY ic.sort_order`
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

// GET /infra-checklists/my-categories  — categories assigned to current user
const getMyCategories = async (req, res, next) => {
  try {
    if (req.user.role === 'admin') {
      // Admins see all categories
      const result = await query(
        `SELECT ic.*, u.name AS manager_name
         FROM infra_categories ic
         LEFT JOIN users u ON ic.manager_user_id = u.id
         WHERE ic.is_active = true ORDER BY ic.sort_order`
      );
      return res.json({ data: result.rows });
    }
    const result = await query(
      `SELECT ic.*, u.name AS manager_name
       FROM infra_categories ic
       LEFT JOIN users u ON ic.manager_user_id = u.id
       WHERE ic.is_active = true AND ic.manager_user_id = $1
       ORDER BY ic.sort_order`,
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

// PATCH /infra-checklists/categories/:id/assign  — admin assigns a user
const assignCategory = async (req, res, next) => {
  try {
    const { manager_user_id } = req.body;
    const { id } = req.params;
    await query(
      'UPDATE infra_categories SET manager_user_id = $1 WHERE id = $2',
      [manager_user_id || null, id]
    );
    res.json({ data: { message: 'Category assigned successfully' } });
  } catch (err) { next(err); }
};

// GET /infra-checklists/templates?category_id=...
const getTemplates = async (req, res, next) => {
  try {
    const { category_id } = req.query;
    let sql = 'SELECT * FROM infra_checklist_templates WHERE is_active = true';
    const params = [];
    if (category_id) {
      params.push(category_id);
      sql += ` AND category_id = $${params.length}`;
    }
    sql += ' ORDER BY sort_order';
    const result = await query(sql, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

// GET /infra-checklists/today
const getTodaySummary = async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await query(
      `SELECT
         ic.id AS category_id,
         ic.name AS category_name,
         ic.sort_order,
         icl.id AS checklist_id,
         icl.status,
         icl.is_late,
         icl.submitted_at,
         COUNT(ici.id) FILTER (WHERE ici.result = 'fail') AS failure_count
       FROM infra_categories ic
       LEFT JOIN infra_checklists icl ON icl.category_id = ic.id AND icl.date = $1
       LEFT JOIN infra_checklist_items ici ON ici.infra_checklist_id = icl.id
       WHERE ic.is_active = true
       GROUP BY ic.id, ic.name, ic.sort_order, icl.id, icl.status, icl.is_late, icl.submitted_at
       ORDER BY ic.sort_order`,
      [today]
    );
    res.json({ data: result.rows, date: today });
  } catch (err) { next(err); }
};

// GET /infra-checklists?date_from=&date_to=&category_id=&status=
const listChecklists = async (req, res, next) => {
  try {
    const { date_from, date_to, category_id, status } = req.query;
    let sql = `
      SELECT
        icl.*,
        ic.name AS category_name,
        u.name AS submitted_by_name,
        COUNT(ici.id) FILTER (WHERE ici.result = 'fail') AS failure_count
      FROM infra_checklists icl
      JOIN infra_categories ic ON icl.category_id = ic.id
      LEFT JOIN users u ON icl.submitted_by = u.id
      LEFT JOIN infra_checklist_items ici ON ici.infra_checklist_id = icl.id
      WHERE 1=1
    `;
    const params = [];

    if (date_from) { params.push(date_from); sql += ` AND icl.date >= $${params.length}`; }
    if (date_to)   { params.push(date_to);   sql += ` AND icl.date <= $${params.length}`; }
    if (category_id) { params.push(category_id); sql += ` AND icl.category_id = $${params.length}`; }
    if (status)    { params.push(status);    sql += ` AND icl.status = $${params.length}`; }

    sql += ' GROUP BY icl.id, ic.name, u.name ORDER BY icl.date DESC, ic.name ASC LIMIT 50';

    const result = await query(sql, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

// GET /infra-checklists/:id
const getChecklist = async (req, res, next) => {
  try {
    const checklistResult = await query(
      `SELECT icl.*, ic.name AS category_name, u.name AS submitted_by_name
       FROM infra_checklists icl
       JOIN infra_categories ic ON icl.category_id = ic.id
       LEFT JOIN users u ON icl.submitted_by = u.id
       WHERE icl.id = $1`,
      [req.params.id]
    );

    if (checklistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Checklist not found', code: 'NOT_FOUND' });
    }

    const checklist = checklistResult.rows[0];

    const itemsResult = await query(
      `SELECT * FROM infra_checklist_items
       WHERE infra_checklist_id = $1
       ORDER BY sort_order`,
      [req.params.id]
    );

    res.json({ data: { ...checklist, items: itemsResult.rows } });
  } catch (err) { next(err); }
};

// POST /infra-checklists
const submitChecklist = async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { category_id, items } = req.body;
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    if (!category_id || !Array.isArray(items) || items.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'category_id and items are required', code: 'VALIDATION_ERROR' });
    }

    // Check category exists and user is allowed to submit
    const catCheck = await client.query(
      'SELECT id, manager_user_id FROM infra_categories WHERE id = $1 AND is_active = true',
      [category_id]
    );
    if (catCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Category not found', code: 'NOT_FOUND' });
    }
    const cat = catCheck.rows[0];
    if (req.user.role !== 'admin' && cat.manager_user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not assigned to this infra category', code: 'FORBIDDEN' });
    }

    // Check for existing submission today
    const existing = await client.query(
      'SELECT id, status FROM infra_checklists WHERE category_id = $1 AND date = $2',
      [category_id, today]
    );

    if (existing.rows.length > 0 && existing.rows[0].status === 'locked') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Checklist already submitted and locked for today', code: 'ALREADY_SUBMITTED' });
    }

    // is_late = submitted after 10:00 AM local time
    const hour = new Date().getHours();
    const isLate = hour >= 10;

    let checklistId;
    if (existing.rows.length > 0) {
      // Update existing draft → lock it
      await client.query(
        `UPDATE infra_checklists
         SET submitted_by = $1, status = 'locked', is_late = $2,
             submitted_at = NOW(), updated_at = NOW()
         WHERE id = $3`,
        [userId, isLate, existing.rows[0].id]
      );
      checklistId = existing.rows[0].id;
      await client.query('DELETE FROM infra_checklist_items WHERE infra_checklist_id = $1', [checklistId]);
    } else {
      const newChecklist = await client.query(
        `INSERT INTO infra_checklists (id, category_id, submitted_by, date, status, is_late, submitted_at)
         VALUES ($1, $2, $3, $4, 'locked', $5, NOW()) RETURNING id`,
        [randomUUID(), category_id, userId, today, isLate]
      );
      checklistId = newChecklist.rows[0].id;
    }

    // Insert all items
    for (const item of items) {
      await client.query(
        `INSERT INTO infra_checklist_items (id, infra_checklist_id, item_key, label, result, notes, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          checklistId,
          item.item_key,
          item.label,
          item.result || null,
          item.notes || null,
          item.sort_order || 0,
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ data: { id: checklistId, message: 'Infra checklist submitted successfully' } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

module.exports = {
  getCategories,
  getMyCategories,
  assignCategory,
  getTemplates,
  getTodaySummary,
  listChecklists,
  getChecklist,
  submitChecklist,
};
