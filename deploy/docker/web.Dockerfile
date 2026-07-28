# UnoRAG Next.js Control Plane image.
# Build from repository root:
#   docker build -f deploy/docker/web.Dockerfile -t unorag-web:local .
#   docker build -f deploy/docker/web.Dockerfile --target migrator -t unorag-web-migrator:local .

FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --filter web... --frozen-lockfile

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
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
# Pin the same ranges as apps/web; install only migration tooling.
COPY apps/web/package.json /tmp/web.package.json
RUN node -e 'const fs=require("fs"); const web=JSON.parse(fs.readFileSync("/tmp/web.package.json","utf8")); fs.writeFileSync("package.json", JSON.stringify({name:"unorag-web-migrator",private:true,scripts:{"db:migrate":"drizzle-kit migrate"},dependencies:{"drizzle-orm":web.dependencies["drizzle-orm"],pg:web.dependencies.pg,"drizzle-kit":web.devDependencies["drizzle-kit"]}},null,"\t")+"\n");' \
	&& pnpm install \
	&& rm -rf /root/.local/share/pnpm/store /root/.cache /tmp/web.package.json
COPY apps/web/drizzle.config.ts ./
COPY apps/web/drizzle ./drizzle
# Referenced by drizzle.config schema path (migrate applies SQL in ./drizzle).
COPY apps/web/src/db/schema.ts ./src/db/schema.ts
CMD ["pnpm", "db:migrate"]

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
# Migrator / ops scripts (drizzle SQL + node tools).
COPY --from=builder --chown=unorag:unorag /repo/apps/web/drizzle ./apps/web/drizzle
COPY --from=builder --chown=unorag:unorag /repo/apps/web/drizzle.config.ts ./apps/web/drizzle.config.ts
COPY --from=builder --chown=unorag:unorag /repo/apps/web/scripts ./apps/web/scripts
COPY --from=builder --chown=unorag:unorag /repo/apps/web/package.json ./apps/web/package.json
COPY --from=builder --chown=unorag:unorag /repo/contracts ./contracts

USER unorag
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["node", "server.js"]
