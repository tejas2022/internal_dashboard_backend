// Role-based access control middleware
// Enforced at route level, not controller level

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions', code: 'FORBIDDEN' });
    }
    next();
  };
};

const requireAdmin = requireRole('admin');
const requireAdminOrUser = requireRole('admin', 'user');
const requireAnyRole = requireRole('admin', 'user', 'stakeholder');

module.exports = { requireRole, requireAdmin, requireAdminOrUser, requireAnyRole };
