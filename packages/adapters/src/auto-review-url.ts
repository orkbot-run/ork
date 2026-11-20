// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { redactSecrets } from "@orkbot/core";

const SECRET_PARAMETER =
  /^(?:access[-_]?token|api[-_]?key|authorization|client[-_]?secret|password|refresh[-_]?token|session[-_]?token|x-amz-signature)$/i;
const EMAIL_ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

function decodedComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Hold obvious disclosures locally. The checker handles cases that need context. */
export function newSiteUrlNeedsOwner(address: string, secrets: readonly string[]): boolean {
  const url = new URL(address);
  if (url.username || url.password) return true;
  const fragment = url.hash.slice(1);
  if (
    [url.searchParams, new URLSearchParams(fragment)].some((params) =>
      [...params].some(([name, value]) => Boolean(value) && SECRET_PARAMETER.test(name)),
    )
  )
    return true;
  const components = [
    address,
    decodedComponent(url.pathname),
    ...url.searchParams.keys(),
    ...url.searchParams.values(),
    decodedComponent(fragment),
  ];
  if (
    components.some((value) => EMAIL_ADDRESS.test(value) || redactSecrets(value, secrets) !== value)
  )
    return true;
  // URL canonicalization lowercases DNS labels.
  return (
    redactSecrets(
      url.hostname,
      secrets.map((secret) => secret.toLowerCase()),
    ) !== url.hostname
  );
}
