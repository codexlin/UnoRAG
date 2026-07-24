# MeriKnow Next.js Control Plane image.
# Build from repository root:
#   docker build -f deploy/docker/web.Dockerfile -t meriknow-web:local .

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

# One-shot control-plane migrator (drizzle-kit). Not for runtime traffic.
FROM builder AS migrator
WORKDIR /repo/apps/web
ENV NODE_ENV=production
USER root
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
	&& useradd --system --uid 10001 --create-home meriknow

# Next standalone output (see apps/web/next.config.ts).
COPY --from=builder --chown=meriknow:meriknow /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=meriknow:meriknow /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=meriknow:meriknow /repo/apps/web/public ./apps/web/public
# Migrator / ops scripts (drizzle SQL + node tools).
COPY --from=builder --chown=meriknow:meriknow /repo/apps/web/drizzle ./apps/web/drizzle
COPY --from=builder --chown=meriknow:meriknow /repo/apps/web/drizzle.config.ts ./apps/web/drizzle.config.ts
COPY --from=builder --chown=meriknow:meriknow /repo/apps/web/scripts ./apps/web/scripts
COPY --from=builder --chown=meriknow:meriknow /repo/apps/web/package.json ./apps/web/package.json
COPY --from=builder --chown=meriknow:meriknow /repo/contracts ./contracts

USER meriknow
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["node", "server.js"]
