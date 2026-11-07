// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 behavior is preserved; startup account refusal changes follow LICENSE.md.

import { i18n } from "@lingui/core";
import { COMPUTER_ACCOUNT_REFUSED_ERROR } from "@orkbot/contracts";
import { MODEL_OUTPUT_CUT_ERROR, MODEL_REQUEST_LIMIT_ERROR, normalizeRunError } from "@orkbot/core";
import { afterEach, expect, it } from "vitest";
import { translateRunError } from "./run-error";
import { errorText } from "./user-error";

afterEach(() => {
  i18n.activate("en");
});

it("translates connection limits while keeping model recovery", () => {
  const translated = "Das Anfragelimit dieser Verbindung ist zu niedrig. Wähle ein anderes Modell.";
  i18n.load("de", { [MODEL_REQUEST_LIMIT_ERROR]: translated });
  i18n.activate("de");
  expect(
    normalizeRunError(MODEL_REQUEST_LIMIT_ERROR, translateRunError, i18n.locale),
  ).toMatchObject({
    summary: translated,
    recovery: "model",
  });
});

it("uses the active Lingui catalog for shared run errors", () => {
  i18n.load("de", {
    "Your model provider": "Dein Modellanbieter",
    "{provider} is rate limiting requests. Try again shortly.":
      "{provider} drosselt Anfragen. Versuche es gleich noch einmal.",
  });
  i18n.activate("de");
  expect(
    normalizeRunError(
      '429: {"message":"API key rate limit exceeded"}',
      translateRunError,
      i18n.locale,
    ).summary,
  ).toBe("Dein Modellanbieter drosselt Anfragen. Versuche es gleich noch einmal.");
});

it("translates the summary of a reply cut off at the output limit", () => {
  i18n.load("de", {
    [MODEL_OUTPUT_CUT_ERROR]:
      "Das Modell hat sein Ausgabelimit erreicht, bevor es die Antwort fertig geschrieben hat.",
  });
  i18n.activate("de");
  expect(normalizeRunError(MODEL_OUTPUT_CUT_ERROR, translateRunError, i18n.locale)).toMatchObject({
    summary:
      "Das Modell hat sein Ausgabelimit erreicht, bevor es die Antwort fertig geschrieben hat.",
    recovery: "model",
  });
});

it("translates the neutral computer account refusal for run and direct boot errors", () => {
  const translated = "Ten serwis nie może uruchamiać komputerów dla tego konta.";
  i18n.load("pl", { [COMPUTER_ACCOUNT_REFUSED_ERROR]: translated });
  i18n.activate("pl");
  expect(normalizeRunError(COMPUTER_ACCOUNT_REFUSED_ERROR, translateRunError).summary).toBe(
    translated,
  );
  expect(errorText(new Error(COMPUTER_ACCOUNT_REFUSED_ERROR))).toBe(translated);
});
