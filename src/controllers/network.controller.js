const { query } = require('../config/database');

const getNetworkSummary = async (req, res, next) => {
  try {
    // Latest snapshot per device
    const devices = await query(
      `SELECT DISTINCT ON (device_id) device_id, device_name, device_type, ip_address,
              status, uptime_pct_24h, uptime_pct_7d, uptime_pct_30d, cpu_utilization,
              memory_utilization, polled_at
       FROM opmanager_snapshots
       ORDER BY device_id, polled_at DESC`
    );

    const alarms = await query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
              COUNT(*) FILTER (WHERE severity = 'major') AS major,
              COUNT(*) FILTER (WHERE severity = 'minor') AS minor
       FROM opmanager_alarms WHERE is_active = true`
    );

    const totalDevices = devices.rows.length;
    const devicesUp = devices.rows.filter(d => d.status === 'up').length;
    const devicesDown = devices.rows.filter(d => d.status === 'down').length;

    const lastPolled = devices.rows.length > 0
      ? devices.rows.reduce((max, d) => d.polled_at > max ? d.polled_at : max, devices.rows[0].polled_at)
      : null;

    res.json({
      data: {
        summary: {
          total_devices: totalDevices,
          devices_up: devicesUp,
          devices_down: devicesDown,
          active_alarms: parseInt(alarms.rows[0].total),
          critical_alarms: parseInt(alarms.rows[0].critical),
          major_alarms: parseInt(alarms.rows[0].major),
          minor_alarms: parseInt(alarms.rows[0].minor),
          last_polled: lastPolled,
        },
        devices: devices.rows,
      }
    });
  } catch (err) { next(err); }
};

const getDevices = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT DISTINCT ON (device_id) device_id, device_name, device_type, ip_address,
              status, uptime_pct_24h, uptime_pct_7d, uptime_pct_30d, cpu_utilization,
              memory_utilization, polled_at
       FROM opmanager_snapshots
       ORDER BY device_id, polled_at DESC`
    );

    const stale = result.rows.length > 0 &&
      new Date() - new Date(result.rows[0].polled_at) > 10 * 60 * 1000;

    res.json({ data: result.rows, stale });
  } catch (err) { next(err); }
};

const getAlarms = async (req, res, next) => {
  try {
    const { severity, is_active } = req.query;
    let sql = 'SELECT * FROM opmanager_alarms WHERE 1=1';
    const params = [];

    if (severity) { params.push(severity); sql += ` AND severity = $${params.length}`; }
    if (is_active !== undefined) { params.push(is_active === 'true'); sql += ` AND is_active = $${params.length}`; }
    else sql += ' AND is_active = true';

    sql += ' ORDER BY raised_at DESC LIMIT 100';
    const result = await query(sql, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const getUptime = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT DISTINCT ON (device_id) device_id, device_name, uptime_pct_24h, uptime_pct_7d, uptime_pct_30d, polled_at
       FROM opmanager_snapshots ORDER BY device_id, polled_at DESC`
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const getDeviceHistory = async (req, res, next) => {
  try {
    const { device_id } = req.params;
    const result = await query(
      `SELECT device_id, device_name, status, cpu_utilization, memory_utilization, polled_at
       FROM opmanager_snapshots
       WHERE device_id = $1
       ORDER BY polled_at DESC LIMIT 288`,  // 24h at 5min intervals
      [device_id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const getWidgets = (req, res) => {
  const host = process.env.OPMANAGER_HOST;
  const raw = process.env.OPMANAGER_WIDGETS || '';
  if (!host || !raw) return res.json({ data: [] });

  const widgets = raw.split(',').map((pair, i) => {
    const [widgetID, authKey] = pair.trim().split(':');
    return {
      id: widgetID,
      url: `${host}/embedView.do?type=widget&widgetID=${widgetID}&authKey=${authKey}`,
      // Alternate heights matching original embed sizes
      height: i % 2 === 0 ? 559 : 489,
    };
  });
  res.json({ data: widgets });
};

module.exports = { getNetworkSummary, getDevices, getAlarms, getUptime, getDeviceHistory, getWidgets };
