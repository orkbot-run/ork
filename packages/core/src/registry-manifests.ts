// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { cancelResponseBody, readBoundedJsonResponse } from "./http-response.js";

const indexTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];

/** Compare two published multi-architecture manifest indices using anonymous registry access. */
export async function equalRegistryManifests(options: {
  tokenUrl: string;
  manifestBase: string;
  tags: readonly [string, string];
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
}): Promise<boolean> {
  const failure = () => new Error("Could not verify published images.");
  const response = await options.fetch(options.tokenUrl, {
    redirect: "error",
    signal: options.signal,
  });
  if (!response.ok) {
    cancelResponseBody(response);
    throw failure();
  }
  const auth = await readBoundedJsonResponse<{ token?: unknown }>(response, 16_384, options.signal);
  if (typeof auth.token !== "string" || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(auth.token))
    throw failure();
  const digest = async (tag: string) => {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw failure();
    const manifest = await options.fetch(`${options.manifestBase}/${tag}`, {
      method: "HEAD",
      redirect: "error",
      signal: options.signal,
      headers: { accept: indexTypes.join(", "), authorization: `Bearer ${auth.token}` },
    });
    cancelResponseBody(manifest);
    if (manifest.status === 404) return null;
    if (
      !manifest.ok ||
      !indexTypes.includes((manifest.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "")
    )
      throw failure();
    const value = manifest.headers.get("docker-content-digest");
    if (!value || !/^sha256:[a-f0-9]{64}$/.test(value)) throw failure();
    return value;
  };
  const [first, second] = await Promise.all(options.tags.map(digest));
  return first !== null && first === second;
}
