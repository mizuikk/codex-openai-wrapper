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

  // Keep Worker types in sync with the wrangler version in the container.
  // This prevents the "Your types might be out of date" warning on startup.
  // In production images we may omit devDependencies, so wrangler might not exist.
  const wranglerExists = await (async () => {
    try {
      await run('wrangler', ['--version']);
      return true;
    } catch (e) {
      return false;
    }
  })();

  if (wranglerExists) {
    try {
      console.log('[start] Generating Worker types...');
      await run('wrangler', ['types']);
    } catch (e) {
      console.warn('[start] WARN: failed to generate types via "wrangler types":', e?.message || e);
    }
  } else {
    console.warn('[start] WARN: wrangler CLI not found in PATH.');
  }

  if (!wranglerExists) {
    console.error('[start] Failed to start: Wrangler CLI is required for dev runtime.');
    console.error('[start] Hints:');
    console.error('[start]  - Build/run with NODE_ENV=development (includes devDependencies).');
    console.error('[start]  - Or rebuild with --build-arg INSTALL_WRANGLER_GLOBAL=1 to include wrangler globally.');
    process.exit(1);
  }

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
