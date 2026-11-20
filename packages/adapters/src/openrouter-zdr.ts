// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { DecisionProviderError } from "@orkbot/adapter-kit";
import { readBodyCapped } from "./web-ssrf.js";

/** Stable marker survives SDK error formatting and the run error classifier. */
export const OPENROUTER_ZDR_UNAVAILABLE =
  "Model unavailable: OpenRouter has no eligible Zero Data Retention endpoint (openrouter_zdr_unavailable).";

export function isOpenRouterZdrUnavailable(message: string | undefined): boolean {
  return Boolean(message?.includes("openrouter_zdr_unavailable"));
}

/** Unsupported protocols must fail before transmitting an opted-in request. */
export class OpenRouterZdrUnsupportedError extends DecisionProviderError {
  constructor(transport = "this transport") {
    super("model_unavailable");
    this.message = `Model unavailable: ${transport} cannot enforce OpenRouter Zero Data Retention (openrouter_zdr_unsupported).`;
  }
}

export function isOpenRouterZdrPolicyFailure(error: unknown): boolean {
  return error instanceof Error && /openrouter_zdr_(?:unavailable|unsupported)/.test(error.message);
}

/** Applied after SDK serialization, including each SDK retry. Never mutates shared models. */
export function openRouterZdrFetch(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    const url = new URL(request.url);
    if (
      !["openrouter.ai", "eu.openrouter.ai", "us.openrouter.ai"].includes(url.hostname) ||
      url.protocol !== "https:" ||
      !["/api/v1/chat/completions", "/api/v1/messages", "/api/v1/responses"].includes(
        url.pathname,
      ) ||
      request.method !== "POST"
    ) {
      throw new OpenRouterZdrUnsupportedError();
    }
    const payload: unknown = JSON.parse(await request.text());
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Model unavailable: invalid OpenRouter Zero Data Retention request.");
    const body = payload as Record<string, unknown>;
    const routing = body.provider;
    if (
      routing !== undefined &&
      (routing === null || typeof routing !== "object" || Array.isArray(routing))
    )
      throw new Error("Model unavailable: invalid OpenRouter provider routing.");
    body.provider = {
      ...(routing as Record<string, unknown> | undefined),
      zdr: true,
      data_collection: "deny",
    };
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const response = await transport(input, {
      ...init,
      redirect: "error",
      headers,
      body: JSON.stringify(body),
    });
    // Do not weaken policy or switch to another account/model when routing has no eligible endpoint.
    if (!response.ok) {
      let errorMessage = "";
      try {
        const bytes = await readBodyCapped(
          response.clone(),
          64 * 1024,
          AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
        );
        const detail: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (detail && typeof detail === "object") {
          const error = "error" in detail ? detail.error : detail;
          if (
            error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
          )
            errorMessage = error.message;
        }
      } catch {
        // Malformed or oversized provider errors retain the SDK's normal failure handling.
      }
      if (
        /no (?:eligible )?(?:endpoints?|providers?)(?: available| found)|no endpoints match|data policy|privacy (?:policy|settings)|zero.?data.?retention|\bzdr\b/i.test(
          errorMessage,
        )
      ) {
        return Response.json(
          {
            error: {
              message: OPENROUTER_ZDR_UNAVAILABLE,
              code: response.status,
            },
          },
          {
            status: response.status,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }
    return response;
  };
}
