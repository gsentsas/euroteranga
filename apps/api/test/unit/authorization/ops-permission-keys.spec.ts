import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../../src/authorization/permissions.js';

const OPS_ROOT = fileURLToPath(new URL('../../../../ops/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The OPS interface names permissions as plain strings (display only). A key
 * that does not exist in the catalogue silently hides a feature, so every key
 * used there must be a real one.
 */
describe('permission keys used by the OPS interface', () => {
  it('all exist in the permission catalogue', () => {
    const known = new Set<string>(Object.values(PERMISSIONS));
    const used = new Set<string>();
    const patterns = [
      /useCan\(([^)]*)\)/g,
      /permission[=:]\s*["']([^"']+)["']/g,
      /OPS_ACCESS\s*=\s*["']([^"']+)["']/g,
    ];
    for (const file of sources(join(OPS_ROOT, 'app')).concat(
      sources(join(OPS_ROOT, 'components')),
    )) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          for (const key of (match[1] ?? '').matchAll(/["']?([a-z]+(?:\.[a-z]+)+)["']?/g)) {
            if (key[1]) used.add(key[1]);
          }
        }
      }
    }
    expect(used.size).toBeGreaterThanOrEqual(8);
    expect([...used].filter((key) => !known.has(key))).toEqual([]);
  });
});
