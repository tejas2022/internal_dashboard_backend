const { query } = require('../config/database');

const getLogs = async (req, res, next) => {
  try {
    const { user_id, action, entity_type, date_from, date_to, limit = 25, offset = 0 } = req.query;

    let sql = `
      SELECT al.*, u.name AS user_name, u.username
      FROM audit_logs al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1
    `;
    const params = [];

    if (user_id) { params.push(user_id); sql += ` AND al.user_id = $${params.length}`; }
    if (action) { params.push(`%${action}%`); sql += ` AND al.action ILIKE $${params.length}`; }
    if (entity_type) { params.push(entity_type); sql += ` AND al.entity_type = $${params.length}`; }
    if (date_from) { params.push(date_from); sql += ` AND al.created_at >= $${params.length}`; }
    if (date_to) { params.push(date_to); sql += ` AND al.created_at <= $${params.length}`; }

    const countResult = await query(
      sql.replace('SELECT al.*, u.name AS user_name, u.username', 'SELECT COUNT(*)'), params
    );
    const total = parseInt(countResult.rows[0].count);

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    sql += ` ORDER BY al.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);
    res.json({ data: result.rows, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) { next(err); }
};

module.exports = { getLogs };
