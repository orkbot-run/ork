// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIdAt } from "../../../packages/contracts/src/client-build.ts";
import { packagedRendererScript } from "../src/renderer-script.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const web = path.join(root, "apps/web");
const requireWeb = createRequire(path.join(web, "package.json"));
const dependency = (name) => import(pathToFileURL(requireWeb.resolve(name)).href);

/** Reuse the renderer's compiler dependencies while keeping server middleware out of the app. */
export async function buildPackagedRenderer(output) {
  const [
    { build },
    { default: react },
    { default: babel },
    { lingui },
    { getConfig },
    { default: tailwindcss },
  ] = await Promise.all([
    dependency("vite"),
    dependency("@vitejs/plugin-react"),
    dependency("@rolldown/plugin-babel"),
    dependency("@lingui/vite-plugin"),
    dependency("@lingui/conf"),
    dependency("@tailwindcss/vite"),
  ]);
  await build({
    configFile: false,
    root: web,
    publicDir: false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.ORKBOT_BUILD": JSON.stringify(buildIdAt(new Date())),
      "import.meta": "{}",
    },
    plugins: [
      react(),
      babel({
        plugins: [
          [
            requireWeb.resolve("@lingui/babel-plugin-lingui-macro"),
            {
              linguiConfig: getConfig({ cwd: web }),
              descriptorFields: "id-only",
            },
          ],
        ],
      }),
      lingui({ cwd: web }),
      tailwindcss(),
    ],
    build: {
      outDir: output,
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: false,
      lib: {
        entry: path.join(web, "src/native-app.tsx"),
        name: "OrkRenderer",
        formats: ["iife"],
        fileName: () => "renderer.js",
        cssFileName: "renderer",
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const files = (await readdir(output)).sort();
  if (files.join(",") !== "renderer.css,renderer.js") {
    throw new Error("The packaged renderer must contain only one script and one stylesheet.");
  }
  const javascript = await readFile(path.join(output, "renderer.js"), "utf8");
  const css = await readFile(path.join(output, "renderer.css"), "utf8");
  await writeFile(path.join(output, "renderer-init.js"), packagedRendererScript(javascript, css));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("Provide the packaged renderer output directory.");
  await mkdir(output, { recursive: true });
  await buildPackagedRenderer(path.resolve(output));
}
