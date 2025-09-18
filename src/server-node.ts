// Node runtime entrypoint (no Wrangler). Builds and serves the same Hono app
// using the Node server adapter. This allows a minimal Docker image without
// bundling Wrangler/Miniflare while keeping Cloudflare deploy via Wrangler.
//
// Usage (build step creates dist/server-node.mjs):
//   npm run build:node
//   node dist/server-node.mjs

import { serve } from "@hono/node-server";
import app from "./index";

const port = Number(process.env.PORT || "8787");

// Pass process.env as the Worker Bindings (Env) for app.fetch.
// Note: When running on Node, there are no KV/R2 bindings; ensure your code
// reads necessary values from env or guard CF-specific features.
const envAsBindings = process.env as unknown as Record<string, unknown>;

serve({
	fetch: (req) => app.fetch(req, envAsBindings as any),
	port,
	hostname: "0.0.0.0"
});

console.log(`[node-runtime] Listening on http://0.0.0.0:${port}`);
