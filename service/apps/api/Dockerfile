# Architecture Review — API service image (SS00 §10, ADR-002, ADR-015)
# Build context: repository root (Railway: RAILWAY_DOCKERFILE_PATH / IaC build.dockerfilePath).
#   docker build -f service/apps/api/Dockerfile -t archreview-api .

# ---- stage 1: build upstream (npm) and the service workspace (pnpm) ----------
FROM node:22-bookworm-slim AS build
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# upstream oh-my-mermaid (root project) — built first; the service imports dist/index.js
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY src ./src
COPY skills ./skills
COPY .claude-plugin ./.claude-plugin
COPY LICENSE ./
RUN npm ci --no-audit --no-fund && npm run build

# service workspace
COPY service/package.json service/pnpm-lock.yaml service/pnpm-workspace.yaml service/tsconfig.base.json service/tsconfig.json ./service/
COPY service/packages ./service/packages
COPY service/apps ./service/apps
RUN cd service && pnpm install --frozen-lockfile && pnpm -r --filter "./packages/**" --filter "./apps/api" run build

# ---- stage 2: runtime --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate \
 && groupadd -r app && useradd -r -g app -d /app -s /usr/sbin/nologin app
WORKDIR /app

# upstream runtime files: dist (CLI, index, viewer.html), skills, package.json and its runtime deps (yaml)
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/skills ./skills
COPY --from=build /app/LICENSE ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# service: production dependencies only
COPY --from=build /app/service/package.json /app/service/pnpm-lock.yaml /app/service/pnpm-workspace.yaml ./service/
COPY --from=build /app/service/packages/contracts/package.json ./service/packages/contracts/
COPY --from=build /app/service/packages/core/package.json ./service/packages/core/
COPY --from=build /app/service/apps/api/package.json ./service/apps/api/
RUN cd service && pnpm install --frozen-lockfile --prod --filter "./packages/**" --filter "./apps/api" && pnpm store prune
COPY --from=build /app/service/packages/contracts/dist ./service/packages/contracts/dist
COPY --from=build /app/service/packages/contracts/schemas ./service/packages/contracts/schemas
COPY --from=build /app/service/packages/contracts/openapi.json ./service/packages/contracts/openapi.json
COPY --from=build /app/service/packages/core/dist ./service/packages/core/dist
COPY --from=build /app/service/packages/core/migrations ./service/packages/core/migrations
COPY --from=build /app/service/apps/api/dist ./service/apps/api/dist
COPY --from=build /app/service/apps/api/static ./service/apps/api/static

USER app
ENV PORT=3000 ARCHREVIEW_UPSTREAM_ROOT=/app
EXPOSE 3000
# Start Node directly so SIGTERM reaches the process (Railway: NodeJS SIGTERM handling).
CMD ["node", "service/apps/api/dist/main.js"]
