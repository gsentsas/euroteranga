// Local development runner: compiles with tsc in watch mode and restarts the
// API whenever the compiled output changes. Node's type stripping cannot run
// the sources directly because NestJS relies on decorator metadata.
import { spawn } from 'node:child_process';

const compiler = spawn(
  'pnpm',
  ['exec', 'tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);

let server;

compiler.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  // Start the server after the first successful compilation only; node --watch
  // handles restarts afterwards.
  if (!server && /Found 0 errors/.test(chunk.toString())) {
    server = spawn(
      process.execPath,
      [
        '--enable-source-maps',
        '--env-file-if-exists=../../.env',
        '--watch-path=dist',
        'dist/main.js',
      ],
      { stdio: 'inherit' },
    );
  }
});

const stop = (signal) => {
  server?.kill(signal);
  compiler.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
