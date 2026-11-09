// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { normalizeServerPairingCode } from "@orkbot/contracts";
import { Button, Input } from "@orkbot/ui-web";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";

/** Kept separately while the app pairing form is hidden from the server page. */
export function BrowserPairing({ polish, onPaired }: { polish: boolean; onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
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
      if (!controller.signal.aborted) onPaired();
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

  return (
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
  );
}
