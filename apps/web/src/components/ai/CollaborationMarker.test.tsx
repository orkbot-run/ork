// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to use generated Ork avatars and retire legacy icon rendering.
// Inherited Apache-2.0 material is preserved. New changes follow LICENSE.md.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveBotGlyph, CollaborationMarker } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a centred peer event with its avatar and full label", () => {
    const html = renderToString(
      <CollaborationMarker
        peerName="Research"
        color="#14B8A6"
        identity="research"
        label="Message from Research"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain('class="flex min-w-0 max-w-full justify-center py-1"');
    expect(html).toContain('class="inline-flex max-w-full');
    expect(html).toContain("truncate font-medium");
    expect(html).toContain("orkbot-logo-avatar");
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
    expect(html).not.toContain("peer-replies-toggle");
  });

  it("animates the active bot glyph from its run status", () => {
    const html = renderToString(
      <ActiveBotGlyph
        bots={[{ botId: "research", color: "#14B8A6", status: "running" }]}
        label="Searching the web: injury news"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-working="true"');
    expect(html).toContain('data-activity="working"');
  });
});
