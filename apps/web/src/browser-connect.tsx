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
  const [paired, setPaired] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const pair = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeServerPairingCode(code);
    if (!normalized || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(false);
    try {
      const response = await fetch("/api/auth/native/pair", {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: normalized }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok || (await response.json())?.paired !== true)
        throw new Error("Pairing failed");
      if (!controller.signal.aborted) setPaired(true);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setPending(false);
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
      {paired ? (
        <p role="status">{polish ? "Połączono" : "Paired"}</p>
      ) : (
        <form className="flex w-full max-w-xs flex-col gap-3" onSubmit={pair}>
          <label htmlFor="pairing-code">{polish ? "Kod parowania" : "Pairing code"}</label>
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
            {polish ? "Połącz" : "Pair"}
          </Button>
          {error && (
            <p role="alert">
              {polish
                ? "Nie udało się połączyć. Sprawdź kod i spróbuj ponownie."
                : "Could not pair. Check the code and try again."}
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
      <a
        className="text-sm text-muted-foreground underline underline-offset-4"
        href="https://ork.run"
      >
        {polish ? "Pobierz Orka" : "Get Ork"}
      </a>
    </main>
  );
}
