import { defineConfig } from 'prisma/config';

// Client generation and schema validation must work without a database (e.g.
// in build-only CI jobs), so the datasource is only declared when
// DATABASE_URL is set. Commands that need a connection (migrate deploy/status)
// fail explicitly when it is missing.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
