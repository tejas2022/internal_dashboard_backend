const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin, requireAdminOrUser } = require('../middleware/rbac');
const c = require('../controllers/projects.controller');

router.use(authenticate);

router.get('/gantt', requireAdmin, c.getGanttData);
router.get('/workload', requireAdmin, c.getWorkload);
router.get('/deadlines', requireAdmin, c.getUpcomingDeadlines);

router.get('/', requireAdmin, c.listProjects);
router.post('/', requireAdmin, c.createProject);
router.get('/:id', requireAdmin, c.getProject);
router.patch('/:id', requireAdmin, c.updateProject);

router.post('/:project_id/milestones', requireAdmin, c.createMilestone);
router.patch('/milestones/:id', requireAdmin, c.updateMilestone);

router.get('/tasks/list', requireAdminOrUser, c.listTasks);
router.post('/tasks', requireAdminOrUser, c.createTask);
router.get('/tasks/:id', requireAdminOrUser, c.getTask);
router.patch('/tasks/:id', requireAdminOrUser, c.updateTask);
router.delete('/tasks/:id', requireAdminOrUser, c.deleteTask);

module.exports = router;
