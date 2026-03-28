const { randomUUID } = require('crypto');
const { query } = require('../config/database');
const { auditLog } = require('../middleware/auditLog');

const listApplications = async (req, res, next) => {
  try {
    const { active } = req.query;
    let sql = `
      SELECT a.*, u.name AS manager_name, u.email AS manager_email,
             p.name AS parent_name
      FROM applications a
      LEFT JOIN users u ON a.manager_user_id = u.id
      LEFT JOIN applications p ON a.parent_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (active !== undefined) {
      params.push(active === 'true');
      sql += ` AND a.is_active = $${params.length}`;
    }
    sql += ' ORDER BY a.name ASC';

    const result = await query(sql, params);
    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
};

const getApplication = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT a.*, u.name AS manager_name, p.name AS parent_name
       FROM applications a
       LEFT JOIN users u ON a.manager_user_id = u.id
       LEFT JOIN applications p ON a.parent_id = p.id
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found', code: 'NOT_FOUND' });
    }

    // Get sub-applications
    const subs = await query(
      'SELECT id, name, type, environment, is_active FROM applications WHERE parent_id = $1',
      [req.params.id]
    );

    res.json({ data: { ...result.rows[0], sub_applications: subs.rows } });
  } catch (err) {
    next(err);
  }
};

const createApplication = async (req, res, next) => {
  try {
    const { name, parent_id, type, environment, manager_user_id, description, tags } = req.body;

    const result = await query(
      `INSERT INTO applications (id, name, parent_id, type, environment, manager_user_id, description, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [randomUUID(), name, parent_id || null, type, environment || 'prod', manager_user_id || null, description, tags || []]
    );

    await auditLog(req.user.id, 'CREATE_APPLICATION', 'applications', result.rows[0].id, { name }, req.ip);
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

const updateApplication = async (req, res, next) => {
  try {
    const { name, parent_id, type, environment, manager_user_id, description, tags, is_active } = req.body;
    const appId = req.params.id;

    const result = await query(
      `UPDATE applications SET
         name = COALESCE($1, name),
         parent_id = COALESCE($2, parent_id),
         type = COALESCE($3, type),
         environment = COALESCE($4, environment),
         manager_user_id = COALESCE($5, manager_user_id),
         description = COALESCE($6, description),
         tags = COALESCE($7, tags),
         is_active = COALESCE($8, is_active),
         updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [name, parent_id, type, environment, manager_user_id, description, tags, is_active, appId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found', code: 'NOT_FOUND' });
    }

    await auditLog(req.user.id, 'UPDATE_APPLICATION', 'applications', appId, req.body, req.ip);
    res.json({ data: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

const deleteApplication = async (req, res, next) => {
  try {
    const result = await query(
      'UPDATE applications SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found', code: 'NOT_FOUND' });
    }
    await auditLog(req.user.id, 'DEACTIVATE_APPLICATION', 'applications', req.params.id, null, req.ip);
    res.json({ message: 'Application deactivated' });
  } catch (err) {
    next(err);
  }
};

const getApplicationsForUser = async (req, res, next) => {
  try {
    let result;
    if (req.user.role === 'admin') {
      result = await query(
        'SELECT id, name, type, environment, is_active FROM applications WHERE is_active = true ORDER BY name'
      );
    } else {
      result = await query(
        `SELECT id, name, type, environment, is_active FROM applications
         WHERE manager_user_id = $1 AND is_active = true ORDER BY name`,
        [req.user.id]
      );
    }
    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
};

module.exports = { listApplications, getApplication, createApplication, updateApplication, deleteApplication, getApplicationsForUser };
