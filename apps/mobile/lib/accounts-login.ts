// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { accountsAuthorization } from "./accounts";
import { clearSpace, currentApiBase, fetchMobileJson } from "./api";
import { t } from "./i18n";
import { completeServerInitialization, serverInitializationSecret } from "./server-connect";
import { currentSessionGeneration, replaceSessionTokenIfCurrent } from "./session";
import { authErrorText, authResponseErrorText } from "./user-error";

let inFlight = false;

/** Only a short audience-bound proof reaches the selected server. */
export async function continueWithAccountsServer(): Promise<boolean> {
  if (inFlight) return false;
  inFlight = true;
  try {
    const server = currentApiBase();
    const sessionGeneration = currentSessionGeneration();
    const authorization = await accountsAuthorization();
    if (!authorization) throw new Error(t("Could not continue"));
    const account = JSON.stringify([authorization.issuer, authorization.subject]);
    const current = async () => {
      const latest = await accountsAuthorization();
      if (
        server !== currentApiBase() ||
        sessionGeneration !== currentSessionGeneration() ||
        !latest ||
        latest.issuer !== authorization.issuer ||
        latest.subject !== authorization.subject
      )
        throw new Error(t("Could not continue"));
    };
    await current();
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
    const challenge = await request(`${server}/api/auth/native/challenge`, {});
    if (
      typeof challenge.challenge !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge.challenge) ||
      typeof challenge.expiresAt !== "number" ||
      challenge.expiresAt <= Date.now() / 1000 ||
      typeof challenge.bootstrapRequired !== "boolean"
    )
      throw new Error(t("Could not continue"));
    const bootstrapSecret = challenge.bootstrapRequired
      ? serverInitializationSecret(server, account)
      : null;
    if (challenge.bootstrapRequired && !bootstrapSecret)
      throw new Error(authErrorText({ code: "REGISTRATION_CLOSED" }, t("Could not continue")));
    const issued = await request(
      `${authorization.issuer.replace(/\/$/, "")}/api/server-login-grants`,
      { origin: server, challenge: challenge.challenge },
      true,
    );
    if (
      typeof issued.grant !== "string" ||
      issued.grant.length > 64 * 1024 ||
      typeof issued.expiresAt !== "number" ||
      issued.expiresAt <= Date.now() / 1000
    )
      throw new Error(t("Could not continue"));
    const completed = await request(`${server}/api/auth/native/complete`, {
      challenge: challenge.challenge,
      grant: issued.grant,
      ...(bootstrapSecret ? { bootstrapSecret } : {}),
    });
    if (
      typeof completed.token !== "string" ||
      !completed.token ||
      !completed.user ||
      typeof completed.user !== "object" ||
      !("id" in completed.user) ||
      typeof completed.user.id !== "string"
    )
      throw new Error(t("Sign-in did not return a session"));
    await current();
    completeServerInitialization(server, account, bootstrapSecret);
    if (!(await clearSpace()))
      throw new Error(t("Could not save your sign-in on this device. Try again."));
    await current();
    return await replaceSessionTokenIfCurrent(sessionGeneration, completed.token, "sign_in");
  } finally {
    inFlight = false;
  }
}
