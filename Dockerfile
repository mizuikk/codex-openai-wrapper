##########
# Multi-stage Dockerfile
# - runtime (default): minimal image, no Wrangler, runs Node server
# - dev (optional): with devDeps, runs Wrangler dev for local CF runtime
##########

FROM node:22-slim AS base
WORKDIR /app
RUN groupadd -g 1001 nodejs && useradd -r -u 1001 -g nodejs worker

FROM base AS deps
COPY package*.json ./
# Install devDependencies but skip postinstall (avoids wrangler types). Then rebuild esbuild to fetch native binary.
# Use `npm install` to reconcile lockfile inside the image when host lock is outdated
RUN npm install --ignore-scripts --no-audit --no-fund \
 && npm rebuild esbuild --no-audit --no-fund \
 && npm cache clean --force

FROM deps AS build-node
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY wrangler.toml ./
RUN npm run build:node

# -------- Runtime (no Wrangler) --------
 # -------- Dev (Wrangler) --------
FROM deps AS dev
ENV PATH="/app/node_modules/.bin:${PATH}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN mkdir -p .mf && mkdir -p /home/worker/.config/.wrangler/logs && \
    chown -R worker:nodejs /app && chown -R worker:nodejs /home/worker
USER worker
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/scripts/start.mjs"]

# -------- Runtime (no Wrangler) --------
FROM node:22-slim AS runtime
WORKDIR /app
RUN groupadd -g 1001 nodejs && useradd -r -u 1001 -g nodejs worker
COPY --from=build-node /app/dist/server-node.mjs ./dist/server-node.mjs
USER worker
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/dist/server-node.mjs"]
