// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import "./styles.css";

/** Older desktop releases cannot render a server that no longer distributes product code. */
export function BrowserNativeUpdate() {
  const polish = navigator.language.toLowerCase().startsWith("pl");
  return (
    <main
      className="flex min-h-full items-center justify-center bg-background p-8 text-foreground"
      data-orkbot-app-state="ready"
      data-orkbot-surface="update"
    >
      <a className="underline underline-offset-4" href="https://ork.run/download/">
        {polish ? "Zaktualizuj Orka" : "Update Ork"}
      </a>
    </main>
  );
}
