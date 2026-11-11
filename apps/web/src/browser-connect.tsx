// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServerConnectLink } from "@orkbot/contracts";
import { ArrowRight, ArrowUpRight, Download, Server } from "lucide-react";
import { useEffect, useState } from "react";
import "./styles.css";

export type ServerPageState = "loading" | "setup" | "connected" | "unknown" | "unavailable";

/** This page identifies its own server. Query strings can never choose a different target. */
export function BrowserConnect() {
  const [state, setState] = useState<ServerPageState>("loading");
  const [checkAttempt, setCheckAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const response = await fetch("/api/auth/native/workspace-status", {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) throw new Error("Workspace status unavailable");
        const result = await response.json();
        if (!result || !["connected", "unconnected", "unknown"].includes(result.status))
          throw new Error("Invalid workspace status");
        if (controller.signal.aborted) return;
        setState(result.status === "unconnected" ? "setup" : result.status);
        timer = setTimeout(() => void check(), 10_000);
      } catch {
        if (!controller.signal.aborted) {
          setState("unavailable");
          timer = setTimeout(() => void check(), 10_000);
        }
      }
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [checkAttempt]);
  return (
    <BrowserConnectView
      state={state}
      onRetry={() => {
        setState("loading");
        setCheckAttempt((n) => n + 1);
      }}
    />
  );
}

export function BrowserConnectView({
  state,
  onRetry,
}: {
  state: ServerPageState;
  onRetry: () => void;
}) {
  const polish = navigator.language.toLowerCase().startsWith("pl");
  let link: string | undefined;
  try {
    link = createServerConnectLink(window.location.origin);
  } catch {
    /* Public HTTP cannot safely hand off authentication. */
  }
  const setup = state === "setup";
  const connected = state === "connected";
  const unavailable = state === "unavailable";
  const loading = state === "loading";
  const title = loading
    ? polish
      ? "Sprawdzamy Twój serwer"
      : "Checking your server"
    : setup
      ? polish
        ? "Twój serwer Ork jest gotowy"
        : "Your Ork server is ready"
      : unavailable
        ? polish
          ? "Nie udało się sprawdzić serwera"
          : "Could not check the server"
        : polish
          ? "Twój serwer Ork działa"
          : "Your Ork server is running";
  const description = loading
    ? polish
      ? "Sprawdzamy stan serwera."
      : "Checking the server status."
    : setup
      ? polish
        ? "Połącz go z workspace, aby zacząć korzystać z Ork."
        : "Connect it to a workspace to get started with Ork."
      : unavailable
        ? polish
          ? "Spróbuj ponownie lub sprawdź połączenie z workspace w panelu Ork."
          : "Try again or check your workspace connection in the Ork dashboard."
        : connected
          ? polish
            ? "Otwórz aplikację Ork, aby korzystać ze swojego workspace."
            : "Open the Ork app to use your workspace."
          : polish
            ? "Stan połączenia z workspace sprawdzisz w panelu Ork."
            : "Check the workspace connection status in the Ork dashboard.";
  const primary =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90";
  const secondary =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-5 text-sm font-medium hover:bg-secondary";
  return (
    <main className="min-h-full bg-background px-5 text-foreground sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between gap-4 border-b border-border py-5">
          <div className="flex items-center gap-3">
            <img src="/favicon.png" alt="" className="size-10 rounded-xl" />
            <div>
              <p className="font-semibold">Ork</p>
              <p className="text-xs text-muted-foreground">
                {polish ? "Twój serwer" : "Your server"}
              </p>
            </div>
          </div>
          <a
            href="https://ork.run/download/"
            className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <Download aria-hidden="true" className="size-4" />
            {polish ? "Pobierz aplikację" : "Get the app"}
          </a>
        </header>
        <section className="grid gap-8 py-12 sm:py-16 md:grid-cols-[1.25fr_0.75fr] md:items-center">
          <div className="space-y-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {polish ? "Twój serwer" : "Your server"}
            </p>
            <h1 className="max-w-xl text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
            <p className="max-w-xl text-base leading-7 text-muted-foreground">{description}</p>
            <div className="flex flex-wrap gap-3">
              {connected && link && (
                <a className={primary} href={link}>
                  {polish ? "Otwórz w Orku" : "Open in Ork"}
                  <ArrowUpRight aria-hidden="true" className="size-4" />
                </a>
              )}
              {!loading && (
                <a className={connected && link ? secondary : primary} href="https://app.ork.run">
                  {setup
                    ? polish
                      ? "Połącz workspace"
                      : "Connect a workspace"
                    : polish
                      ? "Przejdź do panelu"
                      : "Go to dashboard"}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </a>
              )}
              {unavailable && (
                <button type="button" className={secondary} onClick={onRetry}>
                  {polish ? "Sprawdź ponownie" : "Check again"}
                </button>
              )}
              {!loading && !connected && link && (
                <a className={secondary} href={link}>
                  {polish ? "Otwórz w Orku" : "Open in Ork"}
                  <ArrowUpRight aria-hidden="true" className="size-4" />
                </a>
              )}
            </div>
            {setup && (
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                {polish
                  ? "Otwórz link wyświetlony w terminalu po instalacji. Możesz też wpisać kod ręcznie w panelu workspace."
                  : "Open the link shown in the terminal after installation, or enter the code in your workspace dashboard."}
              </p>
            )}
          </div>
          <div className="rounded-2xl border border-border bg-card p-6 sm:p-7">
            <div className="flex items-start gap-4">
              <div className="rounded-xl bg-secondary p-3">
                <Server aria-hidden="true" className="size-5" />
              </div>
              <div className="min-w-0">
                <h2 className="font-semibold">{polish ? "Ten serwer" : "This server"}</h2>
                <p className="mt-1 break-all text-sm text-muted-foreground">
                  {window.location.host}
                </p>
              </div>
            </div>
            <div className="mt-6 space-y-3 border-t border-border pt-5 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{polish ? "Serwer" : "Server"}</span>
                <span role="status" className="text-right font-medium">
                  {loading
                    ? polish
                      ? "Sprawdzanie..."
                      : "Checking..."
                    : unavailable
                      ? polish
                        ? "Nieznany"
                        : "Unknown"
                      : polish
                        ? "Odpowiada"
                        : "Responding"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Workspace</span>
                <span className="text-right font-medium">
                  {connected
                    ? polish
                      ? "Połączony"
                      : "Connected"
                    : polish
                      ? "Sprawdź w panelu"
                      : "Check dashboard"}
                </span>
              </div>
            </div>
            {!connected && (
              <p className="mt-5 text-xs leading-5 text-muted-foreground">
                {polish
                  ? "Stan połączenia z workspace sprawdzisz w panelu Ork."
                  : "Check the workspace connection status in the Ork dashboard."}
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
