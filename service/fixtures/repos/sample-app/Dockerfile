# Two-stage build. The same image runs the API (default CMD) or the worker
# (override CMD with ["node", "dist/workers/index.js"]).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# tsc does not copy .sql files; the migration runner reads them from dist/db/migrations.
COPY src/db/migrations ./dist/db/migrations
USER node
EXPOSE 8080
# Start Node directly (not via npm run) so SIGTERM reaches the process.
CMD ["node", "dist/server/index.js"]
