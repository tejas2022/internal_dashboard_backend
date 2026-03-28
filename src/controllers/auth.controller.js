const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/database');
const { auditLog } = require('../middleware/auditLog');

const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  const refreshToken = jwt.sign(
    { userId, role },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  return { accessToken, refreshToken };
};

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress;

    const result = await query(
      `SELECT id, name, email, username, password_hash, role, is_active,
              must_change_password, failed_login_attempts, locked_until
       FROM users WHERE username = $1`,
      [username]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials', code: 'AUTH_INVALID' });
    }

    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is inactive', code: 'ACCOUNT_INACTIVE' });
    }

    // Check lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({
        error: `Account locked. Try again in ${minutesLeft} minute(s)`,
        code: 'ACCOUNT_LOCKED',
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      const lockUpdate = attempts >= 5
        ? ', locked_until = NOW() + INTERVAL \'15 minutes\''
        : '';
      await query(
        `UPDATE users SET failed_login_attempts = $1 ${lockUpdate} WHERE id = $2`,
        [attempts >= 5 ? 0 : attempts, user.id]
      );
      return res.status(401).json({ error: 'Invalid credentials', code: 'AUTH_INVALID' });
    }

    // Reset failed attempts on success
    await query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
    );

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);

    // Store refresh token hash
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
      [crypto.randomUUID(), user.id, tokenHash]
    );

    await auditLog(user.id, 'LOGIN', 'users', user.id, null, ip);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        role: user.role,
        mustChangePassword: user.must_change_password,
      },
    });
  } catch (err) {
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
    }
    await auditLog(req.user.id, 'LOGOUT', 'users', req.user.id, null, req.ip);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
};

const refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required', code: 'AUTH_REQUIRED' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const tokenResult = await query(
      'SELECT id FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND expires_at > NOW()',
      [decoded.userId, tokenHash]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'AUTH_INVALID' });
    }

    // Rotate refresh token
    await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);

    const userResult = await query(
      'SELECT id, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );
    const user = userResult.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User inactive', code: 'AUTH_INVALID' });
    }

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user.id, user.role);
    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    await query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
      [crypto.randomUUID(), user.id, newTokenHash]
    );

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid refresh token', code: 'AUTH_INVALID' });
    }
    next(err);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    const result = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Current password is incorrect', code: 'INVALID_PASSWORD' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters', code: 'WEAK_PASSWORD' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await query(
      'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2',
      [hash, userId]
    );

    await auditLog(userId, 'CHANGE_PASSWORD', 'users', userId, null, req.ip);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    next(err);
  }
};

const getMe = async (req, res) => {
  res.json({
    id: req.user.id,
    name: req.user.name,
    email: req.user.email,
    username: req.user.username,
    role: req.user.role,
  });
};

module.exports = { login, logout, refresh, changePassword, getMe };
