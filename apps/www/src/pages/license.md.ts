// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors
import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { LICENSE_MARKDOWN } from "../licensing";

export const GET: APIRoute = ({ request }) => markdownResponse(LICENSE_MARKDOWN, request.method);
