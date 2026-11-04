import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS, ORKBOT_DOCS_URLS } from "./builtin-skills.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);
const publishedSlugs = [
  ...readFileSync(repoFile("apps/www/src/docs.ts"), "utf8").matchAll(/slug: "([\w-]+)"/g),
].map((match) => match[1]);

describe("Ork skill", () => {
  it("links only to published docs pages", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Ork")!;
    const urls = [...skill.content.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
    expect(urls).toEqual(ORKBOT_DOCS_URLS);
    for (const url of urls) {
      const slug =
        url === "https://orkbot.run/docs.md"
          ? publishedSlugs[0]
          : /^https:\/\/orkbot\.run\/docs\/([\w-]+)\.md$/.exec(url)?.[1];
      expect(publishedSlugs, url).toContain(slug);
      expect(existsSync(repoFile(`docs/${slug}.md`)), url).toBe(true);
    }
  });
});
