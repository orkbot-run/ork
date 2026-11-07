// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 key wrapping is preserved. Whole-operation deadlines follow LICENSE.md.

import type * as KmsSdk from "@aws-sdk/client-kms";
import type { KeyProvider, KeyWrapContext, WrappedDataKey } from "@orkbot/adapter-kit";
import { withAbort } from "./web-ssrf.js";

export type AwsKmsKeyProviderConfig = {
  /** Key ARN, not an alias, which can be repointed without stored keys noticing. */
  keyArn: string;
} & ({ accessKeyId: string; secretAccessKey: string } | { profile: string });

const MASTER_KEY_PREFIX = "aws-kms:";
const KEY_ARN = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\/([A-Za-z0-9-]+)$/;
const OPERATION_TIMEOUT_MS = 10_000;

/** The same deadline bounds SDK setup, every retry, backoff and response-body decoding. */
async function withinDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Key manager request timed out")),
    OPERATION_TIMEOUT_MS,
  );
  timeout.unref();
  try {
    return await withAbort(work(controller.signal), controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Credentials are named explicitly rather than taken from the SDK's default chain, so the
 * key manager never borrows credentials configured for something else. A named profile
 * lets a maintainer's laptop use short-lived `aws login` or SSO credentials.
 */
export function awsKmsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AwsKmsKeyProviderConfig {
  const keyArn = env.AWS_KMS_KEY_ARN?.trim() ?? "";
  const accessKeyId = env.AWS_KMS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_KMS_SECRET_ACCESS_KEY?.trim();
  const profile = env.AWS_KMS_PROFILE?.trim();
  if (profile && !accessKeyId && !secretAccessKey) return { keyArn, profile };
  if (!profile && accessKeyId && secretAccessKey) return { keyArn, accessKeyId, secretAccessKey };
  throw new Error(
    "AWS KMS needs either AWS_KMS_ACCESS_KEY_ID and AWS_KMS_SECRET_ACCESS_KEY, or AWS_KMS_PROFILE",
  );
}

/**
 * Space keys wrapped by an AWS KMS key that never leaves KMS. The space and key version
 * travel as encryption context, so a wrapped key moved to another space fails to unwrap,
 * and every unwrap is recorded in CloudTrail.
 */
export class AwsKmsKeyProvider implements KeyProvider {
  private readonly masterKeyId: string;
  private readonly region: string;
  private kms?: Promise<{ sdk: typeof KmsSdk; client: KmsSdk.KMSClient }>;

  constructor(
    private readonly config: AwsKmsKeyProviderConfig,
    private readonly client?: KmsSdk.KMSClient,
  ) {
    const [, region, keyId] = KEY_ARN.exec(config.keyArn) ?? [];
    if (!region || !keyId)
      throw new Error(
        "AWS_KMS_KEY_ARN must be a KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>)",
      );
    this.masterKeyId = `${MASTER_KEY_PREFIX}${keyId}`;
    this.region = region;
  }

  /** The SDK loads on first use, so deployments without KMS never load it. */
  private connect() {
    this.kms ??= import("@aws-sdk/client-kms").then((sdk) => {
      const config = this.config;
      return {
        sdk,
        client:
          this.client ??
          new sdk.KMSClient({
            region: this.region,
            ...("profile" in config
              ? { profile: config.profile }
              : {
                  credentials: {
                    accessKeyId: config.accessKeyId,
                    secretAccessKey: config.secretAccessKey,
                  },
                }),
            maxAttempts: 3,
            requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
          }),
      };
    });
    return this.kms;
  }

  describe() {
    return {
      id: "aws-kms",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { rotate: true },
    };
  }

  activeKeyId(): string {
    return this.masterKeyId;
  }

  async wrap(dataKey: Uint8Array, context: KeyWrapContext): Promise<WrappedDataKey> {
    const { CiphertextBlob } = await withinDeadline(async (signal) => {
      const { sdk, client } = await this.connect();
      signal.throwIfAborted();
      return client.send(
        new sdk.EncryptCommand({
          KeyId: this.config.keyArn,
          Plaintext: dataKey,
          EncryptionContext: encryptionContext(context),
        }),
        { abortSignal: signal },
      );
    });
    if (!CiphertextBlob) throw new Error("AWS KMS returned no ciphertext");
    return {
      masterKeyId: this.masterKeyId,
      wrappedKey: Buffer.from(CiphertextBlob).toString("base64url"),
    };
  }

  /**
   * Keys wrapped by an earlier KMS key still unwrap, so `content-encryption rotate` can
   * move them after AWS_KMS_KEY_ARN changes: KMS finds that key from the ciphertext,
   * and the key it reports must be the one the stored key names.
   */
  async unwrap(wrapped: WrappedDataKey, context: KeyWrapContext): Promise<Uint8Array> {
    if (!wrapped.masterKeyId.startsWith(MASTER_KEY_PREFIX))
      throw new Error(`Master key ${wrapped.masterKeyId} is not configured`);
    const keyId = wrapped.masterKeyId.slice(MASTER_KEY_PREFIX.length);
    const { KeyId, Plaintext } = await withinDeadline(async (signal) => {
      const { sdk, client } = await this.connect();
      signal.throwIfAborted();
      return client.send(
        new sdk.DecryptCommand({
          KeyId: wrapped.masterKeyId === this.masterKeyId ? this.config.keyArn : undefined,
          CiphertextBlob: Buffer.from(wrapped.wrappedKey, "base64url"),
          EncryptionContext: encryptionContext(context),
        }),
        { abortSignal: signal },
      );
    }).catch((error: unknown) => {
      throw new Error(`Space key could not be unwrapped with master key ${wrapped.masterKeyId}`, {
        cause: error,
      });
    });
    if (!KeyId?.endsWith(`:key/${keyId}`))
      throw new Error(`AWS KMS unwrapped a space key with a key other than ${wrapped.masterKeyId}`);
    if (Plaintext?.length !== 32) throw new Error("AWS KMS returned a malformed space key");
    return Plaintext;
  }
}

function encryptionContext(context: KeyWrapContext): Record<string, string> {
  return {
    "orkbot:purpose": "space-key/v1",
    "orkbot:space": context.spaceId,
    "orkbot:version": String(context.version),
  };
}
