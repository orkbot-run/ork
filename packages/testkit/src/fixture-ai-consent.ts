// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { AiConsentStatus } from "@orkbot/contracts";

type FixtureApp = {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
};

/** Explicit setup for synthetic actors whose model work is the behavior under test. */
export async function allowFixtureAiDataSharing(
  app: FixtureApp,
  cookie: string,
  target: { botId?: string; groupId?: string },
  origin = "http://127.0.0.1:5173",
) {
  const call = async (procedure: string, input: unknown) => {
    const response = await app.request(`/rpc/aiConsent/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ json: input }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Fixture data-sharing ${procedure} failed (${response.status})`);
    return ((await response.json()) as { json: AiConsentStatus }).json;
  };
  const status = await call("status", { ...target, uses: ["model", "memory"] });
  const keys = status.recipients.filter((recipient) => !recipient.allowed).map(({ key }) => key);
  if (keys.length)
    await call("allow", { ...target, scope: status.scope, version: status.version, keys });
}
