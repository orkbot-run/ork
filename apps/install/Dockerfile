# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

FROM nginx:stable-alpine

COPY apps/install/nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/compose/install.sh /usr/share/nginx/html/install.sh
