// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors
import { GITHUB_URL, SITE_URL } from "./site";

export const LICENSE_DESCRIPTION =
  "Ork licensing: the Apache-2.0 baseline, PolyForm Noncommercial for new Ork work, and paid commercial licensing.";

export const LICENSE_INTRO =
  "Ork is source-available. The Rakazo code and Ork material already published under Apache-2.0 keep that license. New Ork work is offered under PolyForm Noncommercial 1.0.0 or a separate paid commercial license.";

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
    question: "What about a hosted service or a product built on Ork?",
    answer:
      "For commercial hosting, resale, or a paid product that includes new Ork work, ask for a separate agreement covering your intended deployment and distribution before using that work commercially.",
  },
  {
    question: "Does this restrict Rakazo or earlier Apache releases?",
    answer:
      "No. Rakazo remains Apache-2.0, and licenses already granted for earlier Ork releases remain available under their original terms. The exact Apache baseline is recorded in LICENSE.md. The new restrictions cover new Ork work after that baseline. Existing third-party notices also remain in force.",
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
  "Commercial licenses are quoted individually. The written agreement must identify the licensor and customer, the covered Ork work, permitted deployments, distribution rights, term, and price. Commercial rights start only under an executed agreement.";

export const LEGAL_REVIEW_STATUS =
  "This licensing update and the commercial agreement draft are pending legal review. This page does not grant commercial rights or confirm legal approval.";

export const LICENSE_MARKDOWN = `# Ork licensing

${LICENSE_INTRO}

${LEGAL_REVIEW_STATUS}

## Commercial licensing

${COMMERCIAL_DESCRIPTION}

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
