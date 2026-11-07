// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is retained; send target consent additions follow LICENSE.md.
import type { AiConsentStatus, AiDataUse, AiRecipient, SettingsScope } from "@orkbot/contracts";
import { AI_CONSENT_REQUIRED, AI_PRIVACY_URL, SettingsScopeSchema } from "@orkbot/contracts";

/** A foreground check failed before the requested mutation was dispatched. */
export class AiConsentBlocked extends Error {
  constructor(message = AI_CONSENT_REQUIRED, cause?: unknown) {
    super(message);
    // Keeps an unreachable server recognizable behind the consent check.
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, writable: true, configurable: true });
    }
  }
}

const pendingAiConsent = new Map<string, Promise<void>>();

/** Only user actions that can start AI processing need a foreground disclosure. */
export function aiDataUsesForProcedure(procedure: string, input?: unknown): AiDataUse[] {
  const path = procedure.replaceAll(".", "/");
  if (
    path === "routines/update" &&
    input &&
    typeof input === "object" &&
    "active" in input &&
    input.active === false
  )
    return [];
  if (
    [
      "threads/send",
      "threads/sendWithRoutines",
      "artifacts/create",
      "threads/followUp",
      "threads/react",
      "threads/answer",
      "routines/create",
      "routines/update",
      "routines/testRun",
    ].includes(path)
  )
    return ["model", "memory"];
  if (["voice/prepare", "voice/speak", "voice/transcribe"].includes(path)) return ["voice"];
  return [];
}

export async function ensureAiDataConsent(options: {
  uses: AiDataUse[];
  status(): Promise<AiConsentStatus>;
  prompt(recipient: AiRecipient, privacyUrl?: string): Promise<boolean>;
  allow(input: { scope: string; version: string; keys: string[] }): Promise<unknown>;
  /** Separates independent API servers before the account-space scope is applied. */
  coalesceKey?: string;
}) {
  if (options.uses.length === 0) return;
  try {
    const status = await options.status();
    for (const recipient of status.recipients) {
      if (recipient.allowed || !options.uses.includes(recipient.use)) continue;
      const key = [options.coalesceKey ?? "", status.scope, status.version, recipient.key].join(
        "\u0000",
      );
      let pending = pendingAiConsent.get(key);
      if (!pending) {
        pending = (async () => {
          if (!(await options.prompt(recipient, status.privacyUrl)))
            throw new Error(AI_CONSENT_REQUIRED);
          await options.allow({
            scope: status.scope,
            version: status.version,
            keys: [recipient.key],
          });
        })().finally(() => {
          if (pendingAiConsent.get(key) === pending) pendingAiConsent.delete(key);
        });
        pendingAiConsent.set(key, pending);
      }
      await pending;
    }
  } catch (error) {
    throw new AiConsentBlocked(error instanceof Error ? error.message : AI_CONSENT_REQUIRED, error);
  }
}

export function aiConsentTarget(input: unknown): {
  botId?: string;
  groupId?: string;
  routineId?: string;
  routineIds?: string[];
  settingsScope?: SettingsScope;
} {
  if (!input || typeof input !== "object") return {};
  // A request that names a settings copy is asked about that copy's recipients.
  const scope = SettingsScopeSchema.safeParse((input as { scope?: unknown }).scope).data;
  const thread = threadConsentTarget(input);
  return scope ? { ...thread, settingsScope: scope } : thread;
}

function threadConsentTarget(input: object): {
  botId?: string;
  groupId?: string;
  routineId?: string;
  routineIds?: string[];
} {
  const target = input as {
    botId?: unknown;
    groupId?: unknown;
    routineId?: unknown;
    routineIds?: unknown;
  };
  const routineId = typeof target.routineId === "string" ? target.routineId : undefined;
  const routines = {
    ...(routineId ? { routineId } : {}),
    ...(Array.isArray(target.routineIds) && target.routineIds.every((id) => typeof id === "string")
      ? { routineIds: [...new Set(target.routineIds as string[])] }
      : {}),
  };
  if (typeof target.groupId === "string") {
    return { groupId: target.groupId, ...routines };
  }
  if (typeof target.botId === "string") {
    return { botId: target.botId, ...routines };
  }
  return routines;
}

/** Never let server-supplied policy metadata launch an executable or credential-bearing URL. */
export function aiConsentPrivacyUrl(value: string = AI_PRIVACY_URL) {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    // Invalid metadata falls back to the product's policy.
  }
  return AI_PRIVACY_URL;
}
