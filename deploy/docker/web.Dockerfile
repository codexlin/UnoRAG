# UnoRAG Next.js Control Plane image.
# Build from repository root:
#   docker build -f deploy/docker/web.Dockerfile --target runner -t unorag-web:local .
#   docker build -f deploy/docker/web.Dockerfile --target migrator -t unorag-web-migrator:local .
#   docker build -f deploy/docker/web.Dockerfile --target worker -t unorag-web-worker:local .
#   docker build -f deploy/docker/web.Dockerfile --target ops -t unorag-web-ops:local .

FROM node:26-bookworm-slim AS deps
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
WORKDIR /repo
RUN useradd --system --uid 10001 --create-home unorag \
	&& corepack enable \
	&& corepack prepare pnpm@9.7.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=unorag-pnpm-dev,target=/root/.local/share/pnpm/store \
	pnpm install --frozen-lockfile \
		--network-concurrency=4 \
		--fetch-retries=5 \
		--fetch-retry-mintimeout=10000 \
		--fetch-retry-maxtimeout=60000 \
	&& rm -rf /usr/local/lib/node_modules/npm \
	&& rm -f /usr/local/bin/npm /usr/local/bin/npx

# Runtime-only dependency tree for ops and worker. Pruning a full install in a
# later Docker layer does not remove the original dev-dependency bytes from the
# image, so production dependencies must be installed in their own stage.
FROM node:26-bookworm-slim AS runtime-deps
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
WORKDIR /repo
RUN useradd --system --uid 10001 --create-home unorag \
	&& corepack enable \
	&& corepack prepare pnpm@9.7.1 --activate
COPY package.json pnpm-lock.yaml ./
COPY LICENSE NOTICE ./
RUN --mount=type=cache,id=unorag-pnpm-prod,target=/root/.local/share/pnpm/store \
	pnpm install --prod --frozen-lockfile \
		--network-concurrency=4 \
		--fetch-retries=5 \
		--fetch-retry-mintimeout=10000 \
		--fetch-retry-maxtimeout=60000 \
	&& rm -rf /root/.cache /usr/local/lib/node_modules/npm \
	&& rm -f /usr/local/bin/npm /usr/local/bin/npx

FROM node:26-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./
COPY src ./src
COPY public ./public
COPY drizzle ./drizzle
COPY scripts/backfill-acl-projections.mjs scripts/backfill-conversations.mjs scripts/bootstrap-control-plane.mjs scripts/inspect-lifecycle.mjs ./scripts/
COPY drizzle.config.ts next.config.ts postcss.config.mjs tsconfig.json ./
COPY contracts ./contracts
ENV NEXT_TELEMETRY_DISABLED=1 \
	NODE_ENV=production
RUN pnpm build

# One-shot control-plane migrator plus PostgreSQL runtime-role configurator.
FROM node:26-bookworm-slim AS migrator
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
WORKDIR /migrate
# Keep NODE_ENV unset during install so tooling resolves cleanly; set at runtime via compose if needed.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends postgresql-client \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --system --uid 10001 --create-home unorag \
	&& corepack enable \
	&& corepack prepare pnpm@9.7.1 --activate
# Pin the same ranges as the application; install only migration tooling.
COPY package.json /tmp/app.package.json
RUN --mount=type=cache,id=unorag-pnpm-migrator,target=/root/.local/share/pnpm/store \
	node -e 'const fs=require("fs"); const app=JSON.parse(fs.readFileSync("/tmp/app.package.json","utf8")); fs.writeFileSync("package.json", JSON.stringify({name:"unorag-web-migrator",private:true,packageManager:"pnpm@9.7.1",pnpm:{overrides:{esbuild:app.pnpm.overrides.esbuild}},scripts:{"db:migrate":"drizzle-kit migrate"},dependencies:{"drizzle-orm":app.dependencies["drizzle-orm"],pg:app.dependencies.pg,"drizzle-kit":app.devDependencies["drizzle-kit"]}},null,"\t")+"\n");' \
	&& CI=true pnpm install \
		--network-concurrency=4 \
		--fetch-retries=5 \
		--fetch-retry-mintimeout=10000 \
		--fetch-retry-maxtimeout=60000 \
	&& test -x node_modules/.bin/drizzle-kit \
	&& rm -rf /root/.cache /tmp/app.package.json /usr/local/lib/node_modules/npm \
	&& rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=unorag:unorag drizzle.config.ts ./
COPY --chown=unorag:unorag drizzle ./drizzle
COPY --chown=unorag:unorag LICENSE NOTICE ./
# Referenced by drizzle.config schema path (migrate applies SQL in ./drizzle).
COPY --chown=unorag:unorag src/db/schema.ts ./src/db/schema.ts
# Avoid Corepack re-fetching pnpm at container start.
USER unorag
CMD ["./node_modules/.bin/drizzle-kit", "migrate"]

# One-shot bootstrap and operator tooling (no long-running queue consumer).
FROM runtime-deps AS ops
COPY --chown=unorag:unorag scripts/backfill-acl-projections.mjs scripts/backfill-conversations.mjs scripts/bootstrap-control-plane.mjs scripts/check-dbos-drain.mjs scripts/inspect-lifecycle.mjs ./scripts/
WORKDIR /repo
ENV NODE_ENV=production
USER unorag
CMD ["node", "scripts/inspect-lifecycle.mjs"]

# DBOS executor and control loop. Keep the complete worker module together so
# dynamic production-port imports resolve identically in both processes.
FROM runtime-deps AS worker
COPY --chown=unorag:unorag src ./src
COPY --chown=unorag:unorag tsconfig.json ./
WORKDIR /repo
ENV NODE_ENV=production
USER unorag
CMD ["./node_modules/.bin/tsx", "src/worker/entry.ts"]

FROM node:26-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl \
	&& rm -rf /var/lib/apt/lists/* \
		/usr/local/lib/node_modules/npm \
	&& rm -f /usr/local/bin/npm /usr/local/bin/npx \
	&& useradd --system --uid 10001 --create-home unorag

# Next standalone output (see next.config.ts).
COPY --from=builder --chown=unorag:unorag /repo/.next/standalone ./
COPY --from=builder --chown=unorag:unorag /repo/.next/static ./.next/static
COPY --from=builder --chown=unorag:unorag /repo/public ./public
# Ops scripts (drizzle SQL + node tools) for break-glass on the web image.
COPY --from=builder --chown=unorag:unorag /repo/drizzle ./drizzle
COPY --from=builder --chown=unorag:unorag /repo/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder --chown=unorag:unorag /repo/scripts ./scripts
COPY --from=builder --chown=unorag:unorag /repo/package.json ./package.json
COPY --from=builder --chown=unorag:unorag /repo/contracts ./contracts
COPY --chown=unorag:unorag LICENSE NOTICE ./

USER unorag
EXPOSE 3000
WORKDIR /app
CMD ["node", "server.js"]
