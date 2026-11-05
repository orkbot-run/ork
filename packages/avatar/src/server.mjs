// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  avatarFromString,
  CLASSIC_PARAMETERS,
  createAvatar,
  MAX_ENCODED_AVATAR_STRING_LENGTH,
  PARAMETER_RULES,
  requireObject,
  ValidationError,
  VERSION,
} from "./generator.mjs";

const MAX_BODY_BYTES = 16_384;
const MAX_URL_BYTES = 8192;
const staticFiles = new Map(
  await Promise.all(
    [
      ["/", "preview.html", "text/html"],
      ["/preview.html", "preview.html", "text/html"],
      ["/public/app.js", "public/app.js", "text/javascript"],
      ["/public/style.css", "public/style.css", "text/css"],
      ["/dist/ork-avatar.js", "dist/ork-avatar.js", "text/javascript"],
    ].map(async ([path, file, type]) => [
      path,
      {
        type,
        body: await readFile(new URL(`../${file}`, import.meta.url)),
      },
    ]),
  ),
);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function queryInput(searchParams) {
  if (
    [...searchParams.keys()].some((key) => key !== "avatarString") ||
    searchParams.getAll("avatarString").length !== 1
  ) {
    throw new ValidationError("avatarString", "Provide exactly one avatarString query parameter");
  }
  return { avatarString: searchParams.get("avatarString") };
}

async function bodyInput(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Use application/json");
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    throw new HttpError(415, "unsupported_media_type", "Compressed bodies are not supported");
  }
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "Request body exceeds 16 KiB");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, "body_too_large", "Request body exceeds 16 KiB");
    chunks.push(chunk);
  }
  let input;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    input = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid UTF-8 JSON");
  }
  requireObject(input, "body");
  for (const key of Object.keys(input)) {
    if (!["avatarString", "parameters"].includes(key))
      throw new ValidationError(key, "Unknown request field");
  }
  if (Object.hasOwn(input, "avatarString") === Object.hasOwn(input, "parameters")) {
    throw new ValidationError("body", "Provide either avatarString or parameters");
  }
  return input;
}

export function createAvatarServer() {
  const server = createServer(
    {
      requestTimeout: 10_000,
      headersTimeout: 5000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    async (request, response) => {
      const send = (status, body, type = "application/json") => {
        const content = Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
        response.writeHead(status, {
          "Content-Type": `${type}; charset=utf-8`,
          "Content-Length": content.length,
        });
        response.end(request.method === "HEAD" ? undefined : content);
      };
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
      try {
        const port = server.address()?.port;
        const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!allowedHosts.includes(request.headers.host))
          throw new HttpError(403, "invalid_host", "Use the local server address");
        const origin = request.headers.origin;
        if (origin && !allowedHosts.map((host) => `http://${host}`).includes(origin)) {
          throw new HttpError(403, "invalid_origin", "Cross-origin requests are not allowed");
        }
        if (Buffer.byteLength(request.url) > MAX_URL_BYTES)
          throw new HttpError(414, "uri_too_long", "URL exceeds 8 KiB");
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        const isAvatar = ["/api/v1/avatars", "/api/v1/avatars.svg"].includes(url.pathname);
        const known =
          isAvatar ||
          staticFiles.has(url.pathname) ||
          ["/health", "/api/v1/options", "/favicon.ico"].includes(url.pathname);
        if (!known) throw new HttpError(404, "not_found", "Route not found");
        const allowed = isAvatar ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"];
        if (!allowed.includes(request.method)) {
          response.setHeader("Allow", allowed.join(", "));
          throw new HttpError(405, "method_not_allowed", "Method not allowed");
        }
        if (isAvatar) {
          if (request.method === "POST" && url.search)
            throw new ValidationError("query", "POST parameters belong in the JSON body");
          const input =
            request.method === "POST" ? await bodyInput(request) : queryInput(url.searchParams);
          const avatar = Object.hasOwn(input, "avatarString")
            ? avatarFromString(input.avatarString)
            : createAvatar(input.parameters);
          response.setHeader("ETag", `"${avatar.id}"`);
          if (url.pathname.endsWith(".svg")) {
            response.setHeader(
              "Content-Security-Policy",
              "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            );
            send(200, avatar.svg, "image/svg+xml");
          } else send(200, avatar);
        } else if (url.pathname === "/api/v1/options") {
          send(200, {
            version: VERSION,
            avatarString: {
              format: "decimal",
              maxEncodedLength: MAX_ENCODED_AVATAR_STRING_LENGTH,
            },
            parameters: PARAMETER_RULES,
            classic: CLASSIC_PARAMETERS,
          });
        } else if (url.pathname === "/health") send(200, { status: "ok", version: VERSION });
        else if (url.pathname === "/favicon.ico") {
          response.writeHead(204);
          response.end();
        } else {
          const file = staticFiles.get(url.pathname);
          send(200, file.body, file.type);
        }
      } catch (error) {
        if (!request.complete) {
          response.setHeader("Connection", "close");
          request.resume();
        }
        if (response.headersSent || response.destroyed) return;
        if (error instanceof ValidationError)
          send(400, {
            error: {
              code: "validation_error",
              field: error.field,
              message: error.message,
            },
          });
        else if (error instanceof HttpError)
          send(error.status, {
            error: { code: error.code, message: error.message },
          });
        else
          send(500, {
            error: {
              code: "internal_error",
              message: "Could not generate avatar",
            },
          });
      }
    },
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
  const server = createAvatarServer();
  server.on("error", (error) => {
    console.error(`Avatar service: ${error.code ?? "startup error"}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`ORK Avatar Service: http://127.0.0.1:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      server.close();
      setTimeout(() => server.closeAllConnections(), 1000).unref();
    });
}
