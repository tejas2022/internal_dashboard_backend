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

// ─── Historical BOD data import from xlsx ────────────────────────────────────
async function runHistoricalDataImport(p, log) {
  try {
    const fs = require('fs'); const { randomUUID } = require('crypto');
    const xlsxPath = path.join(__dirname, '..', '..', '..', 'BOD_Checklist_OmneSys.xlsx');
    if (!fs.existsSync(xlsxPath)) { log.info('[import] xlsx files not found — skipping historical import'); return; }

    const existing = await p.query("SELECT COUNT(*) FROM checklists WHERE status='locked'");
    if (parseInt(existing.rows[0].count) > 10) { log.info('[import] Historical data already present — skipping'); return; }

    let XLSX; try { XLSX = require('xlsx'); } catch { log.warn('[import] xlsx module not available'); return; }

    const excelToISO = n => { const d = new Date(Math.round((n - 25569) * 86400000)); return d.toISOString().split('T')[0]; };
    const toResult = v => { const s = String(v||'').toLowerCase().trim(); if(s==='pass') return 'pass'; if(s==='fail') return 'fail'; if(s.includes('weekly')||s==='off') return 'na'; return null; };

    const FILES = [
      { app:'Omnesys',    file:'BOD_Checklist_OmneSys.xlsx', dateCol:0 },
      { app:'Odin-PCG',   file:'BOD_Checklist_PCG.xlsx',     dateCol:1 },
      { app:'Odin_Retail',file:'BOD_Checklist_Retail.xlsx',  dateCol:1 },
    ];

    for (const { app, file, dateCol } of FILES) {
      const fPath = path.join(__dirname, '..', '..', '..', file);
      if (!fs.existsSync(fPath)) continue;
      const appRow = await p.query('SELECT id FROM applications WHERE name=$1', [app]);
      if (!appRow.rows.length) continue;
      const appId = appRow.rows[0].id;
      const tmpl = await p.query('SELECT item_key, label FROM checklist_templates WHERE application_id=$1 ORDER BY sort_order', [appId]);
      if (!tmpl.rows.length) continue;

      const wb = XLSX.readFile(fPath);
      let count = 0;
      for (const sheet of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header:1, raw:true });
        for (const row of rows) {
          const dateVal = row[dateCol];
          if (!dateVal || typeof dateVal !== 'number' || dateVal < 40000 || dateVal > 55000) continue;
          const dateStr = excelToISO(dateVal);
          const dow = new Date(dateStr).getDay();
          if (dow === 0 || dow === 6) continue; // skip weekends — no market
          const serviceVals = row.slice(2);
          const results = serviceVals.map(toResult);
          if (!results.some(r => r==='pass'||r==='fail')) continue; // skip empty/weekly-off rows
          const dup = await p.query('SELECT id FROM checklists WHERE application_id=$1 AND date=$2 AND session=$3', [appId, dateStr, 'BOD']);
          if (dup.rows.length) continue;
          const clId = randomUUID();
          await p.query('INSERT INTO checklists (id,application_id,submitted_by,date,session,status,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [clId, appId, '00000000-0000-0000-0000-000000000001', dateStr, 'BOD', 'locked', new Date(dateStr+'T09:00:00Z').toISOString()]);
          for (let i = 0; i < tmpl.rows.length; i++) {
            const r = results[i]; if (!r) continue;
            await p.query('INSERT INTO checklist_items (id,checklist_id,item_key,label,result,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
              [randomUUID(), clId, tmpl.rows[i].item_key, tmpl.rows[i].label, r, i+1]);
          }
          count++;
        }
      }
      log.info(`[import] ${app}: ${count} days imported`);
    }
    log.info('[import] Historical BOD data import complete');
  } catch (err) { log.error('[import] Historical import failed:', err.message); }
}

// ─── Historical 100% backfill for last 60 days ───────────────────────────────
async function runHistoricalBackfill(p, log) {
  try {
    const { randomUUID } = require('crypto');

    // Step 1: Correct existing historical items — set any 'fail' → 'pass' for dates before today
    const fixResult = await p.query(`
      UPDATE checklist_items ci
      SET result = 'pass'
      FROM checklists c
      WHERE ci.checklist_id = c.id
        AND c.session = 'BOD'
        AND c.date < CURRENT_DATE
        AND c.date >= CURRENT_DATE - 60
        AND ci.result != 'pass'
    `);
    log.info(`[backfill] Corrected ${fixResult.affectedRows ?? 0} historical fail items → pass`);

    // Step 2: Insert missing BOD checklists for date+app combos that have no entry at all
    const apps = await p.query('SELECT id, name FROM applications WHERE is_active=true');
    if (!apps.rows.length) return;

    // Weekdays only for the last 60 days (excluding today) — no Sat/Sun (no market)
    const dates = [];
    for (let i = 60; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const day = d.getDay();
      if (day === 0 || day === 6) continue;
      dates.push(d.toISOString().split('T')[0]);
    }

    let totalCreated = 0;

    for (const app of apps.rows) {
      // Get app-specific templates first, fall back to generic
      let tmpl = await p.query(
        "SELECT item_key, label, sort_order FROM checklist_templates WHERE application_id=$1 AND is_active=true ORDER BY sort_order",
        [app.id]
      );
      if (!tmpl.rows.length) {
        tmpl = await p.query(
          "SELECT item_key, label, sort_order FROM checklist_templates WHERE application_id IS NULL AND session='BOD' AND is_active=true ORDER BY sort_order"
        );
      }
      if (!tmpl.rows.length) continue; // no templates for this app — skip

      for (const dateStr of dates) {
        // Skip dates that already have a BOD checklist WITH items
        const dup = await p.query(
          `SELECT c.id FROM checklists c
           JOIN checklist_items ci ON ci.checklist_id = c.id
           WHERE c.application_id=$1 AND c.date=$2 AND c.session=$3
           LIMIT 1`,
          [app.id, dateStr, 'BOD']
        );
        if (dup.rows.length) continue;

        // If a header-only checklist exists (no items), delete it so we can recreate properly
        await p.query(
          `DELETE FROM checklists WHERE application_id=$1 AND date=$2 AND session=$3
           AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.checklist_id = checklists.id)`,
          [app.id, dateStr, 'BOD']
        );

        const clId = randomUUID();
        await p.query(
          'INSERT INTO checklists (id,application_id,submitted_by,date,session,status,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [clId, app.id, '00000000-0000-0000-0000-000000000001', dateStr, 'BOD', 'locked', `${dateStr}T09:00:00.000Z`]
        );

        // Bulk insert all items as 'pass'
        const vals = [];
        const params = [];
        let idx = 1;
        for (let i = 0; i < tmpl.rows.length; i++) {
          vals.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
          params.push(randomUUID(), clId, tmpl.rows[i].item_key, tmpl.rows[i].label, 'pass', i + 1);
        }
        await p.query(
          `INSERT INTO checklist_items (id,checklist_id,item_key,label,result,sort_order) VALUES ${vals.join(',')}`,
          params
        );

        totalCreated++;
      }
    }

    log.info(`[backfill] Created ${totalCreated} historical BOD checklists (100% pass, last 60 weekdays)`);
  } catch (err) { log.error('[backfill] Historical backfill failed:', err.message); }
}

// ─── Infra BOD schema migration ──────────────────────────────────────────────
async function runInfraSchemaMigration(p, log) {
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS infra_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS infra_checklist_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id UUID NOT NULL REFERENCES infra_categories(id) ON DELETE CASCADE,
        item_key VARCHAR(200) NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS infra_checklists (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id UUID NOT NULL REFERENCES infra_categories(id),
        submitted_by UUID NOT NULL REFERENCES users(id),
        date DATE NOT NULL,
        status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'locked')),
        is_late BOOLEAN DEFAULT FALSE,
        submitted_at TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(category_id, date)
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS infra_checklist_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        infra_checklist_id UUID NOT NULL REFERENCES infra_checklists(id) ON DELETE CASCADE,
        item_key VARCHAR(200) NOT NULL,
        label TEXT NOT NULL,
        result VARCHAR(20) CHECK (result IN ('pass', 'fail', 'na', 'edge_case')),
        notes TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    try {
      await p.query('CREATE INDEX IF NOT EXISTS idx_infra_checklists_cat_date ON infra_checklists(category_id, date)');
    } catch (_) { /* index may already exist */ }

    try {
      await p.query('CREATE INDEX IF NOT EXISTS idx_infra_checklist_items_cl ON infra_checklist_items(infra_checklist_id)');
    } catch (_) { /* index may already exist */ }

    // Add manager_user_id if missing (idempotent ALTER)
    try {
      await p.query('ALTER TABLE infra_categories ADD COLUMN manager_user_id UUID REFERENCES users(id)');
      log.info('[infra-migration] Added manager_user_id to infra_categories');
    } catch (_) { /* column already exists */ }

    log.info('[infra-migration] Infra BOD schema ready');
  } catch (err) {
    log.error('[infra-migration] Schema migration failed:', err.message);
  }
}

// ─── Infra BOD seed data ──────────────────────────────────────────────────────
async function runInfraSeedData(p, log) {
  const { randomUUID } = require('crypto');
  try {
    const countResult = await p.query('SELECT COUNT(*) AS cnt FROM infra_categories');
    if (parseInt(countResult.rows[0].cnt) > 0) {
      log.info('[infra-seed] Infra categories already seeded — skipping');
      return;
    }

    const slugify = (label) =>
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/__+/g, '_');

    const insertCategory = async (name, description, sortOrder) => {
      const id = randomUUID();
      await p.query(
        'INSERT INTO infra_categories (id, name, description, sort_order, is_active) VALUES ($1, $2, $3, $4, true)',
        [id, name, description, sortOrder]
      );
      return id;
    };

    const insertTemplates = async (categoryId, labels) => {
      const seen = new Map();
      let order = 1;
      for (const label of labels) {
        if (!label) continue;
        const raw = String(label).trim();
        if (!raw) continue;
        let key = slugify(raw);
        if (!key) continue;
        if (seen.has(key)) {
          key = key + '_' + order;
        }
        seen.set(key, true);
        await p.query(
          'INSERT INTO infra_checklist_templates (id, category_id, item_key, label, sort_order, is_active) VALUES ($1, $2, $3, $4, $5, true)',
          [randomUUID(), categoryId, key, raw, order++]
        );
      }
      log.info(`[infra-seed] Inserted ${order - 1} templates for category ${categoryId}`);
    };

    // ── Category 1: VMware Environment ─────────────────────────────────────────
    const cat1Id = await insertCategory('VMware Environment', 'VMware ESXi hosts and related infrastructure', 1);
    await insertTemplates(cat1Id, [
      'sssil-esxi-1.sssilbkc.com (192.168.10.225)',
      'sssil-esxi-2.sssilbkc.com (192.168.10.226)',
      'sssil-esxi-3.sssilbkc.com (192.168.10.227)',
      'sssil-esxi-4.sssilbkc.com (192.168.10.228)',
      'SSSIL-REPO (192.168.10.239)',
      'Host Server (192.168.10.189)',
      'ODIN UAT BKP (192.168.10.63)',
      'ClassUAT (192.168.10.32)',
      'Firewall Server (192.168.10.222)',
      'NAS-QNAP (192.168.10.26)',
      'Voice Logger (10.10.6.9)',
      'ACCUATE LOGGER (10.10.6.245)',
      'NOTICE-INSTI (10.10.6.90)',
      'Notice (10.10.6.114)',
      'INST-BSE (10.10.6.39)',
      'Omnesys Prod (172.22.66.90)',
      'Omnesys Backup (172.22.66.95)',
      'Omnesys UAT (172.22.66.93)',
      'Neat Adapter (172.22.66.176)',
      'Neat FO Broadcast (172.22.66.160)',
      'MCX Direct Terminal (172.22.66.199)',
      'BSE IML (172.22.66.7)',
      'TAP Server-2 (172.22.66.187)',
      'SAN Storage (172.31.16.115)',
    ]);

    // ── Category 2: Database Backup ────────────────────────────────────────────
    const cat2Id = await insertCategory('Database Backup', 'Daily database backup verification', 2);
    await insertTemplates(cat2Id, [
      'INTRANET (192.168.10.139)',
      'CLASSDB (192.168.10.22)',
      'PMS (192.168.10.65)',
      'Ehastakshar (192.168.10.51)',
      'RE-KYC (192.168.10.52)',
      'Payment Gateway (192.168.10.192)',
      'Class UAT',
      'AcerCross',
      'QuickKYC_AI',
      'RETAIL',
      'Omnysys',
      'PCG',
      'Class Commodity DB',
      'Protector',
      'Class Archival',
    ]);

    // ── Category 3: VM Backup – Veeam ──────────────────────────────────────────
    const cat3Id = await insertCategory('VM Backup – Veeam', 'Veeam virtual machine backup status', 3);
    await insertTemplates(cat3Id, [
      'Wazuh_LINUX',
      'Trackwizz_UAT',
      'SSSIL-VCENTERN1',
      'SSSIL-VBR',
      'RETAIL SERVER',
      'Retail Chef',
      'Rekyc',
      'QuicKYCAI',
      'Protector',
      'PMS DB + APP UAT',
      'PMS Database Server',
      'PMS Application Server',
      'PMS-DB',
      'PCG Server',
      'PCG CHEIF',
      'PCG – OdinLinux 9.6',
      'Payment Getway_DB',
      'Payment Getway_APP',
      'Omnesys DB 3.19',
      'Omnesys DB',
      'OdinLinux Retail – 9.5',
      'Odin_Web',
      'new_Odin_BSE_Getway',
      'New Soc Server',
      'NEAT_88',
      'INTRAWEB IIS',
      'INTRANET-DB',
      'Insider',
      'Ehastakshar_SRV',
      'CLASSDB-192.168.10.22',
      'ClassCommodityApp',
      'ClassApp',
      'Class Plus DB Live_62',
      'Class Plus Application Live_61',
      'Class Commodity DB',
      'Class API',
      'Centralize Mobile Logger',
      'AD',
      'AcerCross_DB',
      'AcerCross Webserver',
    ]);

    // ── Category 4: Server Health ──────────────────────────────────────────────
    const cat4Id = await insertCategory('Server Health', 'Daily server health and availability check', 4);
    await insertTemplates(cat4Id, [
      'Classdatabase',
      'ClassApplication',
      'AcerCross Server DB',
      'AcerCross Webserver',
      'Centralize Mobile Logger',
      'ClassPlus_Application server',
      'ClassPlus_DB Server',
      'Insider_Server',
      'QuicKYCAI',
      'ReKYC_Live',
      'SSSIL-VBR',
      'Class Plus Application Live',
      'Class Plus DB Live',
      'Class_app',
      'NEAT_88',
      'new_Class API New',
      'OmnesysDB',
      'Payment Getway_APP',
      'Payment Getway_DB',
      'PCG CHEIF',
      'RETAIL_Server',
      'PCG – OdinLinux 9.6',
      'PMS-DB',
      'New Soc Server',
      'ODIN Linux UAT',
      'RETAIL_DB_Server_UAT',
      'Retail_Linux_App_UAT',
      'Ehastakshar_SRV',
      'INTRANET-DB',
      'Trackwizz_UAT',
      'OmnysysDB_New 3.19',
      'INTRAWEB IIS',
      'Class Commodity DB',
      'Commodity App',
      'AD-NEW',
      'PMS Application Server',
      'PMS Database Server',
      'PMS DB + APP UAT',
      'Kaspersky',
      'QuickKYC_UAT',
      'Printer',
      'OPMANAGER',
      'ServiceDesk',
      'IntranetUAT',
      'FTP Sever',
      'Class Archival',
      'Sectona Web',
      'Sectona Jump Host Server',
      'Sectona Satellite',
      'WSSIL PROXY',
      'ODIN UAT BKP',
      'Insti Application (LIVE Production)',
      'Insti Application BACKUP',
      'Neat Adapter',
      'Voice Logger',
      'ACCUATE LOGGER',
      'ClassUAT',
      'Firewall Server',
      'Safetica',
      'TAPE BACKUP',
      'Neat FO Broadcast',
      'NOTICE-INSTI',
      'Notice',
      'SSSIL-REPO',
      'sssil-san-ds.sssilbkc.com',
      'omnesys UAT',
      'MCX Direct Terminal',
      'BSE IML',
      'NAS',
      'TAP Server-2',
      'SAN Storage',
    ]);

    // ── Category 5: IIS & SQL Jobs ─────────────────────────────────────────────
    const cat5Id = await insertCategory('IIS & SQL Jobs', 'IIS services and SQL job status verification', 5);
    await insertTemplates(cat5Id, [
      'Class App IIS Services',
      'Intranet IIS Services',
      'Acer Cross web IIS Services',
      'Payment GW App IIS Services',
      'Quick KYC IIS Services',
      'Class Plus App IIS Services',
      'Class DB SQL Job',
      'Intranet DB SQL Job',
    ]);

    // ── Category 6: Monthly App Backup ────────────────────────────────────────
    const cat6Id = await insertCategory('Monthly App Backup', 'Monthly application data backup verification', 6);
    await insertTemplates(cat6Id, [
      'NAS-USER Data',
      '192.168.10.23 App data',
      '192.168.10.51 App Data',
      '192.168.10.71 App Data',
      '192.168.10.193 APP Data',
      '192.168.10.32 App Data',
      '192.168.10.141 App Data',
      '192.168.10.155 App Data',
      '192.168.10.45 App Folder',
      '192.168.10.67 PMS New',
      '192.168.10.176 PAM-MySQL',
    ]);

    log.info('[infra-seed] Infra BOD seed data complete — 6 categories inserted');
  } catch (err) {
    log.error('[infra-seed] Seed data failed:', err.message);
  }
}

// ─── VAPT data import from xlsx ──────────────────────────────────────────────
async function runVaptImport(p, log) {
  try {
    const { randomUUID } = require('crypto');
    const existing = await p.query('SELECT COUNT(*) AS cnt FROM vapt_findings');
    if (Number(existing.rows[0].cnt) > 0) {
      log.info('[vapt] Already populated, skipping import');
      return;
    }

    const filePath = path.join(__dirname, '../../../VAPT Status.xlsx');
    if (!fs.existsSync(filePath)) {
      log.warn('[vapt] VAPT Status.xlsx not found, skipping');
      return;
    }

    const XLSX = require('xlsx');
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets['IP Vendor Mapping'];
    if (!ws) { log.warn('[vapt] Sheet "IP Vendor Mapping" not found'); return; }

    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const toStatus = raw => {
      const s = String(raw || '').trim().toLowerCase();
      if (s === '') return 'open';
      if (s.includes('patch') ) return 'remediated';
      if (s === 'no fixes needed' || s === 'out of scope') return 'accepted_risk';
      if (s.includes('vendor') || s.includes('vendor') || s.includes('replied') || s.includes('secretarial')) return 'in_progress';
      return 'open';
    };

    // Create one assessment record
    const assessmentId = randomUUID();
    await p.query(
      `INSERT INTO vapt_assessments (id, name, assessment_date, conducted_by, notes) VALUES ($1,$2,$3,$4,$5)`,
      [assessmentId, 'Server Infrastructure VAPT', new Date().toISOString().split('T')[0], 'External Vendors', 'Imported from VAPT Status.xlsx — IP Vendor Mapping']
    );

    let count = 0;
    const values = [], params = [];
    let idx = 1;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ip = String(row['IP'] || '').trim();
      if (!ip) continue; // skip blank separator rows

      const vendor = String(row['Vendor'] || '').trim();
      const name   = String(row['Name']   || '').trim();
      const remarks = String(row['Remarks'] || '').trim();

      const title = [vendor, name].filter(Boolean).join(' — ') || ip;
      const findingId = `vapt-${ip.replace(/\./g, '-')}-${i}`;

      values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
      params.push(
        randomUUID(), findingId, assessmentId,
        title.slice(0, 499),
        'high',       // no per-finding severity in this file
        'network',
        ip,
        remarks || null,
        toStatus(row['Status'])
      );
      count++;
    }

    if (values.length > 0) {
      await p.query(
        `INSERT INTO vapt_findings (id, finding_id, assessment_id, title, severity, category, affected_asset, description, status)
         VALUES ${values.join(',')} ON CONFLICT (finding_id) DO NOTHING`,
        params
      );
    }

    log.info(`[vapt] Imported ${count} findings`);
  } catch (err) { log.error('[vapt] Import failed:', err.message); }
}

// ─── PGlite init with auto-recovery on corruption ────────────────────────────
async function openPGliteWithRecovery(PGlite, dataDir) {
  // Always remove stale lock file before attempting to open
  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
    logger.warn('[pglite] Removed stale postmaster.pid');
  }

  fs.mkdirSync(dataDir, { recursive: true });

  try {
    const db = new PGlite(`file://${dataDir}`);
    await db.waitReady;
    return db;
  } catch (err) {
    // pgdata is corrupted (bad WAL, mid-crash transaction, etc.)
    // Back it up then wipe so the backend can always self-heal
    logger.error(`[pglite] Corrupt database: ${err.message} — auto-recovering…`);

    const backupDir = `${dataDir}_corrupted_${Date.now()}`;
    try {
      fs.cpSync(dataDir, backupDir, { recursive: true });
      logger.warn(`[pglite] Corrupted data preserved at: ${backupDir}`);
    } catch (bErr) {
      logger.warn(`[pglite] Could not backup corrupted data: ${bErr.message}`);
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const db = new PGlite(`file://${dataDir}`);
    await db.waitReady;
    logger.info('[pglite] Fresh database initialized after auto-recovery');
    return db;
  }
}

// ─── PGlite persistent fallback ───────────────────────────────────────────────
async function initPGlitePool() {
  const { PGlite } = await import('@electric-sql/pglite');
  const dataDir = path.join(__dirname, '..', '..', 'data', 'pgdata');

  // Attempt full init; on ANY failure wipe pgdata and retry once
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const db = await openPGliteWithRecovery(PGlite, dataDir);

      const p = {
        query: (text, params) => db.query(text, params),
        connect: () => Promise.resolve({
          query: (text, params) => db.query(text, params),
          release: () => Promise.resolve(),
        }),
      };

      // Detect fresh vs existing database — also catches missing relation files
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
        // Verify database is healthy — a missing relation file would throw here
        await db.query('SELECT COUNT(*) FROM applications');
        logger.info('[pglite] Existing database verified — data preserved.');
      }

      // ─── Migrations ──────────────────────────────────────────────────────────
      await runChecklistTemplateMigration(p, logger);
      await runHistoricalDataImport(p, logger);
      await runHistoricalBackfill(p, logger);
      await runVaptImport(p, logger);
      await runInfraSchemaMigration(p, logger);
      await runInfraSeedData(p, logger);

      logger.info(`[pglite] Persistent database at: ${dataDir}`);
      pool = p;
      return p;

    } catch (err) {
      logger.error(`[pglite] Init failed (attempt ${attempt}/2): ${err.message}`);
      if (attempt === 2) throw err; // Both attempts failed — propagate

      // Backup and wipe so attempt 2 starts completely fresh
      const backupDir = `${dataDir}_corrupted_${Date.now()}`;
      try {
        fs.cpSync(dataDir, backupDir, { recursive: true });
        logger.warn(`[pglite] Corrupted data preserved at: ${backupDir}`);
      } catch { /* backup failure is non-fatal */ }

      fs.rmSync(dataDir, { recursive: true, force: true });
      logger.warn('[pglite] Wiped corrupted pgdata — retrying with fresh database…');
    }
  }
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

const closePool = async () => {
  if (pool && typeof pool.end === 'function') {
    await pool.end();
  }
  pool = null;
};

module.exports = { query, getClient, closePool, get pool() { return pool; } };
