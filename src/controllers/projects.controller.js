const { randomUUID } = require('crypto');
const toDate = v => (v && String(v).trim()) ? v : null;
const { query } = require('../config/database');
const { auditLog } = require('../middleware/auditLog');

// ---- Projects ----
const listProjects = async (req, res, next) => {
  try {
    const { status, priority } = req.query;
    let sql = `
      SELECT p.*, u.name AS owner_name,
             COUNT(DISTINCT t.id) AS task_count,
             COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'done') AS tasks_done
      FROM projects p
      LEFT JOIN users u ON p.owner_id = u.id
      LEFT JOIN tasks t ON t.project_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (status) { params.push(status); sql += ` AND p.status = $${params.length}`; }
    if (priority) { params.push(priority); sql += ` AND p.priority = $${params.length}`; }
    sql += ' GROUP BY p.id, u.name ORDER BY p.created_at DESC';
    const result = await query(sql, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const getProject = async (req, res, next) => {
  try {
    const project = await query(
      `SELECT p.*, u.name AS owner_name FROM projects p
       LEFT JOIN users u ON p.owner_id = u.id WHERE p.id = $1`,
      [req.params.id]
    );
    if (project.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    }

    const milestones = await query(
      'SELECT * FROM milestones WHERE project_id = $1 ORDER BY sort_order, due_date',
      [req.params.id]
    );

    const tasks = await query(
      `SELECT t.*, u.name AS assigned_to_name, m.name AS milestone_name
       FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
       LEFT JOIN milestones m ON t.milestone_id = m.id
       WHERE t.project_id = $1 ORDER BY t.priority DESC, t.due_date`,
      [req.params.id]
    );

    res.json({ data: { ...project.rows[0], milestones: milestones.rows, tasks: tasks.rows } });
  } catch (err) { next(err); }
};

const createProject = async (req, res, next) => {
  try {
    const { name, description, status, priority, owner_id, start_date, end_date, tags } = req.body;
    const result = await query(
      `INSERT INTO projects (id, name, description, status, priority, owner_id, start_date, end_date, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), name, description, status || 'not_started', priority || 'medium',
       owner_id || req.user.id, start_date || null, end_date || null, tags || []]
    );
    await auditLog(req.user.id, 'CREATE_PROJECT', 'projects', result.rows[0].id, { name }, req.ip);
    res.status(201).json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

const updateProject = async (req, res, next) => {
  try {
    const { name, description, status, priority, owner_id, start_date, end_date, tags } = req.body;
    const result = await query(
      `UPDATE projects SET name=COALESCE($1,name), description=COALESCE($2,description),
       status=COALESCE($3,status), priority=COALESCE($4,priority), owner_id=COALESCE($5,owner_id),
       start_date=COALESCE($6,start_date), end_date=COALESCE($7,end_date),
       tags=COALESCE($8,tags), updated_at=NOW() WHERE id=$9 RETURNING *`,
      [name, description, status, priority, owner_id, start_date, end_date, tags, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    await auditLog(req.user.id, 'UPDATE_PROJECT', 'projects', req.params.id, req.body, req.ip);
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

// ---- Milestones ----
const createMilestone = async (req, res, next) => {
  try {
    const { project_id } = req.params;
    const { name, description, due_date, status, sort_order } = req.body;
    const result = await query(
      `INSERT INTO milestones (id, project_id, name, description, due_date, status, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), project_id, name, description, due_date || null, status || 'not_started', sort_order || 0]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

const updateMilestone = async (req, res, next) => {
  try {
    const { name, description, due_date, status, sort_order } = req.body;
    const result = await query(
      `UPDATE milestones SET name=COALESCE($1,name), description=COALESCE($2,description),
       due_date=COALESCE($3,due_date), status=COALESCE($4,status), sort_order=COALESCE($5,sort_order),
       updated_at=NOW() WHERE id=$6 RETURNING *`,
      [name, description, due_date, status, sort_order, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Milestone not found', code: 'NOT_FOUND' });
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

// ---- Tasks ----
const listTasks = async (req, res, next) => {
  try {
    const { project_id, assigned_to, status, priority, mine } = req.query;
    let sql = `
      SELECT t.*, u.name AS assigned_to_name, p.name AS project_name, m.name AS milestone_name
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN milestones m ON t.milestone_id = m.id
      WHERE 1=1
    `;
    const params = [];

    // Non-admin always sees only own tasks; admin sees own tasks when mine=true
    if (req.user.role !== 'admin' || mine === 'true') {
      params.push(req.user.id);
      sql += ` AND t.assigned_to = $${params.length}`;
    }

    if (project_id) { params.push(project_id); sql += ` AND t.project_id = $${params.length}`; }
    if (assigned_to && req.user.role === 'admin' && mine !== 'true') { params.push(assigned_to); sql += ` AND t.assigned_to = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND t.status = $${params.length}`; }
    if (priority) { params.push(priority); sql += ` AND t.priority = $${params.length}`; }

    sql += ' ORDER BY t.due_date ASC NULLS LAST, t.priority DESC';
    const result = await query(sql, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const getTask = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT t.*, u.name AS assigned_to_name, p.name AS project_name, m.name AS milestone_name
       FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
       LEFT JOIN projects p ON t.project_id = p.id
       LEFT JOIN milestones m ON t.milestone_id = m.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });

    const task = result.rows[0];
    if (req.user.role !== 'admin' && task.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied', code: 'FORBIDDEN' });
    }
    res.json({ data: task });
  } catch (err) { next(err); }
};

const createTask = async (req, res, next) => {
  try {
    const { project_id, milestone_id, name, description, assigned_to, priority,
            status, start_date, due_date, estimated_hours, tags, blockers } = req.body;
    // Non-admin users can only create tasks assigned to themselves
    // Admin defaults to themselves if no assignee is selected
    const resolvedAssignee = assigned_to || req.user.id;
    const result = await query(
      `INSERT INTO tasks (id, project_id, milestone_id, name, description, assigned_to, reported_by,
       priority, status, start_date, due_date, estimated_hours, tags, blockers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [randomUUID(), project_id || null, milestone_id || null, name, description,
       resolvedAssignee, req.user.id,
       priority || 'medium', status || 'todo', toDate(start_date), toDate(due_date),
       estimated_hours || null, tags || [], blockers || null]
    );
    await auditLog(req.user.id, 'CREATE_TASK', 'tasks', result.rows[0].id, { name, project_id }, req.ip);
    res.status(201).json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

const updateTask = async (req, res, next) => {
  try {
    const task = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (task.rows.length === 0) return res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });

    if (req.user.role !== 'admin' && task.rows[0].assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied', code: 'FORBIDDEN' });
    }

    const { name, description, assigned_to, priority, status, start_date, due_date,
            estimated_hours, actual_hours, tags, blockers, milestone_id } = req.body;

    const result = await query(
      `UPDATE tasks SET name=COALESCE($1,name), description=COALESCE($2,description),
       assigned_to=COALESCE($3,assigned_to), priority=COALESCE($4,priority),
       status=COALESCE($5,status), start_date=COALESCE($6,start_date),
       due_date=COALESCE($7,due_date), estimated_hours=COALESCE($8,estimated_hours),
       actual_hours=COALESCE($9,actual_hours), tags=COALESCE($10,tags),
       blockers=COALESCE($11,blockers), milestone_id=COALESCE($12,milestone_id), updated_at=NOW()
       WHERE id=$13 RETURNING *`,
      [name, description, assigned_to || null, priority, status, toDate(start_date), toDate(due_date),
       estimated_hours || null, actual_hours || null, tags, blockers || null, milestone_id || null, req.params.id]
    );

    await auditLog(req.user.id, 'UPDATE_TASK', 'tasks', req.params.id, req.body, req.ip);
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
};

const deleteTask = async (req, res, next) => {
  try {
    const task = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (task.rows.length === 0) return res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });

    const t = task.rows[0];
    // Admin can delete any task; non-admin can only delete tasks they created themselves
    if (req.user.role !== 'admin' && t.reported_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete tasks you created yourself', code: 'FORBIDDEN' });
    }

    await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    await auditLog(req.user.id, 'DELETE_TASK', 'tasks', req.params.id, { name: t.name }, req.ip);
    res.json({ message: 'Task deleted' });
  } catch (err) { next(err); }
};

const getGanttData = async (req, res, next) => {
  try {
    const projects = await query(
      `SELECT p.id, p.name, p.start_date, p.end_date, p.status, p.priority
       FROM projects p WHERE p.status NOT IN ('cancelled', 'completed') ORDER BY p.start_date`
    );

    const tasks = await query(
      `SELECT t.id, t.project_id, t.milestone_id, t.name, t.start_date, t.due_date,
              t.status, t.priority, t.assigned_to, u.name AS assigned_to_name, t.actual_hours,
              t.estimated_hours
       FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
       WHERE t.start_date IS NOT NULL AND t.due_date IS NOT NULL
       ORDER BY t.start_date`
    );

    res.json({ data: { projects: projects.rows, tasks: tasks.rows } });
  } catch (err) { next(err); }
};

const getWorkload = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.email,
              COUNT(t.id) AS total_tasks,
              COUNT(t.id) FILTER (WHERE t.status = 'in_progress') AS in_progress,
              COUNT(t.id) FILTER (WHERE t.status = 'blocked') AS blocked,
              COUNT(t.id) FILTER (WHERE t.status = 'todo') AS todo,
              COUNT(t.id) FILTER (WHERE t.due_date < CURRENT_DATE AND t.status != 'done') AS overdue
       FROM users u
       LEFT JOIN tasks t ON t.assigned_to = u.id AND t.status != 'done'
       WHERE u.role IN ('admin', 'user') AND u.is_active = true
       GROUP BY u.id, u.name, u.email ORDER BY u.name`
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
};

const getUpcomingDeadlines = async (req, res, next) => {
  try {
    const { days = 14 } = req.query;
    const tasks = await query(
      `SELECT t.id, t.name, t.due_date, t.priority, t.status, p.name AS project_name, u.name AS assigned_to_name
       FROM tasks t LEFT JOIN projects p ON t.project_id = p.id LEFT JOIN users u ON t.assigned_to = u.id
       WHERE t.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
       AND t.status NOT IN ('done') ORDER BY t.due_date`,
      [parseInt(days)]
    );

    const milestones = await query(
      `SELECT m.id, m.name, m.due_date, m.status, p.name AS project_name
       FROM milestones m JOIN projects p ON m.project_id = p.id
       WHERE m.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
       AND m.status != 'completed' ORDER BY m.due_date`,
      [parseInt(days)]
    );

    res.json({ data: { tasks: tasks.rows, milestones: milestones.rows } });
  } catch (err) { next(err); }
};

module.exports = {
  listProjects, getProject, createProject, updateProject,
  createMilestone, updateMilestone,
  listTasks, getTask, createTask, updateTask, deleteTask,
  getGanttData, getWorkload, getUpcomingDeadlines
};
