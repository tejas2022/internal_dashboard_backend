const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const c = require('../controllers/auth.controller');

router.post('/login', c.login);
router.post('/logout', authenticate, c.logout);
router.post('/refresh', c.refresh);
router.post('/change-password', authenticate, c.changePassword);
router.get('/me', authenticate, c.getMe);

module.exports = router;
