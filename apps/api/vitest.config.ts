import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits the decorator metadata NestJS dependency injection relies on;
  // Vitest's default transformer (esbuild) does not.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
