import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import {
  isProduction,
  readEnv,
  resolveAuthSecret,
  type EnvSource,
} from "../utils/env.ts";

// Mailbox credentials (passwords, API keys, OAuth tokens) and pending
// message payloads are kept in the database encrypted with AES-256-GCM.
//
// The key is EMAIL_CREDENTIALS_KEY when set (32 bytes, hex or base64), so
// it can be rotated apart from the auth secret. Otherwise it is derived
// from the auth secret with HKDF-SHA256 for this purpose only.
//
// A sealed value reads "ec1.<key id>.<iv>.<tag>.<ciphertext>", base64url.
// The key id is a short fingerprint of the key, so a value sealed under a
// key that has since changed is told apart from one that was tampered with.
// Each value is bound to what it belongs to (additional authenticated
// data), so a ciphertext copied onto another row does not open there.

const KEY_CONTEXT = "pactora/email-credentials/v1";
const FORMAT_VERSION = "ec1";

export class EmailCredentialsError extends Error {
  readonly reason: "malformed" | "other_key" | "tampered";

  constructor(reason: "malformed" | "other_key" | "tampered") {
    super(
      reason === "other_key"
        ? "These credentials were saved under a different encryption key. Reconnect the account."
        : "These credentials could not be read. Reconnect the account.",
    );
    this.name = "EmailCredentialsError";
    this.reason = reason;
  }
}

function parseConfiguredKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, "hex");
  }

  const decoded = Buffer.from(value, "base64");

  if (decoded.byteLength === 32) {
    return decoded;
  }

  throw new Error(
    "EMAIL_CREDENTIALS_KEY must be 32 bytes, written as 64 hex characters or in base64.",
  );
}

/** The key mailbox credentials are sealed with. */
export function resolveCredentialsKey(env: EnvSource = process.env): Buffer {
  const configured = readEnv(env, "EMAIL_CREDENTIALS_KEY");

  if (configured) {
    return parseConfiguredKey(configured);
  }

  const secret = resolveAuthSecret(env);

  if (!secret) {
    if (isProduction(env)) {
      throw new Error(
        "Saving email credentials needs EMAIL_CREDENTIALS_KEY or BETTER_AUTH_SECRET.",
      );
    }

    // Local development without any secret: nothing worth protecting.
    return Buffer.from(
      hkdfSync("sha256", "pactora-development", "", KEY_CONTEXT, 32),
    );
  }

  return Buffer.from(hkdfSync("sha256", secret, "", KEY_CONTEXT, 32));
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 8);
}

type SealOptions = {
  /** What the value belongs to, such as "email-account:<id>". */
  context: string;
  env?: EnvSource;
  key?: Buffer;
};

export function sealSecret(
  plaintext: string,
  { context, env, key = resolveCredentialsKey(env) }: SealOptions,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  cipher.setAAD(Buffer.from(context, "utf8"));

  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [
    FORMAT_VERSION,
    keyId(key),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/** The plaintext, or an EmailCredentialsError saying why it cannot be had. */
export function openSecret(
  sealed: string,
  { context, env, key = resolveCredentialsKey(env) }: SealOptions,
): string {
  const parts = sealed.split(".");

  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
    throw new EmailCredentialsError("malformed");
  }

  const [, sealedKeyId, iv, tag, body] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (sealedKeyId !== keyId(key)) {
    throw new EmailCredentialsError("other_key");
  }

  try {
    // The tag length is fixed, so a shortened tag is refused rather than
    // checked on fewer bytes.
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
      { authTagLength: 16 },
    );

    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new EmailCredentialsError("tampered");
  }
}

export function sealJson(value: unknown, options: SealOptions): string {
  return sealSecret(JSON.stringify(value), options);
}

export function openJson<T>(sealed: string, options: SealOptions): T {
  return JSON.parse(openSecret(sealed, options)) as T;
}
