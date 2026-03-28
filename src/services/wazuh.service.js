const fetch = require('node-fetch');
const https = require('https');
const { query } = require('../config/database');
const logger = require('../config/logger');

// Allow self-signed certificates for internal Wazuh servers
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const WAZUH_HOST = process.env.WAZUH_HOST;
const WAZUH_USER = process.env.WAZUH_USER;
const WAZUH_PASSWORD = process.env.WAZUH_PASSWORD;

let wazuhToken = null;
let tokenExpiry = null;

const getWazuhToken = async () => {
  if (wazuhToken && tokenExpiry && new Date() < tokenExpiry) return wazuhToken;

  const res = await fetch(`${WAZUH_HOST}/security/user/authenticate`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${WAZUH_USER}:${WAZUH_PASSWORD}`).toString('base64')}`,
    },
    agent: httpsAgent,
    timeout: 10000,
  });

  if (!res.ok) throw new Error(`Wazuh auth failed: ${res.status}`);
  const data = await res.json();
  wazuhToken = data.data.token;
  tokenExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 min
  return wazuhToken;
};

const fetchWazuh = async (endpoint) => {
  const token = await getWazuhToken();
  const res = await fetch(`${WAZUH_HOST}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    agent: httpsAgent,
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`Wazuh API error: ${res.status}`);
  return res.json();
};

const severityFromLevel = (level) => {
  const l = parseInt(level) || 0;
  if (l >= 12) return 'critical';
  if (l >= 9) return 'high';
  if (l >= 6) return 'medium';
  return 'low';
};

const pollAlerts = async () => {
  if (!WAZUH_HOST || !WAZUH_USER || !WAZUH_PASSWORD) {
    logger.debug('Wazuh not configured — skipping poll');
    return;
  }

  try {
    const data = await fetchWazuh('/alerts?limit=500&sort=-timestamp');
    const alerts = data.data?.affected_items || [];

    for (const alert of alerts) {
      const alertId = alert.id || `${alert.agent?.id}-${alert.rule?.id}-${alert.timestamp}`;
      await query(
        `INSERT INTO wazuh_alerts (alert_id, rule_id, rule_description, severity, agent_id, agent_name, triggered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (alert_id) DO NOTHING`,
        [
          alertId,
          alert.rule?.id,
          alert.rule?.description,
          severityFromLevel(alert.rule?.level),
          alert.agent?.id,
          alert.agent?.name,
          alert.timestamp ? new Date(alert.timestamp) : new Date(),
        ]
      );
    }

    logger.info(`Wazuh: polled ${alerts.length} alerts`);
  } catch (err) {
    logger.error(`Wazuh poll failed: ${err.message}`);
    wazuhToken = null; // Reset token on failure
  }
};

module.exports = { pollAlerts };
