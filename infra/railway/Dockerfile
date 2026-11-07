# SPDX-FileCopyrightText: 2026 Rakazo contributors
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
# Inherited Railway startup is preserved. Runtime staging is an Ork addition.

FROM node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a AS build
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
WORKDIR /app
COPY --chmod=755 . .
RUN corepack install && chmod -R a+rX "${COREPACK_HOME}"
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter orkbot --filter @orkbot/api... --filter @orkbot/worker... --filter @orkbot/web... --filter @orkbot/sandbox-supervisor... install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm --filter @orkbot/db generate
RUN pnpm --filter @orkbot/api --filter @orkbot/worker build
RUN ORKBOT_ALLOW_DEV_SECRETS=1 pnpm --filter @orkbot/web build
RUN node scripts/stage-server-runtime.mjs /runtime

FROM node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
RUN apt-get update && apt-get install -y --no-install-recommends gosu tini && rm -rf /var/lib/apt/lists/*
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
COPY --from=build /usr/local/share/corepack /usr/local/share/corepack
WORKDIR /app
COPY --from=build --chmod=755 /runtime/ ./
RUN install -d -m 750 -o node -g node /data /app/apps/web/asset-archive
ENV NODE_ENV=production
ENV ORKBOT_ALLOWED_HOSTS=healthcheck.railway.app
EXPOSE 5173
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["bash", "infra/railway/start.sh"]
