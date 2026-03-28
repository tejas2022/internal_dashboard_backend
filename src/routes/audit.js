const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const c = require('../controllers/audit.controller');

router.use(authenticate, requireAdmin);

router.get('/logs', c.getLogs);

module.exports = router;
