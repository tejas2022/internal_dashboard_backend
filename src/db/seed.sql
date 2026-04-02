-- CIO Operations Dashboard — Seed Data
-- Default admin user: admin / Admin@2026! (must change on first login)
-- Password hash for 'Admin@2026!' with bcrypt cost 12

INSERT INTO users (id, name, email, username, password_hash, role, is_active, must_change_password)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'CIO Admin',
  'admin@company.internal',
  'admin',
  '$2a$12$8p.YB9unobpcAJ1Yr7POC.v4YpWCGtRLgP8/4c08c4cZ3ag0sRs.C',
  'admin',
  true,
  true
) ON CONFLICT (username) DO NOTHING;

-- Default applications
INSERT INTO applications (id, name, type, environment, is_active) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Omnesys',    'Trading Application', 'prod', true),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Odin-PCG',   'Trading Application', 'prod', true),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Odin_Retail','Trading Application', 'prod', true),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Wazuh',      'Monitoring',          'prod', true)
ON CONFLICT DO NOTHING;

-- Default checklist templates — BOD
INSERT INTO checklist_templates (application_type, session, item_key, label, description, sort_order) VALUES
('trading', 'BOD', 'server_up', 'Server / Service Online', 'Confirm the application server is up and reachable', 1),
('trading', 'BOD', 'db_connection', 'Database Connection', 'Verify database connectivity is active', 2),
('trading', 'BOD', 'market_feed', 'Market Data Feed', 'Confirm live market data feed is receiving data', 3),
('trading', 'BOD', 'order_gateway', 'Order Gateway', 'Order routing gateway is online and responding', 4),
('trading', 'BOD', 'risk_engine', 'Risk Engine', 'Risk management engine is running', 5),
('trading', 'BOD', 'login_test', 'User Login Test', 'Test user can log in successfully', 6),
('trading', 'EOD', 'eod_processing', 'EOD Processing Complete', 'All end-of-day batch processes completed', 1),
('trading', 'EOD', 'pnl_reconciliation', 'P&L Reconciliation', 'P&L figures reconciled against exchange', 2),
('trading', 'EOD', 'trade_confirmation', 'Trade Confirmation', 'All trades confirmed and matched', 3),
('trading', 'EOD', 'position_flat', 'Positions Flat / Carried', 'End of day positions verified', 4),
('trading', 'EOD', 'backup_complete', 'Backup Completed', 'Daily data backup completed successfully', 5),
('trading', 'EOD', 'alerts_cleared', 'Alerts Cleared', 'No outstanding critical alerts', 6),
('general', 'BOD', 'service_health', 'Service Health Check', 'Application services are running', 1),
('general', 'BOD', 'db_connection', 'Database Connectivity', 'Database connections are healthy', 2),
('general', 'BOD', 'integrations', 'Integrations Active', 'All external integrations are active', 3),
('general', 'EOD', 'backup_complete', 'Backup Complete', 'Daily backup completed', 1),
('general', 'EOD', 'log_review', 'Log Review', 'Error logs reviewed, no critical issues', 2),
('general', 'EOD', 'pending_issues', 'Pending Issues', 'All pending issues logged and assigned', 3)
ON CONFLICT DO NOTHING;
