// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { i18n } from "@lingui/core";
import { AI_DATA_DISCLOSURES, AiDataUseSchema, ApprovalReasonSchema } from "@orkbot/contracts";
import { approvalReasonText } from "@orkbot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translateAiDataDisclosure, translateApprovalReason } from "./approval-messages";

afterEach(() => vi.restoreAllMocks());

describe("shared approval message translation boundary", () => {
  it.each(ApprovalReasonSchema.options)(
    "preserves the canonical %s reason in its runtime descriptor",
    (reason) => {
      const translate = vi.spyOn(i18n, "_").mockReturnValue("Translated reason");
      expect(translateApprovalReason(reason)).toBe("Translated reason");
      expect(translate).toHaveBeenCalledWith({
        id: approvalReasonText(reason),
        message: approvalReasonText(reason),
      });
    },
  );

  it.each(AiDataUseSchema.options)(
    "preserves the canonical %s disclosure in its runtime descriptor",
    (use) => {
      const translate = vi.spyOn(i18n, "_").mockReturnValue("Translated disclosure");
      expect(translateAiDataDisclosure(use)).toBe("Translated disclosure");
      expect(translate).toHaveBeenCalledWith({
        id: AI_DATA_DISCLOSURES[use],
        message: AI_DATA_DISCLOSURES[use],
      });
    },
  );
});
