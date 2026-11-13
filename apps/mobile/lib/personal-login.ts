// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { personalOfflineMessage, personalServerMessage } from "@orkbot/contracts";
import { accountsConfiguration, accountsLocalIdentity, accountsVersion } from "./accounts";
import { clearSpace, currentApiBase, fetchMobileJson } from "./api";
import type { PersonalCredential } from "./personal-device";
import {
  personalCredential,
  personalCredentialEpoch,
  signPersonalDevice,
  verifyPersonalServer,
} from "./personal-device";
import { selectedWorkspaceSnapshot } from "./selected-workspace";
import { currentSessionGeneration, replaceSessionTokenIfCurrent } from "./session";

const refused = () => new Error("Could not continue");
export async function personalLoginSelection(
  expectedAccount?: string,
): Promise<PersonalCredential | null> {
  const snapshot = await selectedWorkspaceSnapshot();
  if (!snapshot || (expectedAccount && snapshot.account !== expectedAccount)) return null;
  const identity = await accountsLocalIdentity();
  if (!identity || snapshot.account !== JSON.stringify([identity.issuer, identity.subject]))
    return null;
  const credential = await personalCredential(snapshot.account, snapshot.server, snapshot.target);
  if (!credential) return null;
  const configuration = await accountsConfiguration();
  return JSON.parse(credential.account)[0] === configuration.issuer ? credential : null;
}

/** Renew only the exact selected personal workspace without contacting Accounts. */
export async function continueWithPersonalServer(
  credential: PersonalCredential,
  current: () => boolean,
): Promise<boolean> {
  const origin = currentApiBase();
  const session = currentSessionGeneration();
  const account = accountsVersion();
  const epoch = personalCredentialEpoch();
  const check = () => {
    if (
      !current() ||
      origin !== credential.origin ||
      origin !== currentApiBase() ||
      session !== currentSessionGeneration() ||
      account !== accountsVersion() ||
      epoch !== personalCredentialEpoch()
    )
      throw refused();
  };
  const request = async (path: string, body: unknown) => {
    check();
    const result = await fetchMobileJson<Record<string, unknown>>(
      `${origin}/api/auth/native/workspace/personal/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "orkbot://" },
        credentials: "omit",
        redirect: "error",
        body: JSON.stringify(body),
      },
      {},
    );
    check();
    if (!result.response.ok || result.invalidJson) throw refused();
    return result.body;
  };
  check();
  const challenge = await request("challenge", { deviceId: credential.deviceId });
  const target = { ...credential.target, deviceId: credential.deviceId };
  const returned = challenge.target as Record<string, unknown> | null;
  if (
    challenge.version !== 1 ||
    typeof challenge.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge.challenge) ||
    typeof challenge.expiresAt !== "number" ||
    challenge.expiresAt <= Date.now() / 1000 ||
    challenge.expiresAt > Date.now() / 1000 + 125 ||
    !returned ||
    Object.entries(target)
      .filter(([key]) => key !== "organizationId")
      .some(([key, value]) => returned[key] !== value) ||
    typeof challenge.publicKey !== "string" ||
    typeof challenge.signature !== "string" ||
    !(await verifyPersonalServer(
      credential,
      challenge.publicKey,
      personalServerMessage(target, challenge.challenge),
      challenge.signature,
    ))
  )
    throw refused();
  check();
  const signature = await signPersonalDevice(
    credential,
    personalOfflineMessage(target, challenge.challenge),
    epoch,
  );
  check();
  const completed = await request("complete", {
    deviceId: credential.deviceId,
    challenge: challenge.challenge,
    signature,
  });
  if (
    typeof completed.token !== "string" ||
    !completed.token ||
    completed.token.length > 16 * 1024 ||
    !completed.user ||
    typeof completed.user !== "object" ||
    !("id" in completed.user) ||
    typeof completed.user.id !== "string" ||
    !completed.user.id ||
    completed.workspaceId !== target.workspaceId ||
    typeof completed.spaceId !== "string" ||
    !completed.spaceId
  )
    throw refused();
  check();
  if (!(await clearSpace())) throw refused();
  check();
  return replaceSessionTokenIfCurrent(session, completed.token, "sign_in");
}
