const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const c = require('../controllers/security.controller');

router.use(authenticate, requireAdmin);

router.get('/summary', c.getSecuritySummary);
router.get('/wazuh/dashboard', c.getWazuhDashboard);
router.get('/wazuh/alerts', c.getWazuhAlerts);
router.get('/wazuh/summary', c.getWazuhSummary);
router.patch('/wazuh/alerts/:id/acknowledge', c.acknowledgeWazuhAlert);
router.get('/soc/alerts', c.getSocAlerts);
router.patch('/soc/alerts/:id', c.updateSocAlert);

module.exports = router;
