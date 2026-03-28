const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin, requireAnyRole } = require('../middleware/rbac');
const c = require('../controllers/dashboard.controller');

router.use(authenticate);

router.get('/summary', requireAdmin, c.getCioDashboard);
router.get('/stakeholder', requireAnyRole, c.getStakeholderDashboard);

module.exports = router;
