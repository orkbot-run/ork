// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import { browserEntry } from "./browser-entry";

it.each([
  "/",
  "/app",
  "/sign-in",
  "/sign-up",
  "/onboarding",
  "/app?native=true",
  "/sso/callback/other",
])("limits browser route %s to the native handoff", (path) => {
  expect(browserEntry(path, false)).toBe("connect");
  expect(browserEntry(path, true)).toBe("native");
});

it.each([
  "/sso/callback",
  "/integrations/callback",
  "/mcp/oauth/callback",
  "/messaging/slack/callback",
])("preserves protocol callback %s without exposing the product", (path) => {
  expect(browserEntry(path, false)).toBe("callback");
  expect(browserEntry(path, true)).toBe("callback");
});
