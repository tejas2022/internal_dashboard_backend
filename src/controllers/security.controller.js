const { query } = require('../config/database');
const { auditLog } = require('../middleware/auditLog');

// ---- Wazuh Alerts ----
const getWazuhAlerts = async (req, res, next) => {
  try {
    const { severity, agent_name, date_from, date_to, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT * FROM wazuh_alerts WHERE 1=1';
    const params = [];

    if (severity) { params.push(severity); sql += ` AND severity = $${params.length}`; }
    if (agent_name) { params.push(`%${agent_name}%`); sql += ` AND agent_name ILIKE $${params.length}`; }
    if (date_from) { params.push(date_from); sql += ` AND triggered_at >= $${params.length}`; }
    if (date_to) { params.push(date_to); sql += ` AND triggered_at <= $${params.length}`; }

    const countResult = await query(sql.replace('SELECT *', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count);

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    sql += ` ORDER BY triggered_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);
    res.json({ data: result.rows, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) { next(err); }
};

const getWazuhSummary = async (req, res, next) => {
  try {
    const summary = await query(
      `SELECT severity, COUNT(*) AS count
       FROM wazuh_alerts
       WHERE triggered_at >= NOW() - INTERVAL '24 hours'
       GROUP BY severity`
    );

    const trend = await query(
      `SELECT DATE(triggered_at) AS day, COUNT(*) AS count
       FROM wazuh_alerts
       WHERE triggered_at >= NOW() - INTERVAL '30 days'
       GROUP BY day ORDER BY day ASC`
    );

    const topRules = await query(
      `SELECT rule_id, rule_description, COUNT(*) AS count
       FROM wazuh_alerts
       WHERE triggered_at >= NOW() - INTERVAL '7 days'
       GROUP BY rule_id, rule_description
       ORDER BY count DESC LIMIT 10`
    );

    res.json({
      data: {
        severity_summary: summary.rows,
        trend_30_days: trend.rows,
        top_rules: topRules.rows,
      }
    });
  } catch (err) { next(err); }
};

const acknowledgeWazuhAlert = async (req, res, next) => {
  try {
    const { notes } = req.body;
    const result = await query(
      `UPDATE wazuh_alerts SET acknowledged_by = $1, acknowledged_at = NOW(), notes = $2
       WHERE id = $3 AND acknowledged_by IS NULL RETURNING *`,
      [req.user.id, notes || null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found or already acknowledged', code: 'NOT_FOUND' });
    }
    await auditLog(req.user.id, 'ACK_WAZUH_ALERT', 'wazuh_alerts', req.params.id, null, req.ip);
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

// ---- SOC Alerts ----
const getSocAlerts = async (req, res, next) => {
  try {
    const { status, severity, date_from, date_to, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT sa.*, u.name AS acknowledged_by_name FROM soc_alerts sa
               LEFT JOIN users u ON sa.acknowledged_by = u.id WHERE 1=1`;
    const params = [];

    if (status) { params.push(status); sql += ` AND sa.status = $${params.length}`; }
    if (severity) { params.push(severity); sql += ` AND sa.severity = $${params.length}`; }
    if (date_from) { params.push(date_from); sql += ` AND sa.received_at >= $${params.length}`; }
    if (date_to) { params.push(date_to); sql += ` AND sa.received_at <= $${params.length}`; }

    const countResult = await query(sql.replace('SELECT sa.*, u.name AS acknowledged_by_name', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count);

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    sql += ` ORDER BY sa.received_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);
    res.json({ data: result.rows, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) { next(err); }
};

const updateSocAlert = async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const validStatuses = ['open', 'acknowledged', 'resolved'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status', code: 'VALIDATION_ERROR' });
    }

    const result = await query(
      `UPDATE soc_alerts SET status = $1, notes = COALESCE($2, notes),
       acknowledged_by = CASE WHEN $1 IN ('acknowledged', 'resolved') THEN $3 ELSE acknowledged_by END,
       acknowledged_at = CASE WHEN $1 IN ('acknowledged', 'resolved') AND acknowledged_at IS NULL THEN NOW() ELSE acknowledged_at END,
       updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status, notes, req.user.id, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found', code: 'NOT_FOUND' });
    }

    await auditLog(req.user.id, 'UPDATE_SOC_ALERT', 'soc_alerts', req.params.id, { status }, req.ip);
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

const getSecuritySummary = async (req, res, next) => {
  try {
    const wazuh = await query(
      `SELECT COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
              COUNT(*) FILTER (WHERE severity = 'high') AS high,
              COUNT(*) FILTER (WHERE severity = 'medium') AS medium,
              COUNT(*) FILTER (WHERE severity = 'low') AS low
       FROM wazuh_alerts WHERE triggered_at >= NOW() - INTERVAL '24 hours'`
    );

    const soc = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'open') AS open,
              COUNT(*) FILTER (WHERE status = 'acknowledged') AS acknowledged,
              COUNT(*) FILTER (WHERE status = 'resolved') AS resolved
       FROM soc_alerts WHERE received_at >= NOW() - INTERVAL '7 days'`
    );

    res.json({
      data: {
        wazuh_24h: wazuh.rows[0],
        soc_7d: soc.rows[0],
      }
    });
  } catch (err) { next(err); }
};

const getWazuhDashboard = (_req, res) => {
  const url = process.env.WAZUH_DASHBOARD_URL;
  if (!url) return res.json({ data: null });
  res.json({ data: { url } });
};

module.exports = {
  getWazuhAlerts, getWazuhSummary, acknowledgeWazuhAlert,
  getSocAlerts, updateSocAlert, getSecuritySummary, getWazuhDashboard
};
