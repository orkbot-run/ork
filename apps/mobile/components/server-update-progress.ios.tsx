// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Host, ProgressView } from "@expo/ui/swift-ui";
import { accessibilityLabel, frame, progressViewStyle } from "@expo/ui/swift-ui/modifiers";

export function ServerUpdateProgress({ label }: { label: string }) {
  return (
    <Host style={{ height: 16 }}>
      <ProgressView
        modifiers={[
          progressViewStyle("linear"),
          frame({ maxWidth: Infinity }),
          accessibilityLabel(label),
        ]}
      />
    </Host>
  );
}
