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
  const config = () => ({
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
  });
  await build({
    ...config(),
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

  const split = path.join(output, "managed");
  await build({
    ...config(),
    build: {
      outDir: split,
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: false,
      lib: {
        entry: path.join(web, "src/managed-renderer.ts"),
        formats: ["es"],
        fileName: () => "renderer.js",
        cssFileName: "renderer",
      },
      rolldownOptions: { output: { chunkFileNames: "chunks/[name]-[hash].js" } },
    },
  });
  // The native hosts dispatch these literal paths to embedded bytes. The
  // request path is never used to read any file from disk.
  const assets = (await readdir(split, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(split, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
  if (
    !assets.includes("renderer.js") ||
    !assets.includes("renderer.css") ||
    !assets.some((file) => file.startsWith("chunks/"))
  )
    throw new Error("Missing chunks in the managed renderer build.");
  const entries = assets.map((file) => {
    if (!/^(?:chunks\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css)$/.test(file))
      throw new Error(`Unexpected managed renderer file: ${file}`);
    const mime = file.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/css; charset=utf-8";
    return `    "/__ork_renderer/${file}" => Some(("${mime}", include_bytes!("managed/${file}"))),`;
  });
  await writeFile(
    path.join(output, "managed-assets.rs"),
    `fn managed_asset(path: &str) -> Option<(&'static str, &'static [u8])> {
  match path {
${entries.join("\n")}
    _ => None,
  }
}
`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("Provide the packaged renderer output directory.");
  await mkdir(output, { recursive: true });
  await buildPackagedRenderer(path.resolve(output));
}
