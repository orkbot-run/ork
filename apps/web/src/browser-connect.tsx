// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServerConnectLink } from "@orkbot/contracts";
import { Button } from "@orkbot/ui-web";
import "./styles.css";

/** This page identifies its own server. Query strings can never choose a different target. */
export function BrowserConnect() {
  const polish = navigator.language.toLowerCase().startsWith("pl");
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
