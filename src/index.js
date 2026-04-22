require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('./middleware/errorHandler');
const logger = require('./config/logger');

// ── Startup environment validation ───────────────────────────────────────────
// Fail fast with a clear message rather than a cryptic runtime error later
(function validateEnv() {
  const required = ['JWT_SECRET', 'JWT_REFRESH_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}\nCopy .env.example to .env and fill in all values.`);
    process.exit(1);
  }

  const jwtSecret = process.env.JWT_SECRET || '';
  const jwtRefresh = process.env.JWT_REFRESH_SECRET || '';
  const PLACEHOLDERS = ['change-this-jwt-secret', 'change-this-refresh-secret', 'change-this'];
  const usingWeak = jwtSecret.length < 32 || jwtRefresh.length < 32 ||
    PLACEHOLDERS.some(w => jwtSecret.includes(w) || jwtRefresh.includes(w));
  if (usingWeak) {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: JWT_SECRET / JWT_REFRESH_SECRET are missing or too weak. Run the deploy script to generate strong secrets.');
      process.exit(1);
    } else {
      console.warn('WARNING: JWT secrets are using placeholder values. Change before deploying to production.');
    }
  }
})();

const app = express();

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());

// CORS — supports comma-separated list: FRONTEND_URL=https://app.example.com,https://admin.example.com
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin) and listed origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', code: 'RATE_LIMIT' },
}));
app.use('/api/v1/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.', code: 'RATE_LIMIT' },
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth',         require('./routes/auth'));
app.use('/api/v1/users',        require('./routes/users'));
app.use('/api/v1/applications', require('./routes/applications'));
app.use('/api/v1/checklists',   require('./routes/checklists'));
app.use('/api/v1/infra-checklists', require('./routes/infra-checklists'));
app.use('/api/v1/network',      require('./routes/network'));
app.use('/api/v1/security',     require('./routes/security'));
app.use('/api/v1/vapt',         require('./routes/vapt'));
app.use('/api/v1/projects',     require('./routes/projects'));
app.use('/api/v1/dashboard',    require('./routes/dashboard'));
app.use('/api/v1/audit',        require('./routes/audit'));

// ── Health check (liveness + readiness) ──────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { query } = require('./config/database');
    await query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'connected',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'degraded',
      db: 'disconnected',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  }
});

// ── Wazuh reverse proxy ───────────────────────────────────────────────────────
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

// ── 404 + error handler ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' }));
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  logger.info(`CIO Dashboard API running on port ${PORT}`);
  require('./jobs/poller');
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    try {
      const { closePool } = require('./config/database');
      await closePool();
      logger.info('Database connection closed');
    } catch { /* non-fatal */ }
    logger.info('Server shut down');
    process.exit(0);
  });
  // Force-kill if shutdown takes longer than 10s (e.g. hung DB query)
  setTimeout(() => {
    logger.error('Forced exit after 10s shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Catch unhandled rejections so nodemon doesn't swallow them silently
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

module.exports = app;
