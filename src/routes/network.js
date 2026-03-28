const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const c = require('../controllers/network.controller');

router.use(authenticate, requireAdmin);

router.get('/summary', c.getNetworkSummary);
router.get('/devices', c.getDevices);
router.get('/devices/:device_id/history', c.getDeviceHistory);
router.get('/alarms', c.getAlarms);
router.get('/uptime', c.getUptime);
router.get('/widgets', c.getWidgets);

module.exports = router;
