const fetch = require('node-fetch');
const { randomUUID } = require('crypto');
const { query } = require('../config/database');
const logger = require('../config/logger');

const OPMANAGER_HOST = process.env.OPMANAGER_HOST;
const OPMANAGER_API_KEY = process.env.OPMANAGER_API_KEY;

// OpManager statusNum → normalised status
// 1 = Up, 2 = Down, 3 = Attention (warning, still reachable), 5 = Clear (OK), 7 = Unmanaged/Not Monitored
const statusFromNum = (num) => {
  const n = parseInt(num);
  if (n === 1 || n === 5) return 'up';       // Up or Clear
  if (n === 3) return 'up';                   // Attention — device reachable, has alerts
  if (n === 2) return 'down';                 // Down
  return 'unknown';                           // 7 (Unmanaged) or anything else
};

const fetchOpManager = async (path) => {
  const url = `${OPMANAGER_HOST}/api/json/v2/${path}&apiKey=${OPMANAGER_API_KEY}`;
  const res = await fetch(url, { timeout: 10000 });
  if (res.status === 404) {
    const err = new Error(`OpManager endpoint not found: ${path}`);
    err.code = 404;
    throw err;
  }
  if (!res.ok) throw new Error(`OpManager API error: ${res.status}`);
  return res.json();
};

const pollDevices = async () => {
  if (!OPMANAGER_HOST || !OPMANAGER_API_KEY) {
    logger.debug('OpManager not configured — skipping device poll');
    return;
  }

  try {
    // Keep only last 2 hours of snapshots — dashboard only needs the latest status per device
    await query("DELETE FROM opmanager_snapshots WHERE polled_at < NOW() - INTERVAL '2 hours'");

    const data = await fetchOpManager('device/listDevices?');
    const devices = data.rows || data.details || [];

    if (devices.length === 0) return;

    // Bulk INSERT — one VALUES row per device, one round-trip to pglite
    const now = new Date().toISOString();
    const valueClauses = [];
    const params = [];
    let idx = 1;
    for (const device of devices) {
      const deviceId = device.ipaddress || device.deviceName || String(device.id || '');
      valueClauses.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        randomUUID(), deviceId,
        device.displayName || device.deviceName || deviceId,
        device.type || device.category || null,
        device.ipaddress || device.ipAddress || null,
        statusFromNum(device.statusNum),
        null, null, null, now
      );
    }
    await query(
      `INSERT INTO opmanager_snapshots
       (id, device_id, device_name, device_type, ip_address, status,
        uptime_pct_24h, cpu_utilization, memory_utilization, polled_at)
       VALUES ${valueClauses.join(',')}`,
      params
    );

    logger.info(`OpManager: polled ${devices.length} devices`);
  } catch (err) {
    logger.error(`OpManager poll failed: ${err.message}`);
  }
};

const pollAlarms = async () => {
  if (!OPMANAGER_HOST || !OPMANAGER_API_KEY) return;

  // /alarms and /alarm/listAlarms are not available in this OpManager version.
  // Alarm data will not be fetched until the correct endpoint is confirmed.
  logger.debug('OpManager alarm polling skipped — endpoint not available in current version');
};

module.exports = { pollDevices, pollAlarms };
