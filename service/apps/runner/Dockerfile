# Architecture Review — analysis runner image (SS00 §10, ADR-002, ADR-004, ADR-015)
# Build context: repository root.
#   docker build -f service/apps/runner/Dockerfile -t archreview-runner .

# ---- stage 1: build upstream (npm) and the service workspace (pnpm) ----------
FROM node:22-bookworm-slim AS build
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY src ./src
COPY skills ./skills
COPY .claude-plugin ./.claude-plugin
COPY LICENSE ./
RUN npm ci --no-audit --no-fund && npm run build

COPY service/package.json service/pnpm-lock.yaml service/pnpm-workspace.yaml service/tsconfig.base.json service/tsconfig.json ./service/
COPY service/packages ./service/packages
COPY service/apps ./service/apps
RUN cd service && pnpm install --frozen-lockfile && pnpm -r --filter "./packages/**" --filter "./apps/runner" run build

# ---- stage 2: runtime --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# git is required for retrieval (fetch one commit + git archive); ca-certificates for HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@10.28.0 --activate \
 && groupadd -r app && useradd -r -g app -d /app -s /usr/sbin/nologin app \
 && mkdir -p /tmp/archreview-work && chown app:app /tmp/archreview-work
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/skills ./skills
COPY --from=build /app/LICENSE ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/service/package.json /app/service/pnpm-lock.yaml /app/service/pnpm-workspace.yaml ./service/
COPY --from=build /app/service/packages/contracts/package.json ./service/packages/contracts/
COPY --from=build /app/service/packages/core/package.json ./service/packages/core/
COPY --from=build /app/service/apps/runner/package.json ./service/apps/runner/
RUN cd service && pnpm install --frozen-lockfile --prod --filter "./packages/**" --filter "./apps/runner" && pnpm store prune
COPY --from=build /app/service/packages/contracts/dist ./service/packages/contracts/dist
COPY --from=build /app/service/packages/contracts/schemas ./service/packages/contracts/schemas
COPY --from=build /app/service/packages/core/dist ./service/packages/core/dist
COPY --from=build /app/service/packages/core/migrations ./service/packages/core/migrations
COPY --from=build /app/service/apps/runner/dist ./service/apps/runner/dist

USER app
ENV PORT=3001 ARCHREVIEW_UPSTREAM_ROOT=/app WORKSPACE_ROOT=/tmp/archreview-work \
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
EXPOSE 3001
# Start Node directly so SIGTERM reaches the process (Railway: NodeJS SIGTERM handling).
CMD ["node", "service/apps/runner/dist/main.js"]
