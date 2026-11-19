// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import { hasUnfinishedActionPromise } from "./action-continuation.js";

it.each([
  "Sprawdzę to teraz.",
  "Sprawdzę, czy testy przechodzą.",
  "Gotowe z pierwszym. Teraz uruchomię testy.",
  "I'll inspect the logs now.",
  "Done with the first task. Next I will check the second directory.",
  "Let me open the application.",
  "I'll look at https://example.test/?page=1.",
  "I'll check it. Give me a moment.",
  "I’m going to run the tests.",
])("detects an unfinished action: %s", (text) => {
  expect(hasUnfinishedActionPromise(text)).toBe(true);
});

it.each([
  "Sprawdziłem to. Testy przeszły.",
  "I checked the logs and fixed the issue.",
  "I'll check it. Would you like me to continue?",
  "Sprawdzę to, jeśli potwierdzisz.",
  "Nie mogę kontynuować. Sprawdzę to po zgodzie.",
  "I will run it after approval. Please confirm first.",
  "I cannot do that. I'll check after approval.",
  "I'll check it. One finished result. Another finished result.",
  "The documentation says `I'll run the tool`.",
  "I said “I'll check the logs.” The logs are clean.",
  "Please pick a directory. I'll inspect it.",
  "I'll be happy to help.",
  "The price will change tomorrow.",
])("does not continue a completed reply or interaction boundary: %s", (text) => {
  expect(hasUnfinishedActionPromise(text)).toBe(false);
});
