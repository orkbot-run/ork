# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# SPDX-FileCopyrightText: 2026 Ork contributors

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
COPY apps/www/package.json ./apps/www/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/core/package.json ./packages/core/
COPY packages/ui-web/package.json ./packages/ui-web/
COPY packages/ui-tokens/package.json ./packages/ui-tokens/
COPY packages/avatar/package.json ./packages/avatar/
RUN pnpm --filter @orkbot/www... install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/www ./apps/www
COPY packages/contracts ./packages/contracts
COPY packages/core ./packages/core
COPY packages/ui-web ./packages/ui-web
COPY packages/ui-tokens ./packages/ui-tokens
COPY packages/avatar ./packages/avatar
COPY docs ./docs
RUN pnpm --filter @orkbot/www build

FROM nginx:stable-alpine AS runtime
COPY apps/www/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/www/dist /usr/share/nginx/html
COPY LICENSE LICENSE-POLYFORM LICENSE.md NOTICE /usr/share/licenses/ork/
EXPOSE 80
