-- PR-23 operational reporting.
-- Reporting is computed from authoritative business tables; this migration
-- only extends the fixed RBAC catalogue. No analytical snapshot is persisted.

INSERT INTO "authorization_permission" ("key","description") VALUES
  ('reporting.view','Read aggregated operational, commercial and financial reporting without passenger PII'),
  ('reporting.export','Export the same authorized aggregated reporting as CSV/XLSX');

INSERT INTO "authorization_role_permission" ("role_key","permission_key") VALUES
  ('SUPER_ADMIN','reporting.view'),('SUPER_ADMIN','reporting.export'),
  ('DIRECTOR','reporting.view'),('DIRECTOR','reporting.export'),
  ('OPS_MANAGER','reporting.view'),('OPS_MANAGER','reporting.export'),
  ('AUDITOR','reporting.view'),('AUDITOR','reporting.export')
ON CONFLICT DO NOTHING;
