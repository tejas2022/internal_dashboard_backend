const { randomUUID } = require('crypto');
const { query } = require('../config/database');
const { auditLog } = require('../middleware/auditLog');

const toDate = v => (v && String(v).trim()) ? v : null;

const listFindings = async (req, res, next) => {
  try {
    const { status, severity, assessment_id, limit = 25, offset = 0 } = req.query;
    let sql = `
      SELECT vf.*, u.name AS assigned_to_name, va.name AS assessment_name
      FROM vapt_findings vf
      LEFT JOIN users u ON vf.assigned_to = u.id
      LEFT JOIN vapt_assessments va ON vf.assessment_id = va.id
      WHERE 1=1
    `;
    const params = [];

    if (status) { params.push(status); sql += ` AND vf.status = $${params.length}`; }
    if (severity) { params.push(severity); sql += ` AND vf.severity = $${params.length}`; }
    if (assessment_id) { params.push(assessment_id); sql += ` AND vf.assessment_id = $${params.length}`; }

    const countResult = await query(sql.replace('SELECT vf.*, u.name AS assigned_to_name, va.name AS assessment_name', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count);

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    sql += ` ORDER BY CASE vf.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, vf.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);
    res.json({ data: result.rows, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) { next(err); }
};

const getFinding = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT vf.*, u.name AS assigned_to_name, va.name AS assessment_name
       FROM vapt_findings vf
       LEFT JOIN users u ON vf.assigned_to = u.id
       LEFT JOIN vapt_assessments va ON vf.assessment_id = va.id
       WHERE vf.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Finding not found', code: 'NOT_FOUND' });
    }
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

const createFinding = async (req, res, next) => {
  try {
    const { title, severity, category, affected_asset, discovery_date, description,
            assigned_to, status, target_remediation_date, assessment_id, evidence_notes } = req.body;

    // Auto-generate finding ID
    const yearStr = new Date().getFullYear();
    const countResult = await query('SELECT COUNT(*) FROM vapt_findings');
    const seq = String(parseInt(countResult.rows[0].count) + 1).padStart(3, '0');
    const findingId = `VAPT-${yearStr}-${seq}`;

    const result = await query(
      `INSERT INTO vapt_findings
       (id, finding_id, assessment_id, title, severity, category, affected_asset, discovery_date,
        description, assigned_to, status, target_remediation_date, evidence_notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [randomUUID(), findingId, assessment_id || null, title, severity, category || 'other', affected_asset,
       toDate(discovery_date), description, assigned_to || null,
       status || 'open', toDate(target_remediation_date), evidence_notes, req.user.id]
    );

    await auditLog(req.user.id, 'CREATE_VAPT_FINDING', 'vapt_findings', result.rows[0].id, { findingId }, req.ip);
    res.status(201).json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

const updateFinding = async (req, res, next) => {
  try {
    const { title, severity, category, affected_asset, discovery_date, description,
            assigned_to, status, target_remediation_date, actual_remediation_date, evidence_notes } = req.body;

    const result = await query(
      `UPDATE vapt_findings SET
         title = COALESCE($1, title),
         severity = COALESCE($2, severity),
         category = COALESCE($3, category),
         affected_asset = COALESCE($4, affected_asset),
         discovery_date = COALESCE($5, discovery_date),
         description = COALESCE($6, description),
         assigned_to = COALESCE($7, assigned_to),
         status = COALESCE($8, status),
         target_remediation_date = COALESCE($9, target_remediation_date),
         actual_remediation_date = COALESCE($10, actual_remediation_date),
         evidence_notes = COALESCE($11, evidence_notes),
         updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [title, severity, category, affected_asset, toDate(discovery_date), description,
       assigned_to || null, status, toDate(target_remediation_date), toDate(actual_remediation_date), evidence_notes, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Finding not found', code: 'NOT_FOUND' });
    }

    await auditLog(req.user.id, 'UPDATE_VAPT_FINDING', 'vapt_findings', req.params.id, req.body, req.ip);
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

const getSummary = async (req, res, next) => {
  try {
    const bySeverity = await query(
      `SELECT severity, COUNT(*) AS count FROM vapt_findings
       WHERE status NOT IN ('closed') GROUP BY severity`
    );

    const byStatus = await query(
      `SELECT status, COUNT(*) AS count FROM vapt_findings GROUP BY status`
    );

    const overdue = await query(
      `SELECT COUNT(*) AS count FROM vapt_findings
       WHERE target_remediation_date < CURRENT_DATE
       AND status NOT IN ('remediated', 'accepted_risk', 'closed')`
    );

    const assessments = await query(
      'SELECT * FROM vapt_assessments ORDER BY assessment_date DESC LIMIT 10'
    );

    res.json({
      data: {
        by_severity: bySeverity.rows,
        by_status: byStatus.rows,
        overdue_count: parseInt(overdue.rows[0].count),
        assessments: assessments.rows,
      }
    });
  } catch (err) { next(err); }
};

const getAgeingReport = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT vf.*, u.name AS assigned_to_name,
              CURRENT_DATE - vf.target_remediation_date AS days_overdue
       FROM vapt_findings vf
       LEFT JOIN users u ON vf.assigned_to = u.id
       WHERE vf.target_remediation_date < CURRENT_DATE
       AND vf.status NOT IN ('remediated', 'accepted_risk', 'closed')
       ORDER BY days_overdue DESC`
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const listAssessments = async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM vapt_assessments ORDER BY assessment_date DESC');
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const createAssessment = async (req, res, next) => {
  try {
    const { name, assessment_date, conducted_by, notes } = req.body;
    const result = await query(
      'INSERT INTO vapt_assessments (id, name, assessment_date, conducted_by, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [randomUUID(), name, assessment_date, conducted_by, notes]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

module.exports = { listFindings, getFinding, createFinding, updateFinding, getSummary, getAgeingReport, listAssessments, createAssessment };
