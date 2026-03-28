const { query } = require('../config/database');

const getCioDashboard = async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Application health
    const appHealth = await query(
      `SELECT a.id, a.name, a.type,
              MAX(CASE WHEN c.session = 'BOD' THEN c.status END) AS bod_status,
              MAX(CASE WHEN c.session = 'EOD' THEN c.status END) AS eod_status,
              COUNT(DISTINCT ci.id) FILTER (WHERE ci.result = 'fail') AS failures_today
       FROM applications a
       LEFT JOIN checklists c ON c.application_id = a.id AND c.date = $1
       LEFT JOIN checklist_items ci ON ci.checklist_id = c.id
       WHERE a.is_active = true
       GROUP BY a.id, a.name, a.type
       ORDER BY a.name`,
      [today]
    );

    // Network summary
    const network = await query(
      `SELECT
         COUNT(DISTINCT device_id) AS total_devices,
         COUNT(DISTINCT device_id) FILTER (WHERE status = 'up') AS devices_up,
         COUNT(DISTINCT device_id) FILTER (WHERE status = 'down') AS devices_down
       FROM (
         SELECT DISTINCT ON (device_id) device_id, status
         FROM opmanager_snapshots ORDER BY device_id, polled_at DESC
       ) AS latest`
    );

    const activeAlarms = await query(
      'SELECT COUNT(*) AS count FROM opmanager_alarms WHERE is_active = true'
    );

    // Security summary
    const wazuh24h = await query(
      `SELECT COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
              COUNT(*) FILTER (WHERE severity = 'high') AS high,
              COUNT(*) FILTER (WHERE severity = 'medium') AS medium,
              COUNT(*) AS total
       FROM wazuh_alerts WHERE triggered_at >= NOW() - INTERVAL '24 hours'`
    );

    const socOpen = await query(
      "SELECT COUNT(*) AS count FROM soc_alerts WHERE status = 'open'"
    );

    // VAPT summary
    const vapt = await query(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('remediated','accepted_risk','closed')) AS open_findings,
              COUNT(*) FILTER (WHERE severity = 'critical' AND status NOT IN ('remediated','accepted_risk','closed')) AS critical_open
       FROM vapt_findings`
    );

    // Projects summary
    const projects = await query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
              COUNT(*) FILTER (WHERE status = 'on_hold') AS on_hold,
              COUNT(*) FILTER (WHERE end_date < CURRENT_DATE AND status NOT IN ('completed','cancelled')) AS overdue
       FROM projects`
    );

    // Tasks summary
    const tasks = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'blocked') AS blocked,
              COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status != 'done') AS overdue,
              COUNT(*) FILTER (WHERE status = 'done' AND updated_at >= NOW() - INTERVAL '7 days') AS completed_this_week
       FROM tasks`
    );

    // Checklist compliance today
    const checklistCompliance = await query(
      `SELECT
         COUNT(DISTINCT a.id) AS total_apps,
         COUNT(DISTINCT CASE WHEN c.session = 'BOD' AND c.status = 'locked' THEN a.id END) AS bod_submitted,
         COUNT(DISTINCT CASE WHEN c.session = 'EOD' AND c.status = 'locked' THEN a.id END) AS eod_submitted
       FROM applications a
       LEFT JOIN checklists c ON c.application_id = a.id AND c.date = $1
       WHERE a.is_active = true`,
      [today]
    );

    res.json({
      data: {
        application_health: appHealth.rows,
        network: {
          ...network.rows[0],
          active_alarms: parseInt(activeAlarms.rows[0].count),
        },
        security: {
          wazuh_24h: wazuh24h.rows[0],
          soc_open: parseInt(socOpen.rows[0].count),
        },
        vapt: vapt.rows[0],
        projects: projects.rows[0],
        tasks: tasks.rows[0],
        checklist_compliance: checklistCompliance.rows[0],
        date: today,
      }
    });
  } catch (err) { next(err); }
};

const getStakeholderDashboard = async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // System health overview
    const appHealth = await query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE failures_today = 0 AND bod_status = 'locked') AS green,
         COUNT(*) FILTER (WHERE failures_today > 0) AS red,
         COUNT(*) FILTER (WHERE bod_status IS NULL) AS not_submitted
       FROM (
         SELECT a.id,
           MAX(CASE WHEN c.session = 'BOD' THEN c.status END) AS bod_status,
           COUNT(ci.id) FILTER (WHERE ci.result = 'fail') AS failures_today
         FROM applications a
         LEFT JOIN checklists c ON c.application_id = a.id AND c.date = $1
         LEFT JOIN checklist_items ci ON ci.checklist_id = c.id
         WHERE a.is_active = true GROUP BY a.id
       ) app_summary`,
      [today]
    );

    // 30-day uptime
    const uptime = await query(
      `SELECT DISTINCT ON (device_id) device_name, uptime_pct_30d
       FROM opmanager_snapshots ORDER BY device_id, polled_at DESC LIMIT 10`
    );

    // Active alerts
    const alerts = await query(
      `SELECT 'wazuh' AS source, severity, COUNT(*) AS count FROM wazuh_alerts
       WHERE triggered_at >= NOW() - INTERVAL '24 hours' GROUP BY severity
       UNION ALL
       SELECT 'soc', severity, COUNT(*) FROM soc_alerts WHERE status = 'open' GROUP BY severity`
    );

    // BOD/EOD completion
    const checklistRing = await query(
      `SELECT
         COUNT(DISTINCT a.id) AS total,
         COUNT(DISTINCT CASE WHEN c_bod.status = 'locked' THEN a.id END) AS bod_done,
         COUNT(DISTINCT CASE WHEN c_eod.status = 'locked' THEN a.id END) AS eod_done
       FROM applications a
       LEFT JOIN checklists c_bod ON c_bod.application_id = a.id AND c_bod.date = $1 AND c_bod.session = 'BOD'
       LEFT JOIN checklists c_eod ON c_eod.application_id = a.id AND c_eod.date = $1 AND c_eod.session = 'EOD'
       WHERE a.is_active = true`,
      [today]
    );

    // Projects in progress
    const projectsInProgress = await query(
      `SELECT p.id, p.name, p.status, p.priority, p.end_date,
              COUNT(t.id) AS task_count,
              COUNT(t.id) FILTER (WHERE t.status = 'done') AS tasks_done
       FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.status = 'in_progress' GROUP BY p.id ORDER BY p.end_date NULLS LAST`
    );

    // Upcoming milestones (14 days)
    const milestones = await query(
      `SELECT m.name, m.due_date, m.status, p.name AS project_name
       FROM milestones m JOIN projects p ON m.project_id = p.id
       WHERE m.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
       AND m.status != 'completed' ORDER BY m.due_date`
    );

    // Recent achievements (30 days)
    const achievements = await query(
      `SELECT t.name, t.updated_at, p.name AS project_name
       FROM tasks t JOIN projects p ON t.project_id = p.id
       WHERE t.status = 'done' AND t.updated_at >= NOW() - INTERVAL '30 days'
       ORDER BY t.updated_at DESC LIMIT 10`
    );

    // VAPT
    const vaptSummary = await query(
      `SELECT severity, COUNT(*) AS count FROM vapt_findings
       WHERE status NOT IN ('remediated','accepted_risk','closed') GROUP BY severity`
    );

    // Team productivity
    const productivity = await query(
      `SELECT
         COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '7 days' AND status = 'done') AS this_week,
         COUNT(*) FILTER (WHERE updated_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days' AND status = 'done') AS last_week
       FROM tasks`
    );

    res.json({
      data: {
        system_health: appHealth.rows[0],
        uptime_30d: uptime.rows,
        active_alerts: alerts.rows,
        bod_eod_completion: checklistRing.rows[0],
        projects_in_progress: projectsInProgress.rows,
        upcoming_milestones: milestones.rows,
        recent_achievements: achievements.rows,
        vapt_open_findings: vaptSummary.rows,
        team_productivity: productivity.rows[0],
        last_updated: new Date().toISOString(),
      }
    });
  } catch (err) { next(err); }
};

module.exports = { getCioDashboard, getStakeholderDashboard };
