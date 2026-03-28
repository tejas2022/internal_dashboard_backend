const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin, requireAdminOrUser } = require('../middleware/rbac');
const c = require('../controllers/checklists.controller');

router.use(authenticate);

router.get('/templates', c.getChecklistTemplates);
router.get('/today', c.getTodaySummary);
router.get('/health', requireAdmin, c.getHealthSummary);
router.get('/', requireAdminOrUser, c.listChecklists);
router.get('/:id', requireAdminOrUser, c.getChecklist);
router.post('/', requireAdminOrUser, c.submitChecklist);

module.exports = router;
