const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const c = require('../controllers/vapt.controller');

router.use(authenticate, requireAdmin);

router.get('/assessments', c.listAssessments);
router.post('/assessments', c.createAssessment);
router.get('/summary', c.getSummary);
router.get('/ageing', c.getAgeingReport);
router.get('/', c.listFindings);
router.get('/:id', c.getFinding);
router.post('/', c.createFinding);
router.patch('/:id', c.updateFinding);

module.exports = router;
