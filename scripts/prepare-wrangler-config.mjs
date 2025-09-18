import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

function log(msg) {
  console.log(`[prepare-wrangler] ${msg}`);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load .dev.vars into process.env for local development.
 * Lines are KEY=VALUE, with # comments supported. Does not overwrite existing env.
 */
function loadDevVarsIntoEnv(devVarsPath) {
  try {
    const raw = fsSync.readFileSync(devVarsPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    log(`Loaded .dev.vars from ${devVarsPath}`);
  } catch (e) {
    log(`No .dev.vars loaded (${e.message})`);
  }
}

/**
 * Replace or inject id fields in a kv_namespaces block using env vars.
 * For a binding name "KV", expected env keys are tried in order: KV_ID, KV_KV_ID, KV_NAMESPACE_ID.
 */
function injectIdsIntoKvBlock(kvBlock) {
  const tables = [...kvBlock.matchAll(/\{[^}]*\}/g)].map((m) => m[0]);
  const updatedTables = [];
  for (const tbl of tables) {
    const bindingMatch = tbl.match(/binding\s*=\s*"([^"]+)"/);
    if (!bindingMatch) {
      updatedTables.push(tbl);
      continue;
    }
    const binding = bindingMatch[1];
    const envKeys = [
      `${binding}_ID`,
      `${binding}_KV_ID`,
      `${binding}_NAMESPACE_ID`,
    ];
    let idVal;
    for (const k of envKeys) {
      if (process.env[k]) {
        idVal = process.env[k];
        break;
      }
    }
    if (!idVal) {
      log(`WARN: No ID found for KV binding '${binding}'. Leaving it unchanged.`);
      updatedTables.push(tbl);
      continue;
    }
    let newTbl;
    if (/(^|,)\s*id\s*=\s*"[^"]*"/.test(tbl)) {
      newTbl = tbl.replace(/id\s*=\s*"[^"]*"/, `id = "${idVal}"`);
    } else {
      newTbl = tbl.replace(/binding\s*=\s*"[^"]*"/, (m) => `${m}, id = "${idVal}"`);
    }
    updatedTables.push(newTbl);
  }
  let idx = 0;
  return kvBlock.replace(/\{[^}]*\}/g, () => updatedTables[idx++]);
}

function shouldGenerateVarsBlock() {
  const override = process.env.GENERATE_WRANGLER_VARS;
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  try {
    if (fsSync.existsSync('/.dockerenv')) return true;
  } catch {}
  return false;
}

/**
 * Build a TOML [vars] section by selecting a whitelist of environment
 * variables and serialising them as TOML strings. This ensures Wrangler
 * binds container env to Worker `c.env.*` in docker dev mode.
 */
function buildVarsSectionFromEnv() {
  if (!shouldGenerateVarsBlock()) {
    return '';
  }
  // Whitelist: match Env interface in src/types.ts (keep in sync if updated)
  const KEYS = [
    // Auth / core
    'OPENAI_API_KEY', 'CHATGPT_LOCAL_CLIENT_ID', 'CHATGPT_RESPONSES_URL', 'OPENAI_CODEX_AUTH',
    'EXPOSE_MODELS', 'OLLAMA_API_URL', 'DEBUG_MODEL',
    // Reasoning
    'REASONING_EFFORT', 'REASONING_SUMMARY', 'REASONING_OUTPUT_MODE', 'VERBOSE',
    // Upstream routing/auth
    'UPSTREAM_RESPONSES_URL', 'UPSTREAM_BASE_URL', 'UPSTREAM_WIRE_API_PATH',
    'UPSTREAM_AUTH_MODE', 'UPSTREAM_AUTH_ENV_KEY', 'UPSTREAM_API_KEY',
    'UPSTREAM_AUTH_HEADER', 'UPSTREAM_AUTH_SCHEME', 'UPSTREAM_TOOLS_FORMAT',
    // Header forwarding
    'FORWARD_CLIENT_HEADERS_MODE', 'FORWARD_CLIENT_HEADERS_OVERRIDE', 'FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX',
    'FORWARD_CLIENT_HEADERS_LIST', 'FORWARD_CLIENT_HEADERS_CODEX_VERSION',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'FORWARD_CLIENT_HEADERS_CODEX_ORIGINATOR',
    'FORWARD_CLIENT_HEADERS_CODEX_OS_TYPE', 'FORWARD_CLIENT_HEADERS_CODEX_OS_VERSION', 'FORWARD_CLIENT_HEADERS_CODEX_ARCH',
    'FORWARD_CLIENT_HEADERS_CODEX_EDITOR',
    // Terminal detection
    'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'WEZTERM_VERSION', 'KONSOLE_VERSION', 'VTE_VERSION', 'WT_SESSION',
    'KITTY_WINDOW_ID', 'ALACRITTY_SOCKET', 'TERM',
    // Instructions
    'INSTRUCTIONS_BASE_URL', 'INSTRUCTIONS_CODEX_URL', 'INSTRUCTIONS_SANITIZE_PATCH', 'INSTRUCTIONS_SANITIZE_LEVEL',
  ];

  const picked = [];
  for (const k of KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim() !== '') {
      // Escape TOML string special characters (minimal): backslash, quotes, newlines
      const esc = v
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '')
        .replace(/\n/g, '\\n');
      picked.push(`${k} = "${esc}"`);
    }
  }
  if (picked.length === 0) return '';
  log(`Binding env vars to Worker: ${picked.length} keys`);
  return ['[vars]', ...picked, ''].join('\n');
}

async function main() {
  const root = process.cwd();
  const basePath = path.join(root, 'wrangler.toml');
  const outPath = path.join(root, '.wrangler.generated.toml');
  const devVarsPath = path.join(root, '.dev.vars');

  if (!(await fileExists(basePath))) {
    console.error('wrangler.toml not found. Abort.');
    process.exit(1);
  }

  // Load .dev.vars into env for local dev fallback, unless explicitly disabled.
  // Note (English): In Docker compose we usually pass env_file, so variables
  // are already present in process.env and will NOT be overwritten here.
  if (!process.env.DISABLE_DEV_VARS_LOAD && await fileExists(devVarsPath)) {
    loadDevVarsIntoEnv(devVarsPath);
  }

  let base = await fs.readFile(basePath, 'utf8');
  const kvRegex = /(^|\n)kv_namespaces\s*=\s*\[[\s\S]*?\]/m;
  const match = base.match(kvRegex);
  let updated = base;

  if (match) {
    // If a kv_namespaces block exists, inject IDs from env
    const kvBlock = match[0];
    const newBlock = injectIdsIntoKvBlock(kvBlock);
    updated = base.replace(kvRegex, newBlock);
  } else {
    // No kv block present. Create one using env for common binding 'KV'.
    const kvId = process.env.KV_ID || process.env.KV_NAMESPACE_ID || process.env.KV;
    if (kvId) {
      const kvBlock = ['kv_namespaces = [', `  { binding = "KV", id = "${kvId}" }`, ']', ''].join('\n');
      // Insert after compatibility_flags if possible, else append
      const insertAfter = /(compatibility_flags\s*=\s*\[[^\]]*\][^\n]*\n)/m;
      if (insertAfter.test(updated)) {
        updated = updated.replace(
          insertAfter,
          `$1\n# --- KV Namespaces (generated) ---\n${kvBlock}\n`
        );
      } else {
        updated += `\n# --- KV Namespaces (generated) ---\n${kvBlock}\n`;
      }
      log('Injected kv_namespaces block using KV_ID from environment');
    } else {
      log('WARN: KV_ID/KV_NAMESPACE_ID not set; kv_namespaces will not be present in generated config');
    }
  }

  // Inject [vars] so Docker/container env is visible to Worker c.env.* during wrangler dev
  const varsBlock = buildVarsSectionFromEnv();
  const header = `# THIS FILE IS AUTO-GENERATED. DO NOT COMMIT.\n# Generated by scripts/prepare-wrangler-config.mjs\n\n`;
  const finalToml = header + updated + (varsBlock ? `\n# --- Vars (generated from environment) ---\n${varsBlock}` : '');
  await fs.writeFile(outPath, finalToml, 'utf8');
  log(`Wrote ${path.relative(root, outPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

