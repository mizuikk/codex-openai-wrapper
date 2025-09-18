// Node-based entrypoint for dev/runtime to avoid shell/CRLF issues
// 1) Generates wrangler config with [vars] from environment
// 2) Starts wrangler dev bound to 0.0.0.0:8787 with persisted storage

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env, ...opts });
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  console.log('[start] Preparing Wrangler config (node entrypoint)...');
  await run('node', [join(__dirname, 'prepare-wrangler-config.mjs')]);

  console.log('[start] Starting wrangler dev on 0.0.0.0:8787');
  // Important: use explicit args so it mirrors start.sh behavior
  await run('wrangler', [
    'dev',
    '--host', '0.0.0.0',
    '--port', '8787',
    '--local',
    '--persist-to', '.mf',
    '--config', '.wrangler.generated.toml',
  ]);
}

main().catch((err) => {
  console.error('[start] Failed to start:', err?.stack || err?.message || String(err));
  process.exit(1);
});

