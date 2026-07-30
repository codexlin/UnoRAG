# UnoRAG Next.js Control Plane image.
# Build from repository root:
#   docker build -f deploy/docker/web.Dockerfile --target runner -t unorag-web:local .
#   docker build -f deploy/docker/web.Dockerfile --target migrator -t unorag-web-migrator:local .
#   docker build -f deploy/docker/web.Dockerfile --target outbox -t unorag-web-outbox:local .
#   docker build -f deploy/docker/web.Dockerfile --target worker -t unorag-web-worker:local .

FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --filter web... --frozen-lockfile \
	&& rm -rf /root/.local/share/pnpm/store /root/.cache

FROM node:22-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web ./apps/web
COPY contracts ./contracts
ENV NEXT_TELEMETRY_DISABLED=1 \
	NODE_ENV=production
RUN pnpm --filter web build

# One-shot control-plane migrator (drizzle-kit only — no Next/node_modules monorepo).
FROM node:22-bookworm-slim AS migrator
WORKDIR /migrate
# Keep NODE_ENV unset during install so tooling resolves cleanly; set at runtime via compose if needed.
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
# Pin the same ranges as apps/web; install only migration tooling.
COPY apps/web/package.json /tmp/web.package.json
RUN node -e 'const fs=require("fs"); const web=JSON.parse(fs.readFileSync("/tmp/web.package.json","utf8")); fs.writeFileSync("package.json", JSON.stringify({name:"unorag-web-migrator",private:true,packageManager:"pnpm@9.7.1",scripts:{"db:migrate":"drizzle-kit migrate"},dependencies:{"drizzle-orm":web.dependencies["drizzle-orm"],pg:web.dependencies.pg,"drizzle-kit":web.devDependencies["drizzle-kit"]}},null,"\t")+"\n");' \
	&& CI=true pnpm install \
	&& test -x node_modules/.bin/drizzle-kit \
	&& rm -rf /root/.local/share/pnpm/store /root/.cache /tmp/web.package.json
COPY apps/web/drizzle.config.ts ./
COPY apps/web/drizzle ./drizzle
# Referenced by drizzle.config schema path (migrate applies SQL in ./drizzle).
COPY apps/web/src/db/schema.ts ./src/db/schema.ts
# Avoid Corepack re-fetching pnpm at container start.
CMD ["./node_modules/.bin/drizzle-kit", "migrate"]

# Outbox + bootstrap ops: workspace node_modules + control-plane scripts (no Next server).
FROM deps AS outbox
COPY apps/web/scripts apps/web/scripts
WORKDIR /repo/apps/web
ENV NODE_ENV=production
CMD ["node", "scripts/process-outbox.mjs", "--watch"]

# DBOS executor and control loop. Keep the complete worker module together so
# dynamic production-port imports resolve identically in both processes.
FROM deps AS worker
COPY apps/web/src/worker apps/web/src/worker
COPY apps/web/tsconfig.json apps/web/
WORKDIR /repo/apps/web
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

# Next standalone output (see apps/web/next.config.ts).
COPY --from=builder --chown=unorag:unorag /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=unorag:unorag /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=unorag:unorag /repo/apps/web/public ./apps/web/public
# Ops scripts (drizzle SQL + node tools) for break-glass on the web image.
COPY --from=builder --chown=unorag:unorag /repo/apps/web/drizzle ./apps/web/drizzle
COPY --from=builder --chown=unorag:unorag /repo/apps/web/drizzle.config.ts ./apps/web/drizzle.config.ts
COPY --from=builder --chown=unorag:unorag /repo/apps/web/scripts ./apps/web/scripts
COPY --from=builder --chown=unorag:unorag /repo/apps/web/package.json ./apps/web/package.json
COPY --from=builder --chown=unorag:unorag /repo/contracts ./contracts

USER unorag
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["node", "server.js"]
