// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import type { ComponentProps, ReactElement } from "react";
import { act, cloneElement } from "react";
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

import { BrowserConnect } from "./browser-connect";

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
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

it("renders pairing without a session request and waits for a canonical six-character code", async () => {
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
    success: "Initialized",
    pending: "Confirm the server in Ork.",
  },
  {
    language: "pl",
    label: "Klucz parowania",
    action: "Inicjalizuj",
    success: "Zainicjalizowano",
    pending: "Potwierdź serwer w aplikacji Ork.",
  },
])(
  "sends only the normalized code and renders a sessionless result in $language",
  async ({ language, label, action, success, pending }) => {
    vi.stubGlobal("navigator", { language });
    await act(async () => root.render(<BrowserConnect />));
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
    expect(host.querySelector('[role="status"]')?.textContent).toBe(success);
    expect(host.querySelector("form")).toBeNull();
  },
);

it("keeps failed pairing retryable and never renders response details", async () => {
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
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Initialized");
});

it("sends only one request while pending and aborts it when the page unmounts", async () => {
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
