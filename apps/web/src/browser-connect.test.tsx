// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import type { ComponentProps, ReactElement } from "react";
import { act, cloneElement, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@orkbot/ui-web", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Button: ({
    render,
    nativeButton: _nativeButton,
    ...props
  }: ComponentProps<"button"> & { render?: ReactElement; nativeButton?: boolean }) =>
    render ? cloneElement(render, props) : <button {...props} />,
}));

import { BrowserConnect, BrowserConnectView } from "./browser-connect";
import { BrowserPairing } from "./browser-pairing";

function PairingHarness() {
  const [paired, setPaired] = useState(false);
  return paired ? (
    <a href="https://ork.run/download/">Download</a>
  ) : (
    <BrowserPairing
      polish={navigator.language.toLowerCase().startsWith("pl")}
      onPaired={() => setPaired(true)}
    />
  );
}
async function showPairing() {
  await act(async () => root.render(<PairingHarness />));
}

let host: HTMLDivElement;
let root: Root;
let initializationFetch = vi.fn();
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  initializationFetch = vi.fn(async () => Response.json({ status: "unconnected" }));
  vi.stubGlobal("fetch", initializationFetch);
  root = createRoot(host);
  await act(async () => root.render(<BrowserConnect />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function code(value: string) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function poll() {
  await act(async () => vi.advanceTimersByTimeAsync(2000));
}
async function submit() {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("explains workspace setup without deployment-specific instructions", () => {
  expect(host.textContent).toContain("Connect a workspace");
  expect(host.querySelector('a[href="https://app.ork.run"]')?.textContent).toBe(
    "Connect a workspace",
  );
  expect(host.textContent).not.toContain("Find the link or code");
  expect(host.textContent).not.toContain("EasyPanel");
});

it("checks initialization without a session request and waits for a canonical six-character code", async () => {
  expect(host.querySelector("#pairing-code")).toBeNull();
  await showPairing();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(host.querySelector("label")?.textContent).toBe("Pairing key");
  expect(host.querySelector("button")!.disabled).toBe(true);
  await code("AB23");
  expect(host.querySelector("button")!.disabled).toBe(true);
  await code("abc-234");
  expect(host.querySelector("button")!.disabled).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  {
    language: "en",
    label: "Pairing key",
    action: "Initialize",
    pending: "Confirm the server in Ork.",
  },
  {
    language: "pl",
    label: "Klucz parowania",
    action: "Inicjalizuj",
    pending: "Potwierdź serwer w aplikacji Ork.",
  },
])(
  "sends only the normalized code and renders a sessionless result in $language",
  async ({ language, label, action, pending }) => {
    vi.stubGlobal("navigator", { language });
    await showPairing();
    expect(host.querySelector("label")?.textContent).toBe(label);
    expect(host.querySelector("button")?.textContent).toBe(action);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ pending: true, pairingId: "p".repeat(43) }, { status: 202 }),
      )
      .mockResolvedValueOnce(Response.json({ pending: true }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("Lost completion response"))
      .mockResolvedValueOnce(Response.json({ paired: true }));
    vi.stubGlobal("fetch", fetcher);
    await code("abc-234");
    await submit();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(pending);
    await poll();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(pending);
    await poll();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(pending);
    await poll();
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [url, request] of fetcher.mock.calls.slice(1) as unknown as [
      string,
      RequestInit,
    ][]) {
      expect(url).toBe("/api/auth/native/pair/status");
      expect(JSON.parse(request.body as string)).toEqual({ pairingId: "p".repeat(43) });
    }
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/auth/native/pair",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        body: JSON.stringify({ code: "ABC234" }),
      }),
    );
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('a[href="https://ork.run/download/"]')).not.toBeNull();
    expect(host.querySelector("form")).toBeNull();
  },
);

it("keeps failed pairing retryable and never renders response details", async () => {
  await showPairing();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ message: "private detail", token: "private token" }, { status: 403 }),
    )
    .mockResolvedValueOnce(
      Response.json({ pending: true, pairingId: "p".repeat(43) }, { status: 202 }),
    )
    .mockResolvedValueOnce(Response.json({ paired: true }));
  vi.stubGlobal("fetch", fetcher);
  await code("ABC234");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not initialize. Check the key and try again.",
  );
  expect(host.textContent).not.toContain("private");
  expect(host.querySelector("button")!.disabled).toBe(false);
  await submit();
  await poll();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(host.querySelector("form")).toBeNull();
});

it("sends only one request while pending and aborts it when the page unmounts", async () => {
  await showPairing();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetcher);
  await code("ABC234");
  await submit();
  await submit();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(host.querySelector("button")!.disabled).toBe(true);
  const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  root = createRoot(host);
});

it("stops approval polling when the page is retired", async () => {
  await showPairing();
  const fetcher = vi.fn(async () =>
    Response.json({ pending: true, pairingId: "p".repeat(43) }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetcher);
  await code("ABC234");
  await submit();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Confirm the server in Ork.");
  await act(async () => root.unmount());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetcher).toHaveBeenCalledOnce();
  root = createRoot(host);
});

async function remount(fetcher: typeof initializationFetch) {
  await act(async () => root.unmount());
  vi.stubGlobal("fetch", fetcher);
  root = createRoot(host);
  await act(async () => root.render(<BrowserConnect />));
}

it("shows the native handoff and workspace guidance for an initialized server", async () => {
  const fetcher = vi.fn(async () => Response.json({ status: "unknown" }));
  await remount(fetcher);
  expect(host.querySelector("form")).toBeNull();
  expect(host.querySelector('input[id="pairing-code"]')).toBeNull();
  expect(host.querySelectorAll("a")).toHaveLength(3);
  expect(host.querySelector('a[href^="orkbot://connect"]')?.textContent).toBe("Open in Ork");
  expect(host.textContent).toContain("Responding");
  expect(host.textContent).toContain("Check the workspace connection status");
  expect(host.querySelector('a[href="https://ork.run/download/"]')?.textContent).toBe(
    "Get the app",
  );
  expect(fetcher).toHaveBeenCalledWith(
    "/api/auth/native/workspace-status",
    expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-store" }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("shows the ready-server guidance in Polish", async () => {
  vi.stubGlobal("navigator", { language: "pl-PL" });
  await remount(vi.fn(async () => Response.json({ status: "unknown" })));
  expect(host.textContent).toContain("Odpowiada");
  expect(host.textContent).toContain("Otwórz w Orku");
  expect(host.textContent).toContain("Pobierz aplikację");
});

it("does not flash pairing while initialization state is loading", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await remount(fetcher);
  expect(host.querySelector("form")).toBeNull();
  await act(async () => resolve(Response.json({ status: "unknown" })));
  expect(host.querySelector("form")).toBeNull();
});

it("retires pairing when the server is initialized from another page", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status: "unconnected" }))
    .mockResolvedValueOnce(Response.json({ status: "unknown" }));
  await remount(fetcher);
  expect(host.querySelector("form")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(host.querySelector("form")).toBeNull();
  expect(host.textContent).toContain("Responding");
});

it("keeps pairing hidden on an unavailable or malformed state and permits a safe retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status: "invalid", token: "secret-fixture-token" }))
    .mockResolvedValueOnce(Response.json({ status: "unconnected" }));
  await remount(fetcher);
  expect(host.querySelector("form")).toBeNull();
  expect(host.textContent).not.toContain("secret-fixture-token");
  const retry = host.querySelector("button")!;
  expect(retry.textContent).toBe("Check again");
  await act(async () => retry.click());
  expect(host.querySelector("form")).toBeNull();
  expect(host.textContent).toContain("Responding");
});

it("shows connected actions when a workspace connection is confirmed", async () => {
  await act(async () => root.render(<BrowserConnectView state="connected" onRetry={() => {}} />));
  expect(host.textContent).toContain("Connected");
  expect(host.textContent).toContain("Open in Ork");
  expect(host.textContent).toContain("Go to dashboard");
  expect(host.textContent).not.toContain("Check the workspace connection status");
});

it("shows connected only on a confirmed workspace status and clears it on error", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status: "connected" }))
    .mockRejectedValueOnce(new Error("offline"));
  await remount(fetcher);
  expect(host.textContent).toContain("Connected");
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(host.textContent).not.toContain("Connected");
  expect(host.textContent).toContain("Could not check the server");
});

it.each(["setup", "unavailable"] as const)(
  "keeps the native app link available when status is %s",
  async (state) => {
    await act(async () => root.render(<BrowserConnectView state={state} onRetry={() => {}} />));
    expect(host.querySelector('a[href^="orkbot://connect"]')?.textContent).toBe("Open in Ork");
  },
);
