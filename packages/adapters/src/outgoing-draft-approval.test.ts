// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

const args = { to: "client@example.test", subject: "Hello", body: "A long full draft".repeat(500) };
describe("outgoing draft approval cards", () => {
  it("shows complete editable text, preserves the reviewer warning, and offers Send/Deny only", () => {
    const card = buildApprovalAskBlock("effect", "GMAIL_SEND_EMAIL", args, [], {
      reviewReason: "Auto-review: verify this recipient",
    });
    expect(card).toMatchObject({
      kind: "ask",
      outgoingDraft: { kind: "email", recipient: args.to, subject: args.subject, body: args.body },
      allowRule: false,
      actions: [
        { id: "allow", label: "Send" },
        { id: "deny", label: "Deny" },
      ],
    });
    if (card.kind === "ask") {
      expect(card.detail).toBe("Auto-review: verify this recipient");
      expect(card.text).not.toContain(args.to);
    }
  });
  it("does not turn a redacted field into an editable draft", () => {
    const secret = "sensitive-secret-123";
    const card = buildApprovalAskBlock(
      "effect",
      "GMAIL_SEND_EMAIL",
      { ...args, body: `Use ${secret}` },
      [secret],
    );
    expect(card).not.toHaveProperty("outgoingDraft");
    expect(JSON.stringify(card)).not.toContain(secret);
  });
  it("uses the same persisted bound route as the edit transaction", () => {
    const route = { connectorId: "pipedream", resourceId: "gmail", toolName: "send_email" };
    const ordinary = buildApprovalAskBlock("effect", "send_email__account", args, []);
    expect(ordinary).not.toHaveProperty("outgoingDraft");
    const card = buildApprovalAskBlock("effect", "send_email__account", args, [], {
      outgoingDraftRequest: ["__orkbotCatalogTool", "direct", { route, args }],
    });
    expect(card).toMatchObject({
      outgoingDraft: { kind: "email", recipient: args.to, body: args.body },
    });
  });
});
