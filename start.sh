#!/bin/bash

set -euo pipefail

# Generate a config that injects KV namespace IDs from environment/.dev.vars
echo "[start] Preparing Wrangler config..."
node scripts/prepare-wrangler-config.mjs

# Run wrangler dev with the generated config
echo "[start] Starting wrangler dev on 0.0.0.0:8787"
exec wrangler dev --host 0.0.0.0 --port 8787 --local --persist-to .mf --config .wrangler.generated.toml
