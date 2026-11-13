// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createPrivateKey, sign, X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const API = "https://api.appstoreconnect.apple.com";
const BUNDLE = "run.orkbot.desktop.preview";
const FAILURE = "Could not prepare the macOS personal keychain identity.";
type Command = (command: string, args: string[]) => string;
interface Resource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data?: { type: string; id: string } | { type: string; id: string }[] }
  >;
}
interface Page {
  data: Resource | Resource[];
  links?: { next?: string | null };
}

/** Fixed-origin, bounded App Store Connect requests. Error bodies and bearer tokens stay private. */
export class AppleProfiles {
  private env: NodeJS.ProcessEnv;
  private network: typeof fetch;
  constructor(env: NodeJS.ProcessEnv, network: typeof fetch = fetch) {
    this.env = env;
    this.network = network;
  }
  async request(endpoint: string, method = "GET", body?: unknown): Promise<Page> {
    const url = new URL(endpoint, API);
    if (url.origin !== API || url.username || url.password || !url.pathname.startsWith("/v1/"))
      throw new Error(FAILURE);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "ES256", kid: this.env.APPLE_API_KEY, typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.env.APPLE_API_ISSUER,
        aud: "appstoreconnect-v1",
        iat: now,
        exp: now + 120,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(input), {
      key: createPrivateKey(this.env.APPLE_API_PRIVATE_KEY!),
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    let response: Response;
    try {
      response = await this.network(url, {
        method,
        headers: {
          authorization: `Bearer ${input}.${signature}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(FAILURE);
    }
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 4 * 1024 * 1024) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${FAILURE} Apple API status ${response.status}.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(FAILURE);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error(FAILURE);
        chunks.push(chunk.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Page;
      const records = Array.isArray(value?.data) ? value.data : [value?.data];
      if (
        records.some(
          (record) =>
            !record ||
            typeof record !== "object" ||
            typeof record.id !== "string" ||
            typeof record.type !== "string",
        ) ||
        (value.links?.next != null && typeof value.links.next !== "string")
      )
        throw new Error(FAILURE);
      return value;
    } catch {
      throw new Error(FAILURE);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async list(endpoint: string): Promise<Resource[]> {
    const result: Resource[] = [];
    let next: string | null | undefined = endpoint;
    for (let page = 0; next && page < 10; page++) {
      const response = await this.request(next);
      if (!Array.isArray(response.data)) throw new Error(FAILURE);
      result.push(...response.data);
      next = response.links?.next;
    }
    if (next || result.length > 2000) throw new Error(FAILURE);
    return result;
  }
  async createOrFind(
    endpoint: string,
    body: unknown,
    find: () => Promise<Resource | undefined>,
  ): Promise<Resource> {
    try {
      const created = await this.request(endpoint, "POST", body);
      if (Array.isArray(created.data)) throw new Error(FAILURE);
      return created.data;
    } catch (error) {
      // Reconcile a concurrent or ambiguously completed creation with a read. Never replay POST.
      const existing = await find().catch(() => undefined);
      if (existing) return existing;
      throw error;
    }
  }
}

const identifier = (resource: Resource, type: string) => {
  if (resource.type !== type || !/^[A-Za-z0-9-]{1,100}$/.test(resource.id))
    throw new Error(FAILURE);
  return resource.id;
};
const fresh = (value: unknown) =>
  typeof value === "string" && Date.parse(value) > Date.now() + 86_400_000;

export function ownEntitlements(
  profile: {
    teams: unknown;
    prefixes: unknown;
    allDevices: unknown;
    expiresAt: string;
    entitlements: Record<string, unknown>;
    certificates: Buffer[];
  },
  certificate: Pick<X509Certificate, "raw">,
  identity: string,
  base: Record<string, unknown>,
) {
  const team = identity.match(/\(([A-Z0-9]{10})\)$/)?.[1];
  if (
    !team ||
    !Array.isArray(profile.teams) ||
    profile.teams.length !== 1 ||
    profile.teams[0] !== team ||
    !Array.isArray(profile.prefixes) ||
    profile.prefixes.length !== 1 ||
    !/^[A-Z0-9]{10}$/.test(profile.prefixes[0]) ||
    profile.allDevices !== true ||
    !fresh(profile.expiresAt) ||
    !profile.certificates.some((value) => value.equals(certificate.raw))
  )
    throw new Error(FAILURE);
  const prefix: string = profile.prefixes[0];
  const application = `${prefix}.${BUNDLE}`;
  const allows = (claim: unknown) =>
    typeof claim === "string" && (claim === application || claim === `${prefix}.*`);
  if (
    !allows(
      profile.entitlements["com.apple.application-identifier"] ??
        profile.entitlements["application-identifier"],
    ) ||
    profile.entitlements["get-task-allow"] === true ||
    profile.entitlements["com.apple.security.get-task-allow"] === true ||
    base["get-task-allow"] === true ||
    base["com.apple.security.get-task-allow"] === true ||
    (profile.entitlements["com.apple.developer.team-identifier"] !== undefined &&
      profile.entitlements["com.apple.developer.team-identifier"] !== team)
  )
    throw new Error(FAILURE);
  const groups = profile.entitlements["keychain-access-groups"];
  if (!Array.isArray(groups) || !groups.some(allows)) throw new Error(FAILURE);
  return {
    ...base,
    "com.apple.application-identifier": application,
    "com.apple.developer.team-identifier": team,
    "keychain-access-groups": [application],
  };
}

/** Reuse existing signing identities. No certificate, key, or unrelated profile is removed. */
export async function preparePersonalProfile(
  directory: string,
  env: NodeJS.ProcessEnv,
  run: Command,
  network: typeof fetch = fetch,
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const archive = path.join(directory, "signing-certificate.p12");
  let certificate: X509Certificate;
  try {
    writeFileSync(archive, Buffer.from(env.APPLE_CERTIFICATE!, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    const pem = run("/usr/bin/openssl", [
      "pkcs12",
      "-in",
      archive,
      "-passin",
      "env:APPLE_CERTIFICATE_PASSWORD",
      "-clcerts",
      "-nokeys",
    ]);
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (certificates?.length !== 1) throw new Error(FAILURE);
    certificate = new X509Certificate(certificates[0]!);
    if (
      certificate.toLegacyObject().subject.CN !== env.APPLE_SIGNING_IDENTITY ||
      !fresh(certificate.validTo)
    )
      throw new Error(FAILURE);
  } finally {
    rmSync(archive, { force: true });
  }
  const api = new AppleProfiles(env, network);
  const findBundle = async () => {
    const bundles = await api.list(`/v1/bundleIds?filter%5Bidentifier%5D=${BUNDLE}&limit=200`);
    const exact = bundles.find(
      (value) =>
        value.attributes?.identifier === BUNDLE &&
        ["MAC_OS", "UNIVERSAL"].includes(String(value.attributes?.platform)),
    );
    if (!exact && bundles.length) throw new Error(FAILURE);
    return exact;
  };
  const bundle =
    (await findBundle()) ??
    (await api.createOrFind(
      "/v1/bundleIds",
      {
        data: {
          type: "bundleIds",
          attributes: { identifier: BUNDLE, name: "Ork Desktop", platform: "MAC_OS" },
        },
      },
      findBundle,
    ));
  if (
    bundle.attributes?.identifier !== BUNDLE ||
    !["MAC_OS", "UNIVERSAL"].includes(String(bundle.attributes?.platform))
  )
    throw new Error(FAILURE);
  const bundleId = identifier(bundle, "bundleIds");
  const certificates = await api.list(
    "/v1/certificates?filter%5BcertificateType%5D=DEVELOPER_ID_APPLICATION,DEVELOPER_ID_APPLICATION_G2&limit=200",
  );
  const matching = certificates.filter(
    (value) =>
      ["DEVELOPER_ID_APPLICATION", "DEVELOPER_ID_APPLICATION_G2"].includes(
        String(value.attributes?.certificateType),
      ) &&
      fresh(value.attributes?.expirationDate) &&
      typeof value.attributes?.certificateContent === "string" &&
      Buffer.from(value.attributes.certificateContent, "base64").equals(certificate.raw),
  );
  if (matching.length !== 1) throw new Error(FAILURE);
  const certificateId = identifier(matching[0]!, "certificates");
  const findProfile = async () => {
    const profiles = await api.list(
      "/v1/profiles?filter%5BprofileType%5D=MAC_APP_DIRECT&filter%5BprofileState%5D=ACTIVE&include=bundleId,certificates&limit=200",
    );
    return profiles.find((value) => {
      const bundle = value.relationships?.bundleId?.data;
      const certificates = value.relationships?.certificates?.data;
      return (
        value.attributes?.profileType === "MAC_APP_DIRECT" &&
        value.attributes?.profileState === "ACTIVE" &&
        fresh(value.attributes?.expirationDate) &&
        !Array.isArray(bundle) &&
        bundle?.id === bundleId &&
        Array.isArray(certificates) &&
        certificates.some((value) => value.id === certificateId)
      );
    });
  };
  let profile = await findProfile();
  if (!profile) {
    const created = await api.createOrFind(
      "/v1/profiles",
      {
        data: {
          type: "profiles",
          attributes: {
            name: `Ork Desktop direct ${certificate.fingerprint256.replaceAll(":", "").slice(0, 12)}`,
            profileType: "MAC_APP_DIRECT",
          },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: bundleId } },
            certificates: { data: [{ type: "certificates", id: certificateId }] },
          },
        },
      },
      findProfile,
    );
    profile = created;
  }
  const profileId = identifier(profile, "profiles");
  const downloaded = await api.request(`/v1/profiles/${profileId}`);
  if (Array.isArray(downloaded.data) || identifier(downloaded.data, "profiles") !== profileId)
    throw new Error(FAILURE);
  profile = downloaded.data;
  if (
    profile.attributes?.profileType !== "MAC_APP_DIRECT" ||
    profile.attributes?.profileState !== "ACTIVE" ||
    !fresh(profile.attributes?.expirationDate) ||
    typeof profile.attributes?.profileContent !== "string" ||
    profile.attributes.profileContent.length > 2 * 1024 * 1024
  )
    throw new Error(FAILURE);
  const file = path.join(directory, "embedded.provisionprofile");
  const decoded = path.join(directory, "decoded.plist");
  const entitlements = path.join(directory, "Entitlements.plist");
  writeFileSync(file, Buffer.from(profile.attributes.profileContent, "base64"), { mode: 0o600 });
  run("/usr/bin/security", ["cms", "-D", "-i", file, "-o", decoded]);
  chmodSync(decoded, 0o600);
  const extract = (key: string, format = "json") =>
    run("/usr/bin/plutil", ["-extract", key, format, "-o", "-", decoded]);
  const certificateXml = extract("DeveloperCertificates", "xml1");
  const decodedCertificates = [...certificateXml.matchAll(/<data>([\s\S]*?)<\/data>/g)].map(
    (match) => Buffer.from(match[1]!.replace(/\s/g, ""), "base64"),
  );
  const base = JSON.parse(
    run("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      "apps/desktop/src-tauri/Entitlements.plist",
    ]),
  );
  const claims = ownEntitlements(
    {
      teams: JSON.parse(extract("TeamIdentifier")),
      prefixes: JSON.parse(extract("ApplicationIdentifierPrefix")),
      allDevices: JSON.parse(extract("ProvisionsAllDevices")),
      expiresAt: extract("ExpirationDate", "raw").trim(),
      entitlements: JSON.parse(extract("Entitlements")),
      certificates: decodedCertificates,
    },
    certificate,
    env.APPLE_SIGNING_IDENTITY!,
    base,
  );
  writeFileSync(entitlements, JSON.stringify(claims), { mode: 0o600 });
  run("/usr/bin/plutil", ["-convert", "xml1", entitlements]);
  rmSync(decoded, { force: true });
  return {
    signingIdentity: env.APPLE_SIGNING_IDENTITY!,
    entitlements,
    files: { "embedded.provisionprofile": file },
  };
}
