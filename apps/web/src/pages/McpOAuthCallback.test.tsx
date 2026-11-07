// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { McpOAuthCallbackPage } from "./McpOAuthCallback";

const complete = vi.hoisted(() => vi.fn());
const replace = vi.fn();

vi.mock("../lib/rpc", () => ({ rpc: { mcp: { oauth: { complete } } } }));
vi.mock("../lib/mcp-connect", () => ({ MCP_OAUTH_CHANNEL: "mcp-oauth-fixture" }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  complete.mockReset();
  replace.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.name = "";
  document.body.replaceChildren();
});

async function render(search: string, popup = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", { replace });
  const channel = { postMessage: vi.fn(), close: vi.fn() };
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage = channel.postMessage;
      close = channel.close;
    },
  );
  window.name = popup ? "mcp-oauth-fixture" : "";
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[`/mcp/oauth/callback${search}`]}>
        <McpOAuthCallbackPage />
      </MemoryRouter>,
    ),
  );
  return { channel, close };
}

it("completes once and restarts the native document at its connected route", async () => {
  complete.mockResolvedValue({ ok: true });
  const { channel, close } = await render("?state=fixture-state&code=fixture-code");
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    sessionId: "fixture-state",
    code: "fixture-code",
    state: "fixture-state",
  });
  expect(channel.postMessage).toHaveBeenCalledWith({ type: "mcp-oauth-complete" });
  expect(channel.close).toHaveBeenCalledOnce();
  expect(replace).toHaveBeenCalledExactlyOnceWith("/app?mcp_oauth=connected");
  expect(close).not.toHaveBeenCalled();
});

it("closes a successful popup without navigating its parent document", async () => {
  complete.mockResolvedValue({ ok: true });
  const { close } = await render("?state=fixture-state&code=fixture-code", true);
  expect(close).toHaveBeenCalledOnce();
  expect(replace).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Connected");
});

it("returns through a fresh document after a cancelled authorization", async () => {
  await render("?error=access_denied");
  expect(complete).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("OAuth connection failed");
  await act(async () => document.querySelector("button")!.click());
  expect(replace).toHaveBeenCalledWith("/app");
});
