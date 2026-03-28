require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('./middleware/errorHandler');
const logger = require('./config/logger');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests', code: 'RATE_LIMIT' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts', code: 'RATE_LIMIT' },
});
app.use('/api/', limiter);
app.use('/api/v1/auth/login', authLimiter);

// Routes
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/applications', require('./routes/applications'));
app.use('/api/v1/checklists', require('./routes/checklists'));
app.use('/api/v1/network', require('./routes/network'));
app.use('/api/v1/security', require('./routes/security'));
app.use('/api/v1/vapt', require('./routes/vapt'));
app.use('/api/v1/projects', require('./routes/projects'));
app.use('/api/v1/dashboard', require('./routes/dashboard'));
app.use('/api/v1/audit', require('./routes/audit'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Wazuh dashboard reverse proxy — strips X-Frame-Options so it embeds cleanly
if (process.env.WAZUH_DASHBOARD_URL) {
  const { createProxyMiddleware } = require('http-proxy-middleware');
  app.use('/wazuh-proxy', createProxyMiddleware({
    target: process.env.WAZUH_DASHBOARD_URL,
    changeOrigin: true,
    secure: false,
    pathRewrite: { '^/wazuh-proxy': '' },
    on: {
      proxyRes(proxyRes) {
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
      },
    },
  }));
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`CIO Dashboard API running on port ${PORT}`);

  // Start background polling jobs
  require('./jobs/poller');
});

module.exports = app;
