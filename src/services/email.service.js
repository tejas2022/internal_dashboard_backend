const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { query } = require('../config/database');
const logger = require('../config/logger');

const SOC_EMAIL_HOST = process.env.SOC_EMAIL_HOST;
const SOC_EMAIL_USER = process.env.SOC_EMAIL_USER;
const SOC_EMAIL_PASSWORD = process.env.SOC_EMAIL_PASSWORD;
const SOC_EMAIL_PORT = parseInt(process.env.SOC_EMAIL_PORT || '993');

const parseSeverity = (text) => {
  const t = (text || '').toLowerCase();
  if (t.includes('critical')) return 'critical';
  if (t.includes('high')) return 'high';
  if (t.includes('medium')) return 'medium';
  if (t.includes('low')) return 'low';
  return 'info';
};

const extractAlertFields = (subject, body) => {
  const combined = `${subject} ${body}`;
  const severity = parseSeverity(combined);

  // Try to extract asset name (configurable regex pattern)
  const assetMatch = combined.match(/(?:asset|server|host|device)[:\s]+([^\n,;]+)/i);
  const alertTypeMatch = combined.match(/(?:alert|incident|event)[:\s]+([^\n,;]+)/i);

  return {
    alert_type: alertTypeMatch ? alertTypeMatch[1].trim().substring(0, 100) : 'SOC Alert',
    severity,
    affected_asset: assetMatch ? assetMatch[1].trim().substring(0, 255) : 'Unknown',
    description: body.substring(0, 2000),
  };
};

const pollSocEmails = () => {
  if (!SOC_EMAIL_HOST || !SOC_EMAIL_USER || !SOC_EMAIL_PASSWORD) {
    logger.debug('SOC email not configured — skipping');
    return;
  }

  const imap = new Imap({
    user: SOC_EMAIL_USER,
    password: SOC_EMAIL_PASSWORD,
    host: SOC_EMAIL_HOST,
    port: SOC_EMAIL_PORT,
    tls: SOC_EMAIL_PORT === 993,
    connTimeout: 10000,
    authTimeout: 5000,
  });

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) { logger.error(`IMAP openBox error: ${err.message}`); imap.end(); return; }

      // Search for unseen messages
      imap.search(['UNSEEN'], (err, results) => {
        if (err || !results || results.length === 0) {
          if (results && results.length === 0) logger.debug('SOC email: no new messages');
          else logger.error(`IMAP search error: ${err?.message}`);
          imap.end();
          return;
        }

        logger.info(`SOC email: found ${results.length} new message(s)`);
        const f = imap.fetch(results, { bodies: '' });

        f.on('message', (msg, seqno) => {
          let rawEmail = '';
          msg.on('body', (stream) => {
            stream.on('data', (chunk) => { rawEmail += chunk.toString(); });
            stream.once('end', async () => {
              try {
                const parsed = await simpleParser(rawEmail);
                const subject = parsed.subject || '';
                const textBody = parsed.text || '';
                const fields = extractAlertFields(subject, textBody);

                await query(
                  `INSERT INTO soc_alerts (raw_email_id, alert_type, severity, affected_asset, description, raw_subject, raw_body, received_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                   ON CONFLICT DO NOTHING`,
                  [
                    `${SOC_EMAIL_USER}-${seqno}-${Date.now()}`,
                    fields.alert_type,
                    fields.severity,
                    fields.affected_asset,
                    fields.description,
                    subject.substring(0, 500),
                    textBody.substring(0, 5000),
                    parsed.date || new Date(),
                  ]
                );
              } catch (parseErr) {
                logger.error(`SOC email parse error: ${parseErr.message}`);
              }
            });
          });

          // Mark as seen
          msg.once('attributes', (attrs) => {
            imap.addFlags(attrs.uid, ['\\Seen'], () => {});
          });
        });

        f.once('end', () => { imap.end(); });
      });
    });
  });

  imap.once('error', (err) => {
    logger.error(`IMAP connection error: ${err.message}`);
  });

  imap.connect();
};

module.exports = { pollSocEmails };
