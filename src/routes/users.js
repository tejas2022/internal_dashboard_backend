const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const c = require('../controllers/users.controller');

router.use(authenticate);

router.get('/', requireAdmin, c.listUsers);
router.get('/managers', c.getApplicationManagers);
router.get('/:id', requireAdmin, c.getUser);
router.post('/', requireAdmin, c.createUser);
router.patch('/:id', requireAdmin, c.updateUser);
router.post('/:id/reset-password', requireAdmin, c.resetUserPassword);

module.exports = router;
