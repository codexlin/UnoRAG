# UnoRAG Next.js Control Plane image.
# Build from repository root:
#   docker build -f deploy/docker/web.Dockerfile --target runner -t unorag-web:local .
#   docker build -f deploy/docker/web.Dockerfile --target migrator -t unorag-web-migrator:local .
#   docker build -f deploy/docker/web.Dockerfile --target worker -t unorag-web-worker:local .
#   docker build -f deploy/docker/web.Dockerfile --target ops -t unorag-web-ops:local .

FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile \
	&& rm -rf /root/.local/share/pnpm/store /root/.cache

FROM node:22-bookworm-slim AS builder
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
FROM node:22-bookworm-slim AS migrator
WORKDIR /migrate
# Keep NODE_ENV unset during install so tooling resolves cleanly; set at runtime via compose if needed.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends postgresql-client \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable \
	&& corepack prepare pnpm@9.7.1 --activate
# Pin the same ranges as the application; install only migration tooling.
COPY package.json /tmp/app.package.json
RUN node -e 'const fs=require("fs"); const app=JSON.parse(fs.readFileSync("/tmp/app.package.json","utf8")); fs.writeFileSync("package.json", JSON.stringify({name:"unorag-web-migrator",private:true,packageManager:"pnpm@9.7.1",scripts:{"db:migrate":"drizzle-kit migrate"},dependencies:{"drizzle-orm":app.dependencies["drizzle-orm"],pg:app.dependencies.pg,"drizzle-kit":app.devDependencies["drizzle-kit"]}},null,"\t")+"\n");' \
	&& CI=true pnpm install \
	&& test -x node_modules/.bin/drizzle-kit \
	&& rm -rf /root/.local/share/pnpm/store /root/.cache /tmp/app.package.json
COPY drizzle.config.ts ./
COPY drizzle ./drizzle
# Referenced by drizzle.config schema path (migrate applies SQL in ./drizzle).
COPY src/db/schema.ts ./src/db/schema.ts
# Avoid Corepack re-fetching pnpm at container start.
CMD ["./node_modules/.bin/drizzle-kit", "migrate"]

# One-shot bootstrap and operator tooling (no long-running queue consumer).
FROM deps AS ops
COPY scripts/backfill-acl-projections.mjs scripts/backfill-conversations.mjs scripts/bootstrap-control-plane.mjs scripts/inspect-lifecycle.mjs ./scripts/
WORKDIR /repo
ENV NODE_ENV=production
CMD ["node", "scripts/inspect-lifecycle.mjs"]

# DBOS executor and control loop. Keep the complete worker module together so
# dynamic production-port imports resolve identically in both processes.
FROM deps AS worker
COPY src ./src
COPY tsconfig.json ./
WORKDIR /repo
ENV NODE_ENV=production
CMD ["./node_modules/.bin/tsx", "src/worker/entry.ts"]

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl \
	&& rm -rf /var/lib/apt/lists/* \
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

USER unorag
EXPOSE 3000
WORKDIR /app
CMD ["node", "server.js"]
