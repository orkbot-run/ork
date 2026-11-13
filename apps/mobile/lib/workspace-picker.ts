// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef } from "react";

export const WorkspacePickerContext = createContext<{
  organization: string;
  open(): void;
  openInScreen(): void;
  screen: ReactNode;
  dismissScreen(): void;
} | null>(null);

/** Managed workspaces use the root account gate for both startup and explicit selection. */
export const useWorkspacePicker = () => useContext(WorkspacePickerContext);

/** Present inside an existing native screen instead of behind its modal controller. */
export function useWorkspacePickerScreen() {
  const picker = useWorkspacePicker();
  const dismiss = useRef(picker?.dismissScreen);
  dismiss.current = picker?.dismissScreen;
  useEffect(() => () => dismiss.current?.(), []);
  return picker;
}
