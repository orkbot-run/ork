// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Modified by Ork contributors for prospective licensing. Existing material remains Apache-2.0.
export type VsPoints = {
  orkbot: readonly string[];
  other: readonly string[];
};

/**
 * Short card lines. Each one is a compression of the comparison already on that
 * page, not a new claim.
 */
export const VS_CARDS: Record<string, VsPoints> = {
  "muse-alternative": {
    orkbot: ["You host it", "You bring the model", "Apache baseline + PolyForm NC"],
    other: ["Meta hosts it", "Muse Spark", "Muse app and WhatsApp"],
  },
  "dots-alternative": {
    orkbot: ["You host it", "Any supported model", "Apache baseline + PolyForm NC"],
    other: ["OpenAI hosts it", "Eligible ChatGPT plans", "Not open source"],
  },
  "openclaw-alternative": {
    orkbot: ["Chat in the Ork app", "Docker installer, then chat", "Apache baseline + PolyForm NC"],
    other: ["Gateway for chat apps", "CLI, onboarding, config file", "MIT"],
  },
  "hermes-alternative": {
    orkbot: ["Chat in the Ork app", "Docker installer, then chat", "Apache baseline + PolyForm NC"],
    other: ["Desktop app and a CLI", "Config under ~/.hermes", "MIT"],
  },
  "instinct-alternative": {
    orkbot: ["You host it", "You bring the model", "Apache baseline + PolyForm NC"],
    other: ["Hosted assistant", "Text or call", "Not self-hosted"],
  },
  "claude-duet-alternative": {
    orkbot: ["You host it", "Claude or any supported model", "Apache baseline + PolyForm NC"],
    other: ["Anthropic hosts it", "Claude Pro and Max, US only", "Not self-hosted"],
  },
  "hark-alternative": {
    orkbot: ["You host it", "You bring the model", "Apache baseline + PolyForm NC"],
    other: ["Hark hosts it", "Free, with paid usage tiers", "Not self-hosted"],
  },
};

export function vsCard(slug: string): VsPoints | undefined {
  return VS_CARDS[slug];
}
