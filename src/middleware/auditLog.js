const { randomUUID } = require('crypto');
const { query } = require('../config/database');

const auditLog = async (userId, action, entityType, entityId, payload, ipAddress) => {
  try {
    await query(
      `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), userId, action, entityType, entityId, JSON.stringify(payload), ipAddress]
    );
  } catch (err) {
    // Audit log failures should not break the main flow
    console.error('Audit log error:', err.message);
  }
};

module.exports = { auditLog };
