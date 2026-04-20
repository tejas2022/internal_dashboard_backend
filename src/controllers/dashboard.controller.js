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

    // Network summary — wrapped in timeout so a slow full-table scan doesn't block the dashboard
    const networkTimeout = new Promise(resolve =>
      setTimeout(() => resolve({ rows: [{ total_devices: 0, devices_up: 0, devices_down: 0 }] }), 4000)
    );
    const networkQuery = query(
      `SELECT
         COUNT(*) AS total_devices,
         SUM(CASE WHEN s.status = 'up' THEN 1 ELSE 0 END) AS devices_up,
         SUM(CASE WHEN s.status = 'down' THEN 1 ELSE 0 END) AS devices_down
       FROM opmanager_snapshots s
       JOIN (SELECT device_id, MAX(polled_at) AS latest FROM opmanager_snapshots GROUP BY device_id) g
         ON s.device_id = g.device_id AND s.polled_at = g.latest`
    );
    const network = await Promise.race([networkQuery, networkTimeout]);

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

    // Infra BOD compliance today
    const infraCompliance = await query(
      `SELECT
         COUNT(ic.id) AS total_categories,
         COUNT(icl.id) FILTER (WHERE icl.status = 'locked') AS submitted,
         COUNT(icl.id) FILTER (WHERE icl.is_late = true) AS late,
         COALESCE(SUM(
           (SELECT COUNT(*) FROM infra_checklist_items ici
            WHERE ici.infra_checklist_id = icl.id AND ici.result = 'fail')
         ), 0) AS failure_count
       FROM infra_categories ic
       LEFT JOIN infra_checklists icl ON icl.category_id = ic.id AND icl.date = $1
       WHERE ic.is_active = true`,
      [today]
    );

    // Infra BOD per-category health
    const infraHealth = await query(
      `SELECT ic.id, ic.name AS category_name, ic.sort_order,
              icl.status, icl.is_late, icl.submitted_at,
              u.name AS manager_name,
              COUNT(ici.id) FILTER (WHERE ici.result = 'fail') AS failure_count
       FROM infra_categories ic
       LEFT JOIN infra_checklists icl ON icl.category_id = ic.id AND icl.date = $1
       LEFT JOIN infra_checklist_items ici ON ici.infra_checklist_id = icl.id
       LEFT JOIN users u ON ic.manager_user_id = u.id
       WHERE ic.is_active = true
       GROUP BY ic.id, ic.name, ic.sort_order, icl.status, icl.is_late, icl.submitted_at, u.name
       ORDER BY ic.sort_order`,
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
        infra_compliance: infraCompliance.rows[0],
        infra_health: infraHealth.rows,
        date: today,
      }
    });
  } catch (err) { next(err); }
};

const getStakeholderDashboard = async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const toDate = req.query.to_date || today;
    const fromDate = req.query.from_date || null; // null = all time

    // System health — always today's checklist status
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

    // Uptime — computed from status snapshots (rolling 30 days), split by device category
    const uptimeBase = `
      SELECT device_name, device_type,
             ROUND(100.0 * SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2) AS uptime_pct_30d
      FROM opmanager_snapshots
      WHERE polled_at >= NOW() - INTERVAL '30 days'
      GROUP BY device_id, device_name, device_type
      ORDER BY device_name`;

    const [appUptime, networkUptime, infraUptime] = await Promise.all([
      query(`SELECT device_name, uptime_pct_30d FROM (${uptimeBase}) t
             WHERE device_type IS NULL
                OR device_type ~* '(server|application|app|windows|linux|unix|web|host)'
                OR (device_type !~* '(network|router|switch|firewall|wireless|wlan|access.?point|storage|infra|vm|virtual|database|backup|nas|san|esx)')
             LIMIT 15`),
      query(`SELECT device_name, uptime_pct_30d FROM (${uptimeBase}) t
             WHERE device_type ~* '(network|router|switch|firewall|wireless|wlan|access.?point)'
             LIMIT 15`),
      query(`SELECT device_name, uptime_pct_30d FROM (${uptimeBase}) t
             WHERE device_type ~* '(storage|infra|vm|virtual|database|backup|nas|san|esx)'
             LIMIT 15`),
    ]);

    // Security alerts — filtered by date range
    const alerts = fromDate
      ? await query(
          `SELECT 'wazuh' AS source, severity, COUNT(*) AS count FROM wazuh_alerts
           WHERE triggered_at::date BETWEEN $1 AND $2 GROUP BY severity
           UNION ALL
           SELECT 'soc', severity, COUNT(*) FROM soc_alerts WHERE status = 'open' GROUP BY severity`,
          [fromDate, toDate]
        )
      : await query(
          `SELECT 'wazuh' AS source, severity, COUNT(*) AS count FROM wazuh_alerts GROUP BY severity
           UNION ALL
           SELECT 'soc', severity, COUNT(*) FROM soc_alerts WHERE status = 'open' GROUP BY severity`
        );

    // BOD/EOD completion — for toDate
    const checklistRing = await query(
      `SELECT
         COUNT(DISTINCT a.id) AS total,
         COUNT(DISTINCT CASE WHEN c_bod.status = 'locked' THEN a.id END) AS bod_done,
         COUNT(DISTINCT CASE WHEN c_eod.status = 'locked' THEN a.id END) AS eod_done
       FROM applications a
       LEFT JOIN checklists c_bod ON c_bod.application_id = a.id AND c_bod.date = $1 AND c_bod.session = 'BOD'
       LEFT JOIN checklists c_eod ON c_eod.application_id = a.id AND c_eod.date = $1 AND c_eod.session = 'EOD'
       WHERE a.is_active = true`,
      [toDate]
    );

    // Projects — always current status
    const projectsInProgress = await query(
      `SELECT p.id, p.name, p.status, p.priority, p.end_date,
              COUNT(t.id) AS task_count,
              COUNT(t.id) FILTER (WHERE t.status = 'done') AS tasks_done
       FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.status = 'in_progress' GROUP BY p.id ORDER BY p.end_date NULLS LAST`
    );

    // Milestones — due within selected range (default: next 14 days)
    const msFrom = fromDate || today;
    const msTo = fromDate
      ? toDate
      : new Date(new Date(today).getTime() + 14 * 86400000).toISOString().split('T')[0];
    const milestones = await query(
      `SELECT m.name, m.due_date, m.status, p.name AS project_name
       FROM milestones m JOIN projects p ON m.project_id = p.id
       WHERE m.due_date BETWEEN $1 AND $2 AND m.status != 'completed'
       ORDER BY m.due_date`,
      [msFrom, msTo]
    );

    // Achievements — in selected range (default: all time)
    const achievements = fromDate
      ? await query(
          `SELECT t.name, t.updated_at, p.name AS project_name
           FROM tasks t JOIN projects p ON t.project_id = p.id
           WHERE t.status = 'done' AND t.updated_at::date BETWEEN $1 AND $2
           ORDER BY t.updated_at DESC LIMIT 10`,
          [fromDate, toDate]
        )
      : await query(
          `SELECT t.name, t.updated_at, p.name AS project_name
           FROM tasks t JOIN projects p ON t.project_id = p.id
           WHERE t.status = 'done'
           ORDER BY t.updated_at DESC LIMIT 10`
        );

    // VAPT — always current open findings
    const vaptSummary = await query(
      `SELECT severity, COUNT(*) AS count FROM vapt_findings
       WHERE status NOT IN ('remediated','accepted_risk','closed') GROUP BY severity`
    );

    // Team productivity — in range (default: last 7d vs prev 7d)
    const productivity = fromDate
      ? await query(
          `SELECT
             COUNT(*) FILTER (WHERE updated_at::date BETWEEN $1 AND $2 AND status = 'done') AS this_period,
             COUNT(*) FILTER (WHERE status = 'done') AS all_time_done
           FROM tasks`,
          [fromDate, toDate]
        )
      : await query(
          `SELECT
             COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '7 days' AND status = 'done') AS this_week,
             COUNT(*) FILTER (WHERE updated_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days' AND status = 'done') AS last_week
           FROM tasks`
        );

    // Infra BOD today status for stakeholder
    const infraBodToday = await query(
      `SELECT ic.id AS category_id, ic.name AS category_name, ic.sort_order,
              icl.status, icl.is_late,
              COUNT(ici.id) FILTER (WHERE ici.result = 'fail') AS failure_count
       FROM infra_categories ic
       LEFT JOIN infra_checklists icl ON icl.category_id = ic.id AND icl.date = $1
       LEFT JOIN infra_checklist_items ici ON ici.infra_checklist_id = icl.id
       WHERE ic.is_active = true
       GROUP BY ic.id, ic.name, ic.sort_order, icl.status, icl.is_late
       ORDER BY ic.sort_order`,
      [today]
    );

    res.json({
      data: {
        system_health: appHealth.rows[0],
        app_uptime: appUptime.rows,
        network_uptime: networkUptime.rows,
        infra_uptime: infraUptime.rows,
        active_alerts: alerts.rows,
        bod_eod_completion: checklistRing.rows[0],
        infra_bod_today: infraBodToday.rows,
        projects_in_progress: projectsInProgress.rows,
        upcoming_milestones: milestones.rows,
        recent_achievements: achievements.rows,
        vapt_open_findings: vaptSummary.rows,
        team_productivity: productivity.rows[0],
        last_updated: new Date().toISOString(),
        filter: { from_date: fromDate, to_date: toDate },
      }
    });
  } catch (err) { next(err); }
};

const getComplianceTrends = async (req, res, next) => {
  try {
    // Daily BOD submission rate — last 60 days
    const trend = await query(`
      SELECT
        c.date::text AS date,
        COUNT(DISTINCT c.application_id) AS submitted,
        SUM(CASE WHEN ci.result = 'pass' THEN 1 ELSE 0 END) AS pass_count,
        SUM(CASE WHEN ci.result = 'fail' THEN 1 ELSE 0 END) AS fail_count,
        COUNT(ci.id) AS total_items
      FROM checklists c
      JOIN checklist_items ci ON ci.checklist_id = c.id
      WHERE c.session = 'BOD'
        AND c.date >= CURRENT_DATE - 60
      GROUP BY c.date
      ORDER BY c.date ASC
    `);

    // Pass rate by application (last 60 days)
    const appRates = await query(`
      SELECT
        a.name,
        COUNT(ci.id) FILTER (WHERE ci.result = 'pass') AS pass_count,
        COUNT(ci.id) FILTER (WHERE ci.result = 'fail') AS fail_count,
        COUNT(ci.id) AS total_count
      FROM applications a
      JOIN checklists c ON c.application_id = a.id AND c.session = 'BOD'
        AND c.date >= CURRENT_DATE - 60
      JOIN checklist_items ci ON ci.checklist_id = c.id
      WHERE a.is_active = true
      GROUP BY a.id, a.name
      ORDER BY a.name
    `);

    res.json({
      data: {
        daily_trend: trend.rows.map(r => ({
          date: r.date,
          submitted: parseInt(r.submitted),
          pass_count: parseInt(r.pass_count),
          fail_count: parseInt(r.fail_count),
          total_items: parseInt(r.total_items),
          pass_rate: r.total_items > 0 ? Math.round((r.pass_count / r.total_items) * 100) : 0,
        })),
        app_pass_rates: appRates.rows.map(r => ({
          name: r.name,
          pass_count: parseInt(r.pass_count),
          fail_count: parseInt(r.fail_count),
          total_count: parseInt(r.total_count),
          pass_rate: r.total_count > 0 ? Math.round((r.pass_count / r.total_count) * 100) : 0,
        })),
      }
    });
  } catch (err) { next(err); }
};

module.exports = { getCioDashboard, getStakeholderDashboard, getComplianceTrends };
