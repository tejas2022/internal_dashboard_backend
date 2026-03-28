const logger = require('../config/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(err.message, { stack: err.stack, path: req.path });

  if (err.code === '23505') {
    return res.status(409).json({ error: 'Duplicate entry — resource already exists', code: 'CONFLICT' });
  }
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced resource not found', code: 'FOREIGN_KEY_ERROR' });
  }

  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;

  res.status(status).json({ error: message, code: err.code || 'INTERNAL_ERROR' });
};

module.exports = { errorHandler };
