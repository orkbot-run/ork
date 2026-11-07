// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; model configuration changes follow LICENSE.md.

import type { ModelApiProtocol, ModelRoleChoice } from "@orkbot/contracts";
import type { Href } from "expo-router";
import type { SettingsTarget } from "./settings-target";
import { captureSettingsContext } from "./settings-target";

export type ModelConnectionRequest = {
  provider: string;
  /** The connection to manage, or null to add another one for the provider. */
  credentialId: string | null;
  /** Prefills a compatible endpoint from the server catalog. */
  baseUrl?: string;
  apiProtocol?: ModelApiProtocol;
  /** Only the main model's empty first slot takes the new connection's model on connect. */
  makeDefault: boolean;
  /** Whose main model makeDefault sets: the account's, or a Space's override. */
  target: SettingsTarget;
  /**
   * Set when connecting fills a model slot; managing a connection leaves it unset.
   * May return the screen to continue in, such as the slot's picker for this connection.
   */
  onConnected?: (choice: ModelRoleChoice) => Promise<Href | undefined>;
};

/** Connecting checks the key and a test request with the provider, which a slow one can stretch past the default RPC timeout. */
export const MODEL_CONNECT_TIMEOUT_MS = 60_000;

let nextId = 0;
type StoredRequest = ModelConnectionRequest & {
  context: ReturnType<typeof captureSettingsContext>;
};
const requests = new Map<string, StoredRequest>();

/** Ephemeral, owner-scoped connect requests; never serialized into links or storage. */
export function openModelConnection(request: ModelConnectionRequest): string {
  const id = String(++nextId);
  requests.set(id, { ...request, context: captureSettingsContext(request.target) });
  return id;
}

export function modelConnectionRequest(id: string): StoredRequest | undefined {
  return requests.get(id);
}

export function closeModelConnection(id: string): void {
  requests.delete(id);
}
