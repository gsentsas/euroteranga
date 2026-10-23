import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import prettier from 'prettier';

const files = [
  'apps/api/src/baggage/baggage-policy.dto.ts',
  'apps/api/src/baggage/baggage-policy.service.ts',
  'apps/api/src/baggage/baggage.service.ts',
  'apps/api/test/integration/baggage/baggage-plus.int.spec.ts',
  'apps/api/test/support/baggage-helpers.ts',
  'apps/client/components/customer-baggage.tsx',
  'apps/ops/components/baggage/baggage-admin.tsx',
  'apps/ops/components/pricing/baggage-policy-admin.tsx',
  'docs/domain/baggage.md',
  'packages/auth-client/src/auth-client.ts',
  'tests/browser/specs/baggage.spec.ts',
];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(source, { ...config, filepath: file });
  console.log('FORMAT_B64_BEGIN ' + file);
  console.log(Buffer.from(formatted, 'utf8').toString('base64'));
  console.log('FORMAT_B64_END ' + file);
}
