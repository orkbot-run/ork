// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors
import { GITHUB_URL, SITE_URL } from "./site";

export const LICENSE_DESCRIPTION =
  "Ork licensing: PolyForm Noncommercial for new work, monthly commercial terms per user, and Apache-2.0 for inherited material.";

export const LICENSE_INTRO =
  "New Ork work uses PolyForm Noncommercial 1.0.0 or a separate paid commercial license. Existing Apache-2.0 material keeps its license. Ork is source-available.";

export const LICENSE_FAQS = [
  {
    question: "When is self-hosting free?",
    answer:
      "PolyForm Noncommercial permits noncommercial purposes, including personal study, hobby projects, and experiments without an anticipated commercial application. It also permits use by the noncommercial organizations named in the license, such as educational institutions and government institutions. Model services and hardware can still cost money.",
  },
  {
    question: "Can a business use Ork internally for free?",
    answer:
      "Internal use does not automatically qualify as noncommercial. A for-profit business using new Ork work for customer support, sales, paid services, or its own business automation needs a paid commercial license unless the actual use is already permitted by PolyForm Noncommercial. Being a company alone does not decide the purpose.",
  },
  {
    question: "Can I use one seat on several servers?",
    answer:
      "The commercial agreement covers the same person across the deployments included in the order. Seats cannot be shared. To reassign one, remove the previous person's access from every covered deployment first.",
  },
  {
    question: "What happens when I cancel?",
    answer:
      "The commercial agreement keeps a cancelled seat active until the paid month ends. Commercial rights under that subscription then end, while rights held independently under Apache, PolyForm, or third-party licenses remain in place.",
  },
  {
    question: "What about a hosted service or a product built on Ork?",
    answer:
      "Hosting is a separate service. The commercial agreement permits customer hosting when the order covers it and every person using Ork commercially has a seat. Embedding, software resale, and competing products need a separate agreement under the commercial grant. Independent rights under Apache, PolyForm, and third-party licenses remain unchanged.",
  },
  {
    question: "What does Apache-2.0 cover?",
    answer:
      "Apache-licensed material in the baseline remains available under Apache-2.0, including for commercial use. LICENSE.md identifies that baseline. PolyForm and commercial terms cover only the Ork work outside it, and third-party material keeps its own terms.",
  },
  {
    question: "Is Ork open source?",
    answer:
      "The Apache-2.0 baseline is open source. New Ork work under PolyForm Noncommercial has use restrictions and is source-available. The combined project should not be described as OSI open source without that distinction.",
  },
  {
    question: "Which document decides whether my use is permitted?",
    answer:
      "Read LICENSE.md for scope, LICENSE for Apache-2.0, LICENSE-POLYFORM for PolyForm Noncommercial, and NOTICE for attribution. File notices identify exceptions. These examples explain the intended policy. The license texts and any signed commercial agreement govern your rights.",
  },
] as const;

export const COMMERCIAL_DESCRIPTION =
  "The commercial agreement sets monthly billing per named user. One seat covers that person's web, desktop, and mobile use on deployments included in the same order. Bots do not require seats. Hosting and model services are separate.";

export const COMMERCIAL_STATUS =
  "The commercial agreement is a draft for legal review. Pricing is not set, and subscriptions are not available for purchase yet.";

export const LICENSE_MARKDOWN = `# Ork licensing

${LICENSE_INTRO}

## Commercial licensing

${COMMERCIAL_DESCRIPTION}

${COMMERCIAL_STATUS}

[Review the commercial agreement draft](${GITHUB_URL}/blob/main/docs/commercial-license.md).

[Request a private sales contact channel](${GITHUB_URL}/issues/new). Keep the request generic. Do not post personal, customer, deployment, or billing details in a public issue.

## License documents

- [License scope](${GITHUB_URL}/blob/main/LICENSE.md)
- [Apache-2.0](${GITHUB_URL}/blob/main/LICENSE)
- [PolyForm Noncommercial 1.0.0](${GITHUB_URL}/blob/main/LICENSE-POLYFORM)
- [Attribution](${GITHUB_URL}/blob/main/NOTICE)

## FAQ

${LICENSE_FAQS.map((item) => `### ${item.question}\n\n${item.answer}`).join("\n\n")}

[Pricing](${SITE_URL}/pricing/)
`;
