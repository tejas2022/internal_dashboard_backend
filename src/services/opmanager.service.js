const fetch = require('node-fetch');
const { randomUUID } = require('crypto');
const { query } = require('../config/database');
const logger = require('../config/logger');

const OPMANAGER_HOST = process.env.OPMANAGER_HOST;
const OPMANAGER_API_KEY = process.env.OPMANAGER_API_KEY;

// OpManager statusNum → normalised status
// 1 = Up, 2 = Down, 3 = Warning, 5 = Clear/Unmanaged, 0/others = unknown
const statusFromNum = (num) => {
  const n = parseInt(num);
  if (n === 1) return 'up';
  if (n === 2) return 'down';
  return 'unknown';
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
    // Uses v2 listDevices — returns { total, page, records, rows[] }
    // Note: do NOT include type=json — it causes OpManager to return empty rows
    const data = await fetchOpManager('device/listDevices?');
    // Note: 'total' may report 0 even when rows are present; use rows directly
    const devices = data.rows || data.details || [];

    for (const device of devices) {
      const deviceId = device.ipaddress || device.deviceName || String(device.id || '');
      await query(
        `INSERT INTO opmanager_snapshots
         (id, device_id, device_name, device_type, ip_address, status,
          uptime_pct_24h, cpu_utilization, memory_utilization)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          deviceId,
          device.displayName || device.deviceName || deviceId,
          device.type || device.category || null,
          device.ipaddress || device.ipAddress || null,
          statusFromNum(device.statusNum),
          null,
          null,
          null,
        ]
      );
    }

    logger.info(`OpManager: polled ${devices.length} devices (${data.records || devices.length} total in OM)`);
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
