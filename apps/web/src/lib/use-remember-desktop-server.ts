// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { t } from "@lingui/core/macro";
import { toast } from "@orkbot/ui-web";
import { useEffect } from "react";
import { desktopBridge } from "./desktop";

/** A server bookmark is independent of optional device pairing and can be retried after failure. */
export function useRememberDesktopServer(session: string | null) {
  useEffect(() => {
    const remember = desktopBridge()?.server?.remember;
    if (!session || !remember) return;
    let active = true;
    let saving = false;
    let failed = false;
    let notice: string | number | undefined;
    async function save() {
      if (!active || saving) return;
      saving = true;
      try {
        await remember!();
        failed = false;
        if (notice !== undefined) toast.dismiss(notice);
      } catch {
        failed = true;
        if (active)
          notice = toast.error(t`Could not save your server.`, {
            ...(notice !== undefined ? { id: notice } : {}),
            action: { label: t`Retry`, onClick: () => void save() },
          });
      } finally {
        saving = false;
      }
    }
    const online = () => {
      if (failed) void save();
    };
    window.addEventListener("online", online);
    void save();
    return () => {
      active = false;
      window.removeEventListener("online", online);
      if (notice !== undefined) toast.dismiss(notice);
    };
  }, [session]);
}
