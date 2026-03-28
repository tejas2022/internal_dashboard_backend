-- CIO Operations Dashboard — PostgreSQL Schema
-- Version 1.0

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS & RBAC
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'user', 'stakeholder')),
  is_active BOOLEAN DEFAULT TRUE,
  must_change_password BOOLEAN DEFAULT TRUE,
  failed_login_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- APPLICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  parent_id UUID REFERENCES applications(id) ON DELETE SET NULL,
  type VARCHAR(100),
  environment VARCHAR(20) DEFAULT 'prod' CHECK (environment IN ('prod', 'uat', 'dev')),
  manager_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  description TEXT,
  tags TEXT[],
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CHECKLISTS
-- ============================================================
CREATE TABLE IF NOT EXISTS checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_type VARCHAR(100),
  session VARCHAR(3) NOT NULL CHECK (session IN ('BOD', 'EOD')),
  item_key VARCHAR(100) NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  submitted_by UUID NOT NULL REFERENCES users(id),
  date DATE NOT NULL,
  session VARCHAR(3) NOT NULL CHECK (session IN ('BOD', 'EOD')),
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'locked')),
  is_late BOOLEAN DEFAULT FALSE,
  override_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(application_id, date, session)
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id UUID NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  item_key VARCHAR(100) NOT NULL,
  label TEXT NOT NULL,
  result VARCHAR(20) CHECK (result IN ('pass', 'fail', 'na', 'edge_case')),
  notes TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS checklist_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_item_id UUID NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  justification TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  impact TEXT NOT NULL,
  steps_taken TEXT NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('resolved', 'in_progress', 'escalated')),
  resolved_at TIMESTAMPTZ,
  escalated_to UUID REFERENCES users(id),
  escalation_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- NETWORK / OPMANAGER
-- ============================================================
CREATE TABLE IF NOT EXISTS opmanager_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id VARCHAR(100) NOT NULL,
  device_name VARCHAR(255) NOT NULL,
  device_type VARCHAR(100),
  ip_address VARCHAR(50),
  status VARCHAR(20) CHECK (status IN ('up', 'down', 'unknown')),
  uptime_pct_24h NUMERIC(5,2),
  uptime_pct_7d NUMERIC(5,2),
  uptime_pct_30d NUMERIC(5,2),
  cpu_utilization NUMERIC(5,2),
  memory_utilization NUMERIC(5,2),
  polled_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS opmanager_alarms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm_id VARCHAR(100) UNIQUE NOT NULL,
  device_name VARCHAR(255),
  severity VARCHAR(20) CHECK (severity IN ('critical', 'major', 'minor', 'warning', 'clear')),
  message TEXT,
  category VARCHAR(100),
  raised_at TIMESTAMPTZ,
  cleared_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SECURITY — WAZUH
-- ============================================================
CREATE TABLE IF NOT EXISTS wazuh_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id VARCHAR(255) UNIQUE NOT NULL,
  rule_id VARCHAR(50),
  rule_description TEXT,
  severity VARCHAR(20) CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  agent_id VARCHAR(50),
  agent_name VARCHAR(255),
  triggered_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SECURITY — SOC EMAIL ALERTS
-- ============================================================
CREATE TABLE IF NOT EXISTS soc_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_email_id VARCHAR(255),
  alert_type VARCHAR(100),
  severity VARCHAR(20) CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  affected_asset TEXT,
  description TEXT,
  raw_subject TEXT,
  raw_body TEXT,
  received_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by UUID REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VAPT TRACKER
-- ============================================================
CREATE TABLE IF NOT EXISTS vapt_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  assessment_date DATE,
  conducted_by VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vapt_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id VARCHAR(50) UNIQUE NOT NULL,
  assessment_id UUID REFERENCES vapt_assessments(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'informational')),
  category VARCHAR(50) CHECK (category IN ('network', 'application', 'configuration', 'social_engineering', 'other')),
  affected_asset TEXT,
  discovery_date DATE,
  description TEXT,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'remediated', 'accepted_risk', 'closed')),
  target_remediation_date DATE,
  actual_remediation_date DATE,
  evidence_notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROJECTS & TASKS
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'not_started' CHECK (status IN ('not_started', 'planning', 'in_progress', 'on_hold', 'completed', 'cancelled')),
  priority VARCHAR(10) DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  start_date DATE,
  end_date DATE,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  due_date DATE,
  status VARCHAR(20) DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed', 'missed')),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id UUID REFERENCES milestones(id) ON DELETE SET NULL,
  name VARCHAR(500) NOT NULL,
  description TEXT,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  reported_by UUID REFERENCES users(id) ON DELETE SET NULL,
  priority VARCHAR(10) DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  status VARCHAR(20) DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'blocked', 'in_review', 'done')),
  start_date DATE,
  due_date DATE,
  estimated_hours NUMERIC(6,2),
  actual_hours NUMERIC(6,2),
  blockers TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_time_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  hours NUMERIC(5,2) NOT NULL,
  log_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(100),
  entity_id UUID,
  payload JSONB,
  ip_address VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_applications_manager ON applications(manager_user_id);
CREATE INDEX IF NOT EXISTS idx_checklists_app_date ON checklists(application_id, date, session);
CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON checklist_items(checklist_id);
CREATE INDEX IF NOT EXISTS idx_checklist_failures_item ON checklist_failures(checklist_item_id);
CREATE INDEX IF NOT EXISTS idx_opmanager_snapshots_polled ON opmanager_snapshots(polled_at DESC);
CREATE INDEX IF NOT EXISTS idx_opmanager_snapshots_device ON opmanager_snapshots(device_id, polled_at DESC);
CREATE INDEX IF NOT EXISTS idx_opmanager_alarms_active ON opmanager_alarms(is_active, raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_wazuh_alerts_triggered ON wazuh_alerts(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_wazuh_alerts_severity ON wazuh_alerts(severity, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc_alerts_received ON soc_alerts(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc_alerts_status ON soc_alerts(status);
CREATE INDEX IF NOT EXISTS idx_vapt_findings_status ON vapt_findings(status);
CREATE INDEX IF NOT EXISTS idx_vapt_findings_severity ON vapt_findings(severity);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
