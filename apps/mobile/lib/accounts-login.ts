// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { personalActivationMessage } from "@orkbot/contracts";
import { accountsAuthorization, accountsVersion } from "./accounts";
import { AccountsUnavailable } from "./accounts-network";
import { clearSpace, currentApiBase, fetchMobileJson } from "./api";
import { t } from "./i18n";
import { selectInstallationTransport } from "./installation-transport";
import type { StagedPersonalDevice } from "./personal-device";
import {
  activatePersonalDevice,
  forgetPersonalDevice,
  personalCredentialEpoch,
  personalDigest,
  signPersonalDevice,
  stagePersonalDevice,
} from "./personal-device";
import { continueWithPersonalServer, personalLoginSelection } from "./personal-login";
import { selectedWorkspace } from "./selected-workspace";
import { completeServerInitialization, serverInitializationSecret } from "./server-connect";
import { currentSessionGeneration, replaceSessionTokenIfCurrent } from "./session";
import { authErrorText, authResponseErrorText } from "./user-error";

let inFlight = false;

/** Only a short audience-bound proof reaches the selected server. */
export async function continueWithAccountsServer(): Promise<boolean> {
  if (inFlight) return false;
  inFlight = true;
  let staged: StagedPersonalDevice | null = null;
  let activated = false;
  try {
    const server = currentApiBase();
    const sessionGeneration = currentSessionGeneration();
    const accountVersion = accountsVersion();
    const credentialEpoch = personalCredentialEpoch();
    const unchanged = () =>
      server === currentApiBase() &&
      sessionGeneration === currentSessionGeneration() &&
      accountVersion === accountsVersion() &&
      credentialEpoch === personalCredentialEpoch();
    const personal = async (expectedAccount?: string) => {
      const credential = await personalLoginSelection(expectedAccount);
      if (!unchanged()) throw new Error(t("Could not continue"));
      if (!credential) return null;
      if (credential.origin !== server) throw new Error(t("Could not continue"));
      return continueWithPersonalServer(credential, unchanged);
    };
    let authorizationResult: Awaited<ReturnType<typeof accountsAuthorization>>;
    try {
      authorizationResult = await accountsAuthorization();
    } catch (error) {
      if (!(error instanceof AccountsUnavailable)) throw error;
      const renewed = await personal();
      if (renewed !== null) return renewed;
      throw error;
    }
    if (!authorizationResult) {
      const renewed = await personal();
      if (renewed !== null) return renewed;
      throw new Error(t("Could not continue"));
    }
    const authorization = authorizationResult;
    const account = JSON.stringify([authorization.issuer, authorization.subject]);
    const workspace = await selectedWorkspace(account, server);
    await selectInstallationTransport(account, server, workspace ?? undefined);
    if (!unchanged()) throw new Error(t("Could not continue"));
    const current = async () => {
      const latest = await accountsAuthorization();
      if (
        !unchanged() ||
        !latest ||
        latest.issuer !== authorization.issuer ||
        latest.subject !== authorization.subject
      )
        throw new Error(t("Could not continue"));
    };
    await current();
    if (workspace) {
      const renewed = await personal(account);
      if (renewed !== null) return renewed;
      staged = await stagePersonalDevice(account, server, workspace);
      await current();
    }
    const request = async (url: string, body: unknown, central = false) => {
      const result = await fetchMobileJson<Record<string, unknown>>(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(central ? {} : { origin: "orkbot://" }),
            ...(central ? { authorization: `Bearer ${authorization.accessToken}` } : {}),
          },
          body: JSON.stringify(body),
          credentials: "omit",
          redirect: "error",
        },
        {},
      );
      await current();
      if (!result.response.ok || result.invalidJson)
        throw new Error(
          authResponseErrorText(result.response.status, result.body, result.invalidJson),
        );
      return result.body;
    };
    const challenge = await request(
      `${server}/api/auth/native/${workspace ? "workspace/" : ""}challenge`,
      {},
    );
    if (
      typeof challenge.challenge !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge.challenge) ||
      typeof challenge.expiresAt !== "number" ||
      challenge.expiresAt <= Date.now() / 1000 ||
      (workspace ? challenge.version !== 2 : typeof challenge.bootstrapRequired !== "boolean")
    )
      throw new Error(t("Could not continue"));
    const bootstrapSecret = challenge.bootstrapRequired
      ? serverInitializationSecret(server, account)
      : null;
    if (challenge.bootstrapRequired && !bootstrapSecret)
      throw new Error(authErrorText({ code: "REGISTRATION_CLOSED" }, t("Could not continue")));
    const issued = await request(
      `${authorization.issuer.replace(/\/$/, "")}/api/${workspace ? "identity/v2/login-grants" : "server-login-grants"}`,
      workspace
        ? {
            organizationId: workspace.organizationId,
            serverId: workspace.serverId,
            workspaceId: workspace.workspaceId,
            challenge: challenge.challenge,
            ...(staged ? { personalDevice: staged.device } : {}),
          }
        : { origin: server, challenge: challenge.challenge },
      true,
    );
    if (
      typeof issued.grant !== "string" ||
      issued.grant.length > 64 * 1024 ||
      typeof issued.expiresAt !== "number" ||
      issued.expiresAt <= Date.now() / 1000
    )
      throw new Error(t("Could not continue"));
    const deviceSignature =
      staged && workspace
        ? await signPersonalDevice(
            staged.credential,
            personalActivationMessage(
              { ...workspace, deviceId: staged.device.id },
              challenge.challenge,
              personalDigest(issued.grant),
            ),
            staged.epoch,
          )
        : null;
    await current();
    const completed = await request(
      `${server}/api/auth/native/${workspace ? "workspace/" : ""}complete`,
      {
        challenge: challenge.challenge,
        grant: issued.grant,
        ...(bootstrapSecret ? { bootstrapSecret } : {}),
        ...(deviceSignature ? { deviceSignature } : {}),
      },
    );
    if (
      typeof completed.token !== "string" ||
      !completed.token ||
      !completed.user ||
      typeof completed.user !== "object" ||
      !("id" in completed.user) ||
      typeof completed.user.id !== "string" ||
      (workspace &&
        (completed.workspaceId !== workspace.workspaceId ||
          typeof completed.spaceId !== "string" ||
          !completed.spaceId))
    )
      throw new Error(t("Sign-in did not return a session"));
    await current();
    if (completed.personalDevice !== undefined) {
      const device = completed.personalDevice as {
        id?: unknown;
        target?: Record<string, unknown>;
      } | null;
      if (
        !staged ||
        !workspace ||
        device?.id !== staged.device.id ||
        device.target?.deviceId !== staged.device.id ||
        device.target?.serverId !== workspace.serverId ||
        device.target?.workspaceId !== workspace.workspaceId ||
        device.target?.bindingVersion !== workspace.bindingVersion ||
        device.target?.keyFingerprint !== workspace.keyFingerprint
      )
        throw new Error(t("Could not continue"));
    }
    completeServerInitialization(server, account, bootstrapSecret);
    if (!(await clearSpace()))
      throw new Error(t("Could not save your sign-in on this device. Try again."));
    await current();
    if (staged && completed.personalDevice) {
      await activatePersonalDevice(
        staged,
        () =>
          server === currentApiBase() &&
          sessionGeneration === currentSessionGeneration() &&
          accountVersion === accountsVersion(),
      );
    }
    await current();
    const saved = await replaceSessionTokenIfCurrent(sessionGeneration, completed.token, "sign_in");
    activated = saved && !!completed.personalDevice;
    return saved;
  } finally {
    try {
      if (staged && !activated) await forgetPersonalDevice(staged.credential);
    } finally {
      inFlight = false;
    }
  }
}
