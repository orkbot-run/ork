// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createContext, useContext } from "react";

export const WorkspacePickerContext = createContext<{
  organization: string;
  open(): void;
} | null>(null);

/** Managed workspaces use the root account gate for both startup and explicit selection. */
export const useWorkspacePicker = () => useContext(WorkspacePickerContext);
