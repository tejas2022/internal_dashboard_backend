const cron = require('node-cron');
const { pollDevices, pollAlarms } = require('../services/opmanager.service');
const { pollAlerts: pollWazuhAlerts } = require('../services/wazuh.service');
const { pollSocEmails } = require('../services/email.service');
const logger = require('../config/logger');

// OpManager: every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  logger.debug('Cron: polling OpManager devices');
  await pollDevices();
});

cron.schedule('*/5 * * * *', async () => {
  logger.debug('Cron: polling OpManager alarms');
  await pollAlarms();
});

// Wazuh: every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  logger.debug('Cron: polling Wazuh alerts');
  await pollWazuhAlerts();
});

// SOC email: every 10 minutes
cron.schedule('*/10 * * * *', () => {
  logger.debug('Cron: polling SOC email inbox');
  pollSocEmails();
});

// Cleanup old refresh tokens: daily at 3am
cron.schedule('0 3 * * *', async () => {
  const { query } = require('../config/database');
  try {
    const result = await query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
    logger.info(`Cleaned up ${result.rowCount} expired refresh tokens`);
  } catch (err) {
    logger.error(`Token cleanup failed: ${err.message}`);
  }
});

// Cleanup old Wazuh alerts (>90 days): daily at 3:30am
cron.schedule('30 3 * * *', async () => {
  const { query } = require('../config/database');
  try {
    await query("DELETE FROM wazuh_alerts WHERE triggered_at < NOW() - INTERVAL '90 days'");
    await query("DELETE FROM soc_alerts WHERE received_at < NOW() - INTERVAL '90 days'");
    await query("DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '1 year'");
    logger.info('Completed data retention cleanup');
  } catch (err) {
    logger.error(`Data retention cleanup failed: ${err.message}`);
  }
});

logger.info('Background pollers scheduled');

// Run immediately on startup so data appears without waiting for first cron tick
(async () => {
  logger.info('Running initial polls on startup...');
  await pollDevices();
  await pollAlarms();
  await pollWazuhAlerts();
})().catch(err => logger.error('Initial poll error:', err.message));
