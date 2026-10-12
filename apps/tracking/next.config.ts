import path from 'node:path';
import { createFoundationNextConfig } from '@euroteranga/config';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// Load the repository-level .env shared by all apps (no-op when absent, e.g. in
// CI) before the public environment is validated.
loadEnvConfig(path.resolve(process.cwd(), '../..'));

const nextConfig: NextConfig = createFoundationNextConfig();

export default nextConfig;
