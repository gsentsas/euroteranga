-- Foundation baseline migration.
--
-- Intentionally creates no business table. Its only purpose is to prove the
-- migration pipeline end to end (create, deploy, record in _prisma_migrations)
-- without inventing a product model ahead of the PRs that own each domain.
-- See docs/adr/ADR-002-postgresql.md.
SELECT 1;
