// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const sdk = createRequire(import.meta.url).resolve("@daytona/sdk");

// Instrumentation patches Node's HTTP module, so use a fresh process rather than
// changing the shared Vitest worker's providers or instrumented modules.
const exercise = `
const { createRequire } = require('node:module');
const sdkRequire = createRequire(process.argv[1]);
const { NodeSDK } = sdkRequire('@opentelemetry/sdk-node');
const { HttpInstrumentation } = sdkRequire('@opentelemetry/instrumentation-http');
const { InMemorySpanExporter, SimpleSpanProcessor } = sdkRequire('@opentelemetry/sdk-trace-base');
const exporter = new InMemorySpanExporter();
const instrumentation = new HttpInstrumentation({
  ...(process.argv[2] === 'custom' ? { redactedQueryParamsServer: ['private'] } : {}),
});
const sdk = new NodeSDK({
  autoDetectResources: false,
  instrumentations: [instrumentation],
  spanProcessors: [new SimpleSpanProcessor(exporter)],
  metricReaders: [],
});
sdk.start();
const http = require('node:http');
const { once } = require('node:events');
const query = process.argv[2] === 'custom'
  ? 'private=fake-private-first&private=fake-private-second&safe=visible'
  : 'sig=fake-first&sig=fake-second&Signature=&AWSAccessKeyId=fake-aws&X-Goog-Signature=fake-gcs&X-Amz-Signature=fake-amz&X-Amz-Credential=fake-credential&X-Amz-Security-Token=fake-token&safe=visible';
const server = http.createServer((request, response) => response.end('complete'));
(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let result;
  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/signed?' + query }, resolve);
      request.on('error', reject);
    });
    let body = '';
    for await (const chunk of response) body += chunk;
    // InMemorySpanExporter clears its storage during shutdown.
    const spans = exporter.getFinishedSpans().map(span => ({ kind: span.kind, attributes: span.attributes }));
    result = { body, status: response.statusCode, spans };
  } finally {
    instrumentation.disable();
    await sdk.shutdown();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

async function spans(mode: "default" | "custom") {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("OTEL_") && !key.startsWith("DAYTONA_") && key !== "NODE_OPTIONS",
    ),
  );
  const { stdout } = await execute(process.execPath, ["-e", exercise, sdk, mode], {
    env: { ...env, OTEL_SEMCONV_STABILITY_OPT_IN: "http" },
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  const result = JSON.parse(stdout);
  expect(result.status).toBe(200);
  expect(result.body).toBe("complete");
  expect(result.spans.filter((span: { kind: number }) => span.kind === 2)).toHaveLength(1);
  const incoming = result.spans.filter((span: { kind: number }) => span.kind === 1);
  expect(incoming).toHaveLength(1);
  expect(incoming[0].attributes["http.request.method"]).toBe("GET");
  expect(incoming[0].attributes["url.path"]).toBe("/signed");
  expect(JSON.stringify(incoming)).not.toContain("fake-");
  return new URLSearchParams(incoming[0].attributes["url.query"]);
}

it("redacts signed query credentials with the sandbox SDK's actual telemetry dependencies", async () => {
  const query = await spans("default");
  expect(query.get("safe")).toBe("visible");
  for (const key of [
    "sig",
    "Signature",
    "AWSAccessKeyId",
    "X-Goog-Signature",
    "X-Amz-Signature",
    "X-Amz-Credential",
    "X-Amz-Security-Token",
  ]) {
    expect([...new Set(query.getAll(key))], key).toEqual(["REDACTED"]);
  }
});

it("supports server-specific redaction without losing ordinary query attributes", async () => {
  const query = await spans("custom");
  expect(query.get("safe")).toBe("visible");
  expect([...new Set(query.getAll("private"))]).toEqual(["REDACTED"]);
});
