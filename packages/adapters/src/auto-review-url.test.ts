// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import { newSiteUrlNeedsOwner } from "./auto-review-url.js";

it.each([
  ["https://owner-code.docs.example.org/guide", ["OWNER-CODE"]],
  ["https://docs.example.org/account/private%20value", ["private value"]],
  ["https://docs.example.org/releases?employee=dana%40example.com", []],
  ["https://docs.example.org/releases?api_key=synthetic-key", []],
  ["https://docs.example.org/guide#access_token=synthetic-key", []],
  ["https://name:synthetic-password@docs.example.org/guide", []],
] as const)("holds high-confidence private values locally for %s", (address, secrets) => {
  expect(newSiteUrlNeedsOwner(address, secrets)).toBe(true);
});

it("leaves ordinary search terms and public anchors to the reviewer", () => {
  expect(
    newSiteUrlNeedsOwner("https://docs.example.org/search?q=Lisbon#release-notes", ["unrelated"]),
  ).toBe(false);
});
