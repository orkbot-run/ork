// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0

import type { TransactionalEmailProvider } from "@orkbot/adapter-kit";
import { ResendEmailProvider, SmtpEmailProvider } from "@orkbot/adapters";
import type { AppEnv } from "#modules/platform/env";

export function configuredEmailProvider(
  env: Pick<AppEnv, "emailProvider" | "emailApiKey" | "emailFrom" | "emailReplyTo" | "smtpUrl">,
): TransactionalEmailProvider | undefined {
  // Preserve existing SMTP deployments when no provider is selected explicitly.
  const provider = env.emailProvider ?? (env.smtpUrl ? "smtp" : "none");
  switch (provider) {
    case "none":
      return undefined;
    case "smtp":
      return new SmtpEmailProvider({
        url: env.smtpUrl ?? "",
        from: env.emailFrom ?? "",
        replyTo: env.emailReplyTo,
      });
    case "resend":
      return new ResendEmailProvider({
        apiKey: env.emailApiKey ?? "",
        from: env.emailFrom ?? "",
        replyTo: env.emailReplyTo,
      });
    default:
      throw new Error("EMAIL_PROVIDER must be none, smtp, or resend");
  }
}
