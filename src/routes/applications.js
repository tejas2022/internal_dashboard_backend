const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const c = require('../controllers/applications.controller');

router.use(authenticate);

router.get('/', requireAdmin, c.listApplications);
router.get('/mine', c.getApplicationsForUser);
router.get('/:id', requireAdmin, c.getApplication);
router.post('/', requireAdmin, c.createApplication);
router.patch('/:id', requireAdmin, c.updateApplication);
router.delete('/:id', requireAdmin, c.deleteApplication);

module.exports = router;
