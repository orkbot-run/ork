// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServerConnectLink, normalizeServerPairingCode } from "@orkbot/contracts";
import { Button, Input } from "@orkbot/ui-web";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import "./styles.css";

/** This page identifies its own server. Query strings can never choose a different target. */
export function BrowserConnect() {
  const polish = navigator.language.toLowerCase().startsWith("pl");
  const [code, setCode] = useState("");
  const [dashboard, setDashboard] = useState("");
  const [pending, setPending] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [initialization, setInitialization] = useState<
    "loading" | "required" | "complete" | "unavailable"
  >("loading");
  const [checkAttempt, setCheckAttempt] = useState(0);
  const initialized = useRef(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      if (controller.signal.aborted || initialized.current) return;
      if (request.current) {
        timer = setTimeout(() => void check(), 5_000);
        return;
      }
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
  const pair = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeServerPairingCode(code);
    if (initialization !== "required" || !normalized || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setAwaitingApproval(false);
    setError(false);
    try {
      const post = (path: string, body: object) =>
        fetch(`/api/auth/native/${path}`, {
          method: "POST",
          credentials: "omit",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]),
        });
      const response = await post("pair", { code: normalized });
      const result = response.status === 202 ? await response.json() : null;
      if (
        result?.pending !== true ||
        typeof result.pairingId !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(result.pairingId)
      )
        throw new Error("Pairing failed");
      setAwaitingApproval(true);
      const deadline = Date.now() + 300_000;
      while (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 2000);
          controller.signal.addEventListener("abort", finish, { once: true });
        });
        if (controller.signal.aborted) return;
        if (Date.now() >= deadline) throw new Error("Pairing expired");
        let status: Response;
        try {
          status = await post("pair/status", { pairingId: result.pairingId });
        } catch {
          if (controller.signal.aborted) return;
          continue;
        }
        if (status.status >= 500 || status.status === 429) continue;
        const state = await status.json();
        if (status.status === 200 && state?.paired === true) break;
        if (status.status !== 202 || state?.pending !== true) throw new Error("Pairing failed");
      }
      if (!controller.signal.aborted) {
        initialized.current = true;
        setInitialization("complete");
      }
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setPending(false);
        setAwaitingApproval(false);
      }
    }
  };
  let link: string | undefined;
  let dashboardLink: string | undefined;
  try {
    const candidate = new URL(dashboard.trim());
    if (
      candidate.protocol === "https:" &&
      !candidate.username &&
      !candidate.password &&
      candidate.pathname === "/" &&
      !candidate.search &&
      !candidate.hash
    )
      dashboardLink = candidate.origin;
  } catch {
    // The operator must provide the HTTPS dashboard origin.
  }
  try {
    link = createServerConnectLink(window.location.origin);
  } catch {
    // Public plain HTTP cannot safely hand off authentication to a native client.
  }
  return (
    <main className="flex min-h-full items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-3xl font-semibold">Ork</h1>
          <p className="break-all text-sm text-muted-foreground">{window.location.host}</p>
        </div>
        {initialization === "complete" && (
          <div className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">
              {polish ? "Serwer jest gotowy" : "Your server is ready"}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {polish
                ? "Otwórz aplikację Ork, aby połączyć się z tym serwerem i pracować ze swoimi botami."
                : "Open the Ork app to connect to this server and work with your bots."}
            </p>
          </div>
        )}
        {initialization === "required" && (
          <form className="flex w-full max-w-xs flex-col gap-3" onSubmit={pair}>
            <p className="text-sm leading-6 text-muted-foreground">
              {polish
                ? "Utwórz klucz parowania w aplikacji Ork, aby skonfigurować ten serwer."
                : "Create a pairing key in the Ork app to set up this server."}
            </p>
            <label htmlFor="pairing-code">{polish ? "Klucz parowania" : "Pairing key"}</label>
            <Input
              id="pairing-code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={16}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={pending}
            />
            <Button type="submit" disabled={pending || !normalizeServerPairingCode(code)}>
              {polish ? "Inicjalizuj" : "Initialize"}
            </Button>
            {awaitingApproval && (
              <p role="status">
                {polish ? "Potwierdź serwer w aplikacji Ork." : "Confirm the server in Ork."}
              </p>
            )}
            {error && (
              <p role="alert">
                {polish
                  ? "Nie udało się zainicjalizować. Sprawdź klucz i spróbuj ponownie."
                  : "Could not initialize. Check the key and try again."}
              </p>
            )}
          </form>
        )}
        {link ? (
          <Button nativeButton={false} role="link" render={<a href={link} />}>
            {polish ? "Otwórz w Orku" : "Open in Ork"}
          </Button>
        ) : (
          <p role="alert">
            {polish ? "Publiczny serwer wymaga HTTPS." : "Public servers require HTTPS."}
          </p>
        )}
        {(initialization === "required" || initialization === "complete") && (
          <details className="w-full rounded-xl border border-border p-4 text-start text-sm">
            <summary className="cursor-pointer font-medium">
              {polish ? "Połącz z workspace’em" : "Connect a workspace"}
            </summary>
            <div className="mt-3 flex flex-col gap-3 text-muted-foreground">
              <p>
                {polish
                  ? "Na serwerze uruchom poniższe polecenie w kontenerze API, aby uzyskać kod ważny przez pięć minut:"
                  : "Run this command in the server’s API container to get a code valid for five minutes:"}
              </p>
              <code className="break-all text-foreground">
                {initialization === "complete"
                  ? "node /app/apps/api/dist/cli/server-claim.js --workspace"
                  : "node /app/apps/api/dist/cli/server-claim.js"}
              </code>
              <p>
                {polish
                  ? "Zaloguj się do dashboardu, wybierz organizację i wpisz kod w sekcji Server. Przed zatwierdzeniem sprawdź adres serwera."
                  : "Sign in to your dashboard, choose an organization, and enter the code under Server. Check the server address before confirming."}
              </p>
              <label htmlFor="workspace-dashboard">
                {polish ? "Adres dashboardu" : "Dashboard address"}
              </label>
              <Input
                id="workspace-dashboard"
                type="url"
                value={dashboard}
                onChange={(event) => setDashboard(event.target.value)}
                placeholder="https://dashboard.example.com"
                autoComplete="url"
              />
              {dashboardLink && (
                <a
                  href={dashboardLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-4"
                >
                  {polish ? "Otwórz dashboard" : "Open dashboard"}
                </a>
              )}
              {initialization === "complete" && (
                <p>
                  {polish
                    ? "Zaloguj się na konto obecnego właściciela serwera, które ma również uprawnienia administratora workspace’u."
                    : "Sign in as the server’s current owner, who must also be a workspace administrator."}
                </p>
              )}
            </div>
          </details>
        )}
        {initialization === "unavailable" && (
          <Button
            onClick={() => {
              setInitialization("loading");
              setCheckAttempt((value) => value + 1);
            }}
          >
            {polish ? "Spróbuj ponownie" : "Retry"}
          </Button>
        )}
        {(initialization === "required" || initialization === "complete") && (
          <a
            className="text-sm text-muted-foreground underline underline-offset-4"
            href="https://ork.run/download/"
          >
            {polish ? "Nie masz aplikacji? Pobierz Orka" : "Need the app? Download Ork"}
          </a>
        )}
      </div>
    </main>
  );
}
