#!/bin/sh
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# SPDX-FileCopyrightText: 2026 Ork contributors

cd "$(dirname "$0")" || exit 1
exec node src/server.mjs
