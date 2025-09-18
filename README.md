# Codex OpenAI Wrapper

A practical wrapper that exposes OpenAI-compatible endpoints and optional Ollama pass‑through, deployable to Cloudflare Workers or runnable as a minimal Node server/Docker image. It normalizes model IDs, streams Server-Sent Events (SSE), and adds a simple bearer-key gate for clients.

Note: Public endpoints that do not require authentication: GET / and GET /health.

## Features
- OpenAI-compatible routes: POST /v1/chat/completions, POST /v1/completions, GET /v1/models.
- Optional Ollama pass-through under /api/*.
- Streaming via SSE with token-by-token updates.
- Reasoning output compatibility modes: openai (default), tagged, o3, r1, hidden, or all.
- Pluggable upstream auth: ChatGPT OAuth tokens, upstream API keys, or env-provided key.
- Runs with Cloudflare Wrangler for dev/deploy, or Node-only runtime.

## Quick Start (choose one)

### Option A — Docker Compose (recommended for local dev)

1) Copy example envs and edit values:

```bash
cp .dev.vars.example .dev.vars
```

2) At minimum, set a client access key that your callers must send:

```dotenv
OPENAI_API_KEY=your-local-access-key
```

3) Pick ONE upstream auth strategy:

- ChatGPT OAuth tokens (default): put your auth.json into OPENAI_CODEX_AUTH.

```dotenv
UPSTREAM_AUTH_MODE=chatgpt_token
OPENAI_CODEX_AUTH={"OPENAI_API_KEY": null, "tokens": {"id_token": "...", "access_token": "...", "refresh_token": "...", "account_id": "..."}, "last_refresh": "..."}
```

- Direct API key from env:

```dotenv
UPSTREAM_AUTH_MODE=apikey_env
UPSTREAM_API_KEY=sk-your-upstream-api-key
```

- API key inside OPENAI_CODEX_AUTH JSON:

```dotenv
UPSTREAM_AUTH_MODE=apikey_auth_json
UPSTREAM_AUTH_ENV_KEY=OPENAI_API_KEY   # or another field name present in OPENAI_CODEX_AUTH
OPENAI_CODEX_AUTH={"OPENAI_API_KEY": "sk-your-upstream-api-key"}
```

4) (Optional) Enable Ollama pass-through:

```dotenv
OLLAMA_API_URL=http://localhost:11434
```

5) Start the stack:

```bash
docker compose up -d
```

6) Health check:

```bash
curl -sS http://localhost:8787/health
```

7) Call the API (remember Authorization header below).

See compose and dev runtime in [docker-compose.yml](docker-compose.yml) and [Dockerfile](Dockerfile).

### Option B — Local (Wrangler) without Docker

- Requirements: Node.js 22+, npm, Cloudflare Wrangler 4.x.
- Install deps:

```bash
npm ci
```

- Copy and edit envs:

```bash
cp .dev.vars.example .dev.vars
```

- Start dev server (auto-generates .wrangler.generated.toml):

```bash
npm run dev
```

Server runs on http://localhost:8787.

### Option C — Node runtime (no Wrangler)

Builds a minimal Node server from the same app.

```bash
npm ci
npm run build:node
# Set required env (see ".dev.vars.example") in your shell, then:
npm run start:node
```

Entrypoints: [src/server-node.ts](src/server-node.ts) and runtime image stage in [Dockerfile](Dockerfile).

## Docker

### Runtime Image (no Wrangler)

A minimal production-like image that runs the app with Node 22 without bundling Wrangler/Miniflare.

Build the runtime image:

```bash
docker build -t codex-openai-wrapper:runtime --target runtime .
```

Run the runtime container:

```bash
docker run --rm -p 8787:8787 \
  -e OPENAI_API_KEY=your-local-access-key \
  codex-openai-wrapper:runtime
```

Common environment variables:

- `OPENAI_API_KEY` (required for client auth)
- `UPSTREAM_AUTH_MODE` = `chatgpt_token` (default) | `apikey_env` | `apikey_auth_json`
- `UPSTREAM_API_KEY` (when `apikey_env`)
- `OPENAI_CODEX_AUTH`, `UPSTREAM_AUTH_ENV_KEY` (when `apikey_auth_json`)
- `OLLAMA_API_URL` (optional pass-through under `/api/*`)
- `EXPOSE_MODELS`, `REASONING_*`, `VERBOSE` (operational tweaks)

Example runtime-only compose file (docker-compose.runtime.yml):

```yaml
services:
  codex-openai-wrapper:
    build:
      context: .
      dockerfile: Dockerfile
      target: runtime
    image: codex-openai-wrapper:runtime
    container_name: codex-openai-wrapper-runtime
    ports:
      - "8787:8787"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - REASONING_OUTPUT_MODE=openai
      - VERBOSE=false
```

Health check: `GET http://localhost:8787/health` → `{ "status": "ok" }`.

Notes:
- The runtime image does not provide Cloudflare-specific bindings (KV/R2/DO). Configure upstreams via environment variables.
- For Cloudflare Workers production, deploy via `npm run deploy` (no Docker required for deploy).

### Dev (Wrangler) via Docker Compose

Use the `dev` target to run a Cloudflare-like local runtime.

```bash
docker compose up --build
```

TLS/CA note (dev only): The dev image installs system CA certificates. If your environment requires a custom root CA, add your `.crt` files and update the trust store in the dev stage (before `USER worker`):

```dockerfile
FROM deps AS dev
ENV PATH="/app/node_modules/.bin:${PATH}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Optional enterprise CAs
COPY certs/*.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates
```

## Authentication

All non-public endpoints require an Authorization header. The server compares the provided Bearer token with OPENAI_API_KEY in its environment. If OPENAI_API_KEY is unset, auth is skipped.

- Header format:

```http
Authorization: Bearer your-local-access-key
```

- Public endpoints: GET / and GET /health.
- Details and error shapes: see [docs/authentication.md](docs/authentication.md).

## API Endpoints

Base URL: http://localhost:8787

- OpenAI Chat Completions (JSON or SSE):

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer your-local-access-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "messages": [{"role":"user","content":"Hello"}],
    "stream": true
  }' -N
```

- OpenAI Text Completions:

```bash
curl -X POST http://localhost:8787/v1/completions \
  -H "Authorization: Bearer your-local-access-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "prompt": "Write a haiku about the sea.",
    "stream": false
  }'
```

- Models list (uses EXPOSE_MODELS if set):

```bash
curl -sS http://localhost:8787/v1/models
```

- Ollama chat (pass-through to your OLLAMA_API_URL):

```bash
curl -X POST http://localhost:8787/api/chat \
  -H "Authorization: Bearer your-local-access-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.1",
    "messages": [{"role":"user","content":"Hello from Ollama"}],
    "stream": false
  }'
```

- Ollama tags:

```bash
curl -sS http://localhost:8787/api/tags
```

## Reasoning Compatibility Modes

Configure how upstream “reasoning” content appears in responses:

```dotenv
REASONING_EFFORT=low            # minimal | low | medium | high
REASONING_SUMMARY=auto          # auto | concise | detailed | none
REASONING_OUTPUT_MODE=openai    # openai | tagged | o3 | r1 | hidden | all
```

When REASONING_OUTPUT_MODE=all, additional prefixed routes are enabled:

- /tagged/v1/* → tagged
- /r1/v1/* → r1
- /o3/v1/* → o3
- /openai/v1/* → openai
- /hidden/v1/* → hidden

The root /v1/* continues to work and defaults to openai under ALL mode.

## Environment Variables (most useful)

See the full annotated sample in [.dev.vars.example](.dev.vars.example). Common keys:

- OPENAI_API_KEY: Client access token your callers must send as Bearer.
- OPENAI_CODEX_AUTH: JSON with ChatGPT OAuth tokens and optional OPENAI_API_KEY field.
- UPSTREAM_AUTH_MODE: chatgpt_token (default) | apikey_env | apikey_auth_json.
- UPSTREAM_API_KEY: Upstream key when using apikey_env.
- UPSTREAM_AUTH_ENV_KEY: Key name within OPENAI_CODEX_AUTH when using apikey_auth_json.
- OLLAMA_API_URL: Ollama base URL for /api/* routes.
- EXPOSE_MODELS: CSV or JSON array of model IDs exposed by GET /v1/models.
- FORWARD_CLIENT_HEADERS_MODE: off | safe | list | override | override-codex.
- DEBUG_MODEL: Override/force the requested model id for debugging.
- VERBOSE: "true" to log minimal request info.

Cloudflare KV is optional; if provided, the worker can store refreshable tokens. KV binding is auto-injected into a generated Wrangler config when KV_ID (or KV_NAMESPACE_ID) is set; see [scripts/prepare-wrangler-config.mjs](scripts/prepare-wrangler-config.mjs) and [wrangler.toml](wrangler.toml).

## NPM Scripts

- dev: Starts Wrangler dev with generated config.
- deploy: Generates config and deploys to Cloudflare Workers.
- build: Dry-run deploy that outputs worker bundle to dist/.
- build:node: Builds Node runtime bundle to dist/server-node.mjs.
- start:node: Starts Node runtime.
- test, test:watch, test:coverage: Vitest runners.
- format, lint, lint:fix: Code quality utilities.

See [package.json](package.json) for the full list.

## Cloudflare Deploy

- Ensure Wrangler login: wrangler login.
- Provide necessary env/secrets:

```bash
wrangler secret put OPENAI_API_KEY
# Optionally set KV ID for token storage and any upstream vars
```

- Deploy:

```bash
npm run deploy
```

The deploy script uses [scripts/prepare-wrangler-config.mjs](scripts/prepare-wrangler-config.mjs) to generate .wrangler.generated.toml by merging [wrangler.toml](wrangler.toml) with runtime values.

## Client Examples

Node (OpenAI SDK v4):

```ts
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: "your-local-access-key"
});

const stream = await client.chat.completions.create({
  model: "gpt-5",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

Curl streaming:

```bash
curl -N -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer your-local-access-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"stream please"}],"stream":true}'
```

## Source Map

- Hono app entry and route mounts: [src/index.ts](src/index.ts:25)
- OpenAI routes (chat/completions): [openai.post()](src/routes/openai.ts:12)
- OpenAI routes (completions): [openai.post()](src/routes/openai.ts:259)
- List models: [openai.get()](src/routes/openai.ts:441)
- Ollama chat: [ollama.post()](src/routes/ollama.ts:10)
- Ollama show: [ollama.post()](src/routes/ollama.ts:111)
- Ollama tags: [ollama.get()](src/routes/ollama.ts:155)
- Client auth middleware: [openaiAuthMiddleware()](src/middleware/openaiAuthMiddleware.ts:8)
- Upstream bridge: [startUpstreamRequest()](src/upstream.ts:218)
- SSE translators: [sseTranslateChat()](src/sse.ts:25), [sseTranslateText()](src/sse.ts:427)
- Model normalization and converters: [normalizeModelName()](src/utils.ts:3), [convertChatMessagesToResponsesInput()](src/utils.ts:33)
- Docker/dev entry: [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml), [scripts/start.mjs](scripts/start.mjs)

## Troubleshooting

- 401 "Missing Authorization header" or "Invalid API key": client did not send the Bearer token that matches server OPENAI_API_KEY.
- 401 from upstream: missing/expired ChatGPT tokens or missing UPSTREAM_API_KEY depending on mode.
- "Invalid OPENAI_CODEX_AUTH JSON": check JSON formatting; see example in [.dev.vars.example](.dev.vars.example).
- SSE hangs or disconnects: ensure client keeps connection open and server port 8787 is reachable; streaming requires Accept: text/event-stream (handled by the worker).

## License

MIT-like; see project root for updates.
