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
  try {
    link = createServerConnectLink(window.location.origin);
  } catch {
    // Public plain HTTP cannot safely hand off authentication to a native client.
  }
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 bg-background p-8 text-center text-foreground">
      <h1 className="text-3xl font-semibold">Ork</h1>
      <p className="text-muted-foreground">{window.location.host}</p>
      {initialization === "required" && (
        <form className="flex w-full max-w-xs flex-col gap-3" onSubmit={pair}>
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
      {initialization === "required" && (
        <a
          className="text-sm text-muted-foreground underline underline-offset-4"
          href="https://ork.run"
        >
          {polish ? "Pobierz Orka" : "Get Ork"}
        </a>
      )}
    </main>
  );
}
