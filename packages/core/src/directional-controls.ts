// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

/** Remove bidi formatting from identity labels, preserving RTL letters and emoji joiners. */
export function stripDirectionalControls(value: string): string {
  return value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
