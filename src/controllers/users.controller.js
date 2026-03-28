const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { auditLog } = require('../middleware/auditLog');

const listUsers = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, name, email, username, role, is_active, last_login, created_at
       FROM users ORDER BY name ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
};

const getUser = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, name, email, username, role, is_active, last_login, created_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

const createUser = async (req, res, next) => {
  try {
    const { name, email, username, password, role } = req.body;

    if (!['admin', 'user', 'stakeholder'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role', code: 'VALIDATION_ERROR' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (id, name, email, username, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, username, role, is_active, created_at`,
      [randomUUID(), name, email, username, hash, role]
    );

    await auditLog(req.user.id, 'CREATE_USER', 'users', result.rows[0].id, { name, email, role }, req.ip);
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

const updateUser = async (req, res, next) => {
  try {
    const { name, email, role, is_active } = req.body;
    const userId = req.params.id;

    // Prevent admin from deactivating themselves
    if (userId === req.user.id && is_active === false) {
      return res.status(400).json({ error: 'Cannot deactivate your own account', code: 'VALIDATION_ERROR' });
    }

    const result = await query(
      `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email),
       role = COALESCE($3, role), is_active = COALESCE($4, is_active), updated_at = NOW()
       WHERE id = $5
       RETURNING id, name, email, username, role, is_active`,
      [name, email, role, is_active, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
    }

    await auditLog(req.user.id, 'UPDATE_USER', 'users', userId, req.body, req.ip);
    res.json({ data: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

const resetUserPassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    const userId = req.params.id;

    const hash = await bcrypt.hash(newPassword, 12);
    await query(
      'UPDATE users SET password_hash = $1, must_change_password = true, updated_at = NOW() WHERE id = $2',
      [hash, userId]
    );

    await auditLog(req.user.id, 'RESET_PASSWORD', 'users', userId, null, req.ip);
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
};

const getApplicationManagers = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, name, email, username FROM users WHERE role IN ('admin', 'user') AND is_active = true ORDER BY name`
    );
    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
};

module.exports = { listUsers, getUser, createUser, updateUser, resetUserPassword, getApplicationManagers };
