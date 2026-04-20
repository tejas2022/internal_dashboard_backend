const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin, requireAdminOrUser } = require('../middleware/rbac');
const c = require('../controllers/infra-checklists.controller');

router.use(authenticate);

router.get('/categories',             c.getCategories);
router.get('/my-categories',          requireAdminOrUser, c.getMyCategories);
router.patch('/categories/:id/assign', requireAdmin,       c.assignCategory);
router.get('/templates',              c.getTemplates);
router.get('/today',                  c.getTodaySummary);
router.get('/',                       requireAdminOrUser, c.listChecklists);
router.get('/:id',                    requireAdminOrUser, c.getChecklist);
router.post('/',                      requireAdminOrUser, c.submitChecklist);

module.exports = router;
