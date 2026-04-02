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

// ─── Checklist template migration ────────────────────────────────────────────
async function runChecklistTemplateMigration(p, log) {
  const { randomUUID } = require('crypto');
  try {
    // Add application_id column if missing
    try {
      await p.query('ALTER TABLE checklist_templates ADD COLUMN application_id UUID REFERENCES applications(id) ON DELETE CASCADE');
      log.info('[migration] Added application_id to checklist_templates');
    } catch (_) { /* column already exists */ }

    // Skip if already migrated (templates linked to specific apps)
    const check = await p.query('SELECT COUNT(*) FROM checklist_templates WHERE application_id IS NOT NULL');
    if (parseInt(check.rows[0].count) > 0) {
      log.info('[migration] Checklist templates already migrated — skipping');
      return;
    }

    // Fetch app IDs
    const apps = await p.query("SELECT id, name FROM applications WHERE name IN ('Odin-PCG','Odin_Retail','Omnesys')");
    const byName = {};
    apps.rows.forEach(a => { byName[a.name] = a.id; });
    if (Object.keys(byName).length === 0) { log.warn('[migration] No matching apps found — skipping template seed'); return; }

    // Clear generic templates
    await p.query('DELETE FROM checklist_templates');

    const insert = async (appId, labels) => {
      const seen = new Set(); let order = 1;
      for (const label of labels) {
        if (!label) continue;
        const raw = String(label).trim(); if (!raw) continue;
        let key = raw.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().replace(/^_+|_+$/g, '');
        if (!key) continue;
        if (seen.has(key)) key += '_' + order; seen.add(key);
        await p.query('INSERT INTO checklist_templates (id,application_id,application_type,session,item_key,label,sort_order,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,true)',
          [randomUUID(), appId, 'trading', 'BOD', key, raw, order++]);
      }
      return order - 1;
    };

    const OMNESYS = ['nest_mrv_surveillance_alert','nest_file_digestor','nest_syom_algo','nest_adptr_nse_brdcst_tl_nse_cm','nest_bcastc_nse_fo','nest_algo_engine','nest_msg','nest_sinker_nse_fo_19432','nest_adptr_bse_cm_18200222','nest_adptr_nse_brdcst_lp_nse_fo','nest_bcastc_bse_cm_tl','nest_srs','nest_vwapc_bse_cm','nest_tom','nest_fixs_connector_BLPFUTP','nest_mrv_algo_id_category','nest_bcastc_nse_cm','nest_fixs_connector_BLPEQTY','nest_adptr_nse_brdcst_lp_nse_cm','nest_fixs_connector_BLPEQT','nest_sinker_nse_fo_29446','nest_sor','nest_adptr_dc_nse_cm_33165','nest_nlm','nest_rs_p (Span )','nest_bcastc_bse_cm','nest_sinker_bse_cm_18200222','nest_sinker_nse_cm_33165','nest_vwapc_nse_fo','nest_mrv_srs_rejection_list','nest_basket_alert','nest_login_manager_1','nest_om_order','nest_adptr_bse_cm_nfcast_tl','nest_algos_twap','nest_mkt_bell','nest_rs','nest_vwapc_nse_cm','nest_adptr_dc_nse_fo_29446','nest_fixs_connector_BLPRS','nest_mailer','nest_bm','nest_fixs_connector_BLPOPT','nest_adptr_nse_brdcst_tl_nse_fo','nest_adptr_bse_cm_nfcast','nest_active_clients','nest_fixs_connector_BLPFUT'];
    const ODIN = ['OdinManager','NSEFCM-Interactive','NSEFAO-Interactive','NSECDS-Interactive','NSESLBM-Interactive','NSEOFS-Interactive','NSEFCM-Broadcast','NSEFAO-Broadcast','NSECDS-Broadcast','NSESLBM-Broadcast','NSEFCM-Broadcast-2','BSEFCM-Broadcast','BSEFAO-Broadcast','NCDEX-Interactive','NCDEX-Broadcast','BSEFCM-Interactive','BSEFAO-Interactive','MCX-Interactive','MCX-Broadcast','ODINConnect','WEBFEED-Handler','Diet-Login','Dealar-Login','Mobile-login'];

    if (byName['Omnesys']) { const n = await insert(byName['Omnesys'], OMNESYS); log.info(`[migration] Omnesys: ${n} checklist items`); }
    if (byName['Odin-PCG']) { const n = await insert(byName['Odin-PCG'], ODIN); log.info(`[migration] Odin-PCG: ${n} checklist items`); }
    if (byName['Odin_Retail']) { const n = await insert(byName['Odin_Retail'], ODIN); log.info(`[migration] Odin_Retail: ${n} checklist items`); }

    log.info('[migration] Checklist template migration complete');
  } catch (err) {
    log.error('[migration] Checklist template migration failed:', err.message);
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

  // ─── Checklist template migration ─────────────────────────────────────────
  await runChecklistTemplateMigration(p, logger);

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
