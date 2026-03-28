require('dotenv').config();
const path = require('path');
const fs = require('fs');

let logger;
try {
  logger = require('./logger');
} catch (e) {
  logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log };
}

let pool = null;
let _poolReady = null;

// ─── Real PostgreSQL ──────────────────────────────────────────────────────────
function initRealPool() {
  const { Pool } = require('pg');
  const p = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'cio_dashboard',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  p.on('error', (err) => logger.error('PG pool error:', err.message));
  return p.query('SELECT 1').then(() => {
    logger.info('Connected to PostgreSQL');
    pool = p;
    return p;
  });
}

// ─── Execute SQL file statement-by-statement ──────────────────────────────────
async function execSqlFile(p, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const lines = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const statements = lines.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of statements) {
    try {
      await p.query(stmt);
    } catch (err) {
      logger.warn(`[pglite] Skipped statement: ${err.message.split('\n')[0]}`);
    }
  }
}

// ─── PGlite persistent fallback ───────────────────────────────────────────────
async function initPGlitePool() {
  const { PGlite } = await import('@electric-sql/pglite');

  const dataDir = path.join(__dirname, '..', '..', 'data', 'pgdata');
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new PGlite(`file://${dataDir}`);
  await db.waitReady;

  // Wrap pglite as a pool-like interface (same API as pg.Pool)
  const p = {
    query: (text, params) => db.query(text, params),
    // getClient — pglite is single-connection so BEGIN/COMMIT pass through directly
    connect: () => Promise.resolve({
      query: (text, params) => db.query(text, params),
      release: () => Promise.resolve(),
    }),
  };

  // Only apply schema + seed on a fresh database (users table won't exist yet)
  let isNew = false;
  try {
    await db.query('SELECT 1 FROM users LIMIT 1');
  } catch {
    isNew = true;
  }

  if (isNew) {
    logger.info('[pglite] Fresh database — applying schema and seed...');
    await execSqlFile(p, path.join(__dirname, '../db/schema.sql'));
    await execSqlFile(p, path.join(__dirname, '../db/seed.sql'));
    logger.info('[pglite] Schema and seed applied.');
  } else {
    logger.info('[pglite] Existing database found — data preserved.');
  }

  logger.info(`[pglite] Persistent database at: ${dataDir}`);
  pool = p;
  return p;
}

// ─── Pool initialiser ─────────────────────────────────────────────────────────
function ensurePool() {
  if (!_poolReady) {
    _poolReady = initRealPool().catch(async (err) => {
      logger.warn(`PostgreSQL unavailable (${err.message}). Falling back to persistent pglite database.`);
      return initPGlitePool();
    });
  }
  return _poolReady;
}

ensurePool().catch((err) => logger.error('Fatal: DB initialization failed:', err.message));

// ─── Exports ──────────────────────────────────────────────────────────────────
const query = async (text, params) => {
  await ensurePool();
  return pool.query(text, params);
};

const getClient = async () => {
  await ensurePool();
  return pool.connect();
};

module.exports = { query, getClient, get pool() { return pool; } };
