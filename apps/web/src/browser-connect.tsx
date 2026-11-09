// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServerConnectLink } from "@orkbot/contracts";
import { Button } from "@orkbot/ui-web";
import {
  ArrowRight,
  ArrowUpRight,
  CircleHelp,
  Download,
  LockKeyhole,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./styles.css";

/** This page identifies its own server. Query strings can never choose a different target. */
export function BrowserConnect() {
  const polish = navigator.language.toLowerCase().startsWith("pl");
  const [initialization, setInitialization] = useState<
    "loading" | "required" | "complete" | "unavailable"
  >("loading");
  const [checkAttempt, setCheckAttempt] = useState(0);
  const initialized = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      if (controller.signal.aborted || initialized.current) return;
      try {
        const response = await fetch("/api/auth/native/initialization", {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) throw new Error("Initialization state unavailable");
        const state = await response.json();
        if (!state || typeof state.required !== "boolean")
          throw new Error("Invalid initialization state");
        if (controller.signal.aborted || initialized.current) return;
        initialized.current = !state.required;
        setInitialization(state.required ? "required" : "complete");
        if (state.required) timer = setTimeout(() => void check(), 5_000);
      } catch {
        if (!controller.signal.aborted && !initialized.current) setInitialization("unavailable");
      }
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [checkAttempt]);

  let link: string | undefined;
  try {
    link = createServerConnectLink(window.location.origin);
  } catch {
    // Public plain HTTP cannot safely hand off authentication to a native client.
  }
  const serverAvailable = initialization === "required" || initialization === "complete";
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
              {polish ? "Witaj na swoim serwerze" : "Welcome to your server"}
            </p>
            <h1 className="max-w-xl text-4xl font-semibold tracking-tight sm:text-5xl">
              {polish ? "Twój Ork. Twoja przestrzeń." : "Your Ork. Your workspace."}
            </h1>
            <p className="max-w-xl text-base leading-7 text-muted-foreground">
              {polish
                ? "Ten serwer jest domem dla Twoich botów. Połącz go z workspace’em, aby zarządzać nim w dashboardzie, lub otwórz go w aplikacji Ork."
                : "This server is home to your bots. Connect it to a workspace to manage it in the dashboard, or open it in the Ork app."}
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href="#workspace-setup"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                {polish ? "Połącz workspace" : "Connect a workspace"}
                <ArrowRight aria-hidden="true" className="size-4" />
              </a>
              {link && (
                <Button
                  nativeButton={false}
                  role="link"
                  variant="outline"
                  render={<a href={link} />}
                >
                  <span>{polish ? "Otwórz w Orku" : "Open in Ork"}</span>
                  <ArrowUpRight aria-hidden="true" className="size-4" />
                </Button>
              )}
            </div>
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
                <span className="text-muted-foreground">
                  {polish ? "Odpowiedź serwera" : "Server response"}
                </span>
                <span role="status" className="text-right font-medium">
                  {initialization === "loading"
                    ? polish
                      ? "Sprawdzanie…"
                      : "Checking…"
                    : serverAvailable
                      ? polish
                        ? "Odpowiada"
                        : "Responding"
                      : polish
                        ? "Niedostępna"
                        : "Unavailable"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">
                  {polish ? "Połączenie" : "Connection"}
                </span>
                <span className="font-medium">
                  {window.location.protocol === "https:" ? "HTTPS" : "HTTP"}
                </span>
              </div>
            </div>
            <p className="mt-5 text-xs leading-5 text-muted-foreground">
              {polish
                ? "Odpowiedź serwera nie potwierdza jeszcze połączenia z workspace’em. Jego status sprawdzisz w dashboardzie."
                : "A server response does not confirm a workspace connection. Check its status in the dashboard."}
            </p>
            {initialization === "unavailable" && (
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => {
                  setInitialization("loading");
                  setCheckAttempt((value) => value + 1);
                }}
              >
                {polish ? "Spróbuj ponownie" : "Retry"}
              </Button>
            )}
          </div>
        </section>

        {/* App pairing is temporarily hidden. BrowserPairing is retained in browser-pairing.tsx. */}
        <section id="workspace-setup" className="scroll-mt-6 border-t border-border py-12 sm:py-16">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {polish ? "Konfiguracja workspace’u" : "Workspace setup"}
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">
              {polish ? "Połącz serwer z workspace’em" : "Connect your server to a workspace"}
            </h2>
            <p className="mt-4 leading-7 text-muted-foreground">
              {polish
                ? "Potrzebujesz dostępu do hosta oraz konta administratora workspace’u. Połączenie potwierdzisz jednorazowym kodem."
                : "You’ll need access to the host and a workspace administrator account. A one-time code confirms the connection."}
            </p>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <article className="rounded-2xl border border-border bg-card p-6">
              <div className="flex items-center justify-between">
                <Terminal aria-hidden="true" className="size-5" />
                <span className="text-xs font-semibold text-muted-foreground">01</span>
              </div>
              <h3 className="mt-5 font-semibold">
                {polish ? "Otwórz konsolę API" : "Open the API console"}
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {polish
                  ? "Potrzebujesz dostępu do serwera, na którym działa Ork."
                  : "You need access to the server running Ork."}
              </p>
            </article>
            <article className="rounded-2xl border border-border bg-card p-6">
              <div className="flex items-center justify-between">
                <LockKeyhole aria-hidden="true" className="size-5" />
                <span className="text-xs font-semibold text-muted-foreground">02</span>
              </div>
              <h3 className="mt-5 font-semibold">{polish ? "Wygeneruj kod" : "Generate a code"}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {polish
                  ? "Wygeneruj kod konfiguracji na serwerze. Kod jest ważny przez krótki czas i należy go zachować dla siebie."
                  : "Generate a setup code on the server. The code expires shortly and should be kept private."}
              </p>
            </article>
            <article className="rounded-2xl border border-border bg-card p-6">
              <div className="flex items-center justify-between">
                <ShieldCheck aria-hidden="true" className="size-5" />
                <span className="text-xs font-semibold text-muted-foreground">03</span>
              </div>
              <h3 className="mt-5 font-semibold">
                {polish ? "Potwierdź w dashboardzie" : "Confirm in the dashboard"}
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {polish
                  ? "Wybierz organizację, otwórz Server i wpisz kod. Przed potwierdzeniem sprawdź adres serwera."
                  : "Choose your organization, open Server, and enter the code. Check the server address before confirming."}
              </p>
            </article>
          </div>
        </section>
        <section className="border-t border-border py-12">
          <div className="flex gap-3">
            <CircleHelp aria-hidden="true" className="mt-1 size-5 shrink-0" />
            <div>
              <h2 className="text-xl font-semibold">
                {polish ? "Warto wiedzieć" : "Good to know"}
              </h2>
              <div className="mt-5 grid gap-5 text-sm leading-6 text-muted-foreground sm:grid-cols-2">
                <p>
                  {polish
                    ? "Adres serwera wskazuje, z czym ma połączyć się aplikacja. Sam adres nie przyznaje dostępu ani nie potwierdza workspace’u."
                    : "The server address tells the app where to connect. The address alone does not grant access or verify a workspace."}
                </p>
                <p>
                  {polish
                    ? "Jeśli połączenie się nie powiedzie, sprawdź publiczny adres HTTPS i upewnij się, że zatwierdzasz kod właściwym kontem. Nie usuwaj danych serwera podczas diagnozy."
                    : "If connection fails, check the public HTTPS address and confirm the code with the correct account. Keep server data while troubleshooting."}
                </p>
              </div>
            </div>
          </div>
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-7 text-xs text-muted-foreground">
          <span>Ork</span>
          <span>
            {polish
              ? "Serwer działa na Twojej infrastrukturze."
              : "Your server runs on your infrastructure."}
          </span>
        </footer>
      </div>
    </main>
  );
}
