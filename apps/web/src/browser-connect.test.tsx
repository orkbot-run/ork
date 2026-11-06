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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(<BrowserConnect />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function code(value: string) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
  expect(host.querySelector("label")?.textContent).toBe("Pairing code");
  expect(host.querySelector("button")!.disabled).toBe(true);
  await code("AB23");
  expect(host.querySelector("button")!.disabled).toBe(true);
  await code("abc-234");
  expect(host.querySelector("button")!.disabled).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it("sends only the normalized code to its own server and renders a sessionless result", async () => {
  const fetcher = vi.fn(async () => Response.json({ paired: true }));
  vi.stubGlobal("fetch", fetcher);
  await code("abc-234");
  await submit();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith(
    "/api/auth/native/pair",
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      body: JSON.stringify({ code: "ABC234" }),
    }),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Paired");
  expect(host.querySelector("form")).toBeNull();
});

it("keeps failed pairing retryable and never renders response details", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ message: "private detail", token: "private token" }, { status: 403 }),
    )
    .mockResolvedValueOnce(Response.json({ paired: true }));
  vi.stubGlobal("fetch", fetcher);
  await code("ABC234");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not pair. Check the code and try again.",
  );
  expect(host.textContent).not.toContain("private");
  expect(host.querySelector("button")!.disabled).toBe(false);
  await submit();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Paired");
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
