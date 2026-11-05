// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test, { after, before } from "node:test";
import { createAvatar, PARAMETER_RULES } from "../src/generator.mjs";
import { createAvatarServer } from "../src/server.mjs";

let server, base;
before(async () => {
  server = createAvatarServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});
const post = (body, path = "/api/v1/avatars", headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("JSON and SVG GET/POST endpoints agree with the service function", async () => {
  const parameters = {
    color: "#123456",
    satellites: 0,
    animate: false,
    cheeks: true,
    name: "🟢",
  };
  const expected = createAvatar(parameters);
  const jsonResponse = await post({ parameters });
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("etag"), `"${expected.id}"`);
  assert.deepEqual(await jsonResponse.json(), expected);
  const query = new URLSearchParams({ avatarString: expected.avatarString });
  const getResponse = await fetch(`${base}/api/v1/avatars?${query}`);
  assert.deepEqual(await getResponse.json(), expected);
  for (const response of [
    await fetch(`${base}/api/v1/avatars.svg?${query}`),
    await post({ avatarString: expected.avatarString }, "/api/v1/avatars.svg"),
  ]) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
    assert.equal(await response.text(), expected.svg);
  }
  const head = await fetch(`${base}/api/v1/avatars.svg?${query}`, {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(expected.svg));
});

test("options and local preview are self-contained", async () => {
  assert.equal(server.address().address, "127.0.0.1");
  const options = await (await fetch(`${base}/api/v1/options`)).json();
  assert.deepEqual(options.parameters, PARAMETER_RULES);
  for (const [path, type] of [
    ["/", "text/html"],
    ["/preview.html", "text/html"],
    ["/public/app.js", "text/javascript"],
    ["/public/style.css", "text/css"],
    ["/dist/ork-avatar.js", "text/javascript"],
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), new RegExp(type));
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await response.text()).length > 0);
  }
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
    status: "ok",
    version: "2",
  });
});

test("malformed data fails with structured client errors", async () => {
  for (const body of [
    {},
    null,
    [],
    { parameters: null },
    { parameters: {}, unknown: 1 },
    { parameters: { animate: "false" } },
    { parameters: { style: "holo" } },
    { avatarString: "bad" },
    { avatarString: createAvatar().avatarString, parameters: {} },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, "validation_error");
  }
  for (const query of [
    "avatarString=x&avatarString=y",
    "avatarString=bad",
    "seed=x",
    "foo=bar",
    "",
  ]) {
    assert.equal((await fetch(`${base}/api/v1/avatars?${query}`)).status, 400, query);
  }
  assert.equal((await post({ parameters: {} }, "/api/v1/avatars?shape=ork")).status, 400);
  const malformed = await fetch(`${base}/api/v1/avatars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_json");
  assert.equal(
    (
      await post({ parameters: {} }, undefined, {
        "Content-Type": "text/plain",
      })
    ).status,
    415,
  );
});

test("oversized fixed and streamed bodies are rejected without dropping the response", async () => {
  assert.equal((await post({ avatarString: "x".repeat(20_000) })).status, 413);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}/api/v1/avatars`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.write('{"avatarString":"');
    request.write("x".repeat(20_000));
    request.end('"}');
  });
  assert.equal(status, 413);
  assert.equal(
    (await fetch(`${base}/api/v1/avatars?avatarString=${"x".repeat(9000)}`)).status,
    414,
  );
});

test("routing, host and origin checks block unintended access", async () => {
  assert.equal((await fetch(`${base}/src/server.mjs`)).status, 404);
  const invalidMethod = await fetch(`${base}/api/v1/avatars`, {
    method: "DELETE",
  });
  assert.equal(invalidMethod.status, 405);
  assert.equal(invalidMethod.headers.get("allow"), "GET, HEAD, POST");
  assert.equal(
    (
      await post({ parameters: {} }, undefined, {
        Origin: "https://example.com",
      })
    ).status,
    403,
  );
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}/health`,
      { headers: { Host: "example.com" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 403);
});

test("concurrent requests do not share mutable generation state", async () => {
  await Promise.all(
    Array.from({ length: 16 }, async (_, i) => {
      const response = await post({
        parameters: { name: `Ork ${i}`, satellites: i % 5 },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(
        await response.json(),
        createAvatar({ name: `Ork ${i}`, satellites: i % 5 }),
      );
    }),
  );
});

test("HTTP accepts variable-length numeric seeds and exact parameter numbers", async () => {
  for (const avatarString of ["1", "12312312312", "1234567890".repeat(100), 1]) {
    const response = await post({ avatarString });
    assert.equal(response.status, 200);
    const avatar = await response.json();
    assert.equal(avatar.avatarString, String(avatarString));
    const query = new URLSearchParams({ avatarString: String(avatarString) });
    assert.deepEqual(await (await fetch(`${base}/api/v1/avatars?${query}`)).json(), avatar);
  }
  const options = await (await fetch(`${base}/api/v1/options`)).json();
  assert.equal(options.avatarString.format, "decimal");
  assert.equal(options.avatarString.maxEncodedLength, 261);
});
