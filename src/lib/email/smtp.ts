import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import nodemailer, { type Transporter } from "nodemailer";

import { isPrivateAddress } from "../services/private-address.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import { kindForSmtpError } from "./classify.ts";
import { toNodemailerMessage } from "./mime.ts";
import { type SmtpSecurity } from "./presets.ts";
import {
  EmailTransportError,
  type EmailTransport,
  type OutgoingMessage,
} from "./types.ts";

// SMTP through nodemailer, for Zoho, Yahoo, iCloud and any other server.
//
// The server's name comes from whoever connects the account, so it is
// treated like any other address from outside:
//
// - Only the mail ports (25, 465, 587, 2525), and only with TLS: implicit
//   TLS on 465, or STARTTLS that must succeed (requireTLS) elsewhere.
// - The name is looked up once, and an address in a private, loopback or
//   link-local range is refused (SMTP_ALLOW_PRIVATE_HOSTS=1 allows them
//   for a relay on the operator's own network, and for tests).
// - The connection is made to that one address, with the original name as
//   the TLS server name, so the certificate is still checked against the
//   name. A second lookup that answers differently (DNS rebinding) is
//   never made.

export const ALLOWED_SMTP_PORTS = [25, 465, 587, 2525] as const;

/** Most servers take 25 MB or more; base64 grows it by a third on the wire. */
export const SMTP_MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;

export type SmtpSettings = {
  host: string;
  password: string;
  port: number;
  security: SmtpSecurity;
  username: string;
};

export type ResolveAddresses = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

export type SmtpTransportOptions = {
  env?: EnvSource;
  /** Replaced in tests to answer like a DNS server would. */
  lookup?: ResolveAddresses;
  /**
   * Internal, for tests: a certificate authority to trust for this
   * connection only, so a local test server's own certificate verifies.
   * Verification itself is never turned off.
   */
  trustedCa?: string;
};

const defaultLookup: ResolveAddresses = (host) =>
  dnsLookup(host, { all: true, verbatim: true });

const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeSmtpHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** What is wrong with these settings, field by field; empty when nothing. */
export function checkSmtpEndpoint(input: {
  host: string;
  port: number;
  security: SmtpSecurity;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  const host = normalizeSmtpHost(input.host);

  if (
    !host ||
    (!isIP(host.replace(/^\[|\]$/g, "")) && !HOST_PATTERN.test(host))
  ) {
    errors.host =
      "Enter the SMTP server's host name, such as smtp.example.com.";
  }

  if (!(ALLOWED_SMTP_PORTS as readonly number[]).includes(input.port)) {
    errors.port = "Use port 465 (TLS), 587 (STARTTLS), 25 or 2525.";
  } else if (input.port === 465 && input.security !== "tls") {
    errors.security = "Port 465 uses TLS from the start. Choose TLS.";
  } else if (input.port !== 465 && input.security === "tls") {
    errors.security = `Port ${String(input.port)} uses STARTTLS. Choose STARTTLS, or port 465 for TLS.`;
  }

  return errors;
}

function refused(message: string): EmailTransportError {
  return new EmailTransportError(message, {
    code: "smtp_host_refused",
    kind: "permanent",
  });
}

/**
 * The one address this host is dialled at. Looked up once; refused when
 * it is private and private hosts are not allowed.
 */
export async function resolveSmtpAddress(
  host: string,
  { env = process.env, lookup = defaultLookup }: SmtpTransportOptions = {},
): Promise<string> {
  const name = normalizeSmtpHost(host).replace(/^\[|\]$/g, "");
  const allowPrivate = readEnv(env, "SMTP_ALLOW_PRIVATE_HOSTS") === "1";
  let addresses: string[];

  if (isIP(name)) {
    addresses = [name];
  } else {
    if (!allowPrivate && isPrivateAddress(name)) {
      throw refused(
        `${name} is a local address. Use the mail server's public name.`,
      );
    }

    try {
      addresses = (await lookup(name)).map((entry) => entry.address);
    } catch (error) {
      const code = (error as { code?: unknown }).code;

      throw new EmailTransportError(
        code === "ENOTFOUND" || code === "ENODATA"
          ? `The SMTP server ${name} was not found. Check its name.`
          : `The SMTP server ${name} could not be looked up.`,
        {
          code: typeof code === "string" ? code : "EDNS",
          kind:
            code === "ENOTFOUND" || code === "ENODATA"
              ? "permanent"
              : "transient",
        },
      );
    }
  }

  const usable = allowPrivate
    ? addresses
    : addresses.filter((address) => !isPrivateAddress(address));

  if (usable.length === 0) {
    throw refused(
      addresses.length === 0
        ? `The SMTP server ${name} has no address.`
        : `${name} points to a private network address, which PACTORA does not connect to.`,
    );
  }

  return usable[0]!;
}

function buildNodemailerOptions(
  settings: SmtpSettings,
  address: string,
  options: SmtpTransportOptions,
) {
  const host = normalizeSmtpHost(settings.host).replace(/^\[|\]$/g, "");
  const servername = isIP(host) ? undefined : host;

  return {
    auth: { pass: settings.password, user: settings.username },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    // The address looked up above, never the name: see the top of the file.
    host: address,
    ignoreTLS: false,
    port: settings.port,
    requireTLS: settings.security === "starttls",
    secure: settings.security === "tls",
    servername,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: {
      ...(options.trustedCa ? { ca: [options.trustedCa] } : {}),
      minVersion: "TLSv1.2" as const,
      rejectUnauthorized: true,
      servername,
    },
  };
}

function describeSmtpError(error: unknown, host: string): string {
  const code = (error as { code?: unknown }).code;
  const response = (error as { response?: unknown }).response;

  if (code === "EAUTH") {
    return `${host} did not accept the user name and password${
      typeof response === "string" ? ` (${response.slice(0, 200)})` : ""
    }.`;
  }

  if (
    code === "ETLS" ||
    /certificate|self.signed|altnames/i.test(String((error as Error).message))
  ) {
    return `The TLS connection to ${host} could not be verified: ${(error as Error).message}`;
  }

  if (code === "ETIMEDOUT") {
    return `${host} did not answer in time.`;
  }

  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ESOCKET") {
    return `Could not connect to ${host}: ${(error as Error).message}`;
  }

  return error instanceof Error && error.message
    ? error.message
    : `${host} refused the message.`;
}

function toSmtpError(error: unknown, host: string): EmailTransportError {
  if (error instanceof EmailTransportError) {
    return error;
  }

  const code = (error as { code?: unknown }).code;
  const responseCode = (error as { responseCode?: unknown }).responseCode;

  return new EmailTransportError(describeSmtpError(error, host), {
    code: typeof code === "string" ? code : null,
    kind: kindForSmtpError(error),
    statusCode: typeof responseCode === "number" ? responseCode : null,
  });
}

async function withConnection<T>(
  settings: SmtpSettings,
  options: SmtpTransportOptions,
  run: (transporter: Transporter) => Promise<T>,
): Promise<T> {
  const endpointErrors = checkSmtpEndpoint(settings);
  const firstError = Object.values(endpointErrors)[0];

  if (firstError) {
    throw refused(firstError);
  }

  const address = await resolveSmtpAddress(settings.host, options);
  const transporter = nodemailer.createTransport(
    buildNodemailerOptions(settings, address, options),
  );

  try {
    return await run(transporter);
  } catch (error) {
    throw toSmtpError(error, normalizeSmtpHost(settings.host));
  } finally {
    transporter.close();
  }
}

/** Connects, starts TLS and signs in, without sending anything. */
export async function verifySmtpSettings(
  settings: SmtpSettings,
  options: SmtpTransportOptions = {},
): Promise<void> {
  await withConnection(settings, options, async (transporter) => {
    await transporter.verify();
  });
}

export function createSmtpTransport(
  settings: SmtpSettings,
  options: SmtpTransportOptions = {},
): EmailTransport {
  return {
    maxAttachmentBytes: SMTP_MAX_ATTACHMENT_BYTES,
    provider: "smtp",
    send: (message: OutgoingMessage) =>
      withConnection(settings, options, async (transporter) => {
        const info = (await transporter.sendMail(
          toNodemailerMessage(message),
        )) as { messageId?: string; rejected?: unknown[] };

        if (Array.isArray(info.rejected) && info.rejected.length > 0) {
          throw new EmailTransportError(
            `${normalizeSmtpHost(settings.host)} refused the recipient ${message.to}.`,
            { code: "EENVELOPE", kind: "permanent" },
          );
        }

        return { providerMessageId: info.messageId };
      }),
  };
}

/**
 * PLATFORM_SMTP_URL: smtps://user:password@host:465 for implicit TLS, or
 * smtp://user:password@host:587 for STARTTLS (always required).
 */
export function parseSmtpUrl(value: string): SmtpSettings {
  const url = new URL(value);

  if (url.protocol !== "smtps:" && url.protocol !== "smtp:") {
    throw new Error("PLATFORM_SMTP_URL must start with smtps:// or smtp://.");
  }

  const security: SmtpSecurity = url.protocol === "smtps:" ? "tls" : "starttls";

  return {
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port: url.port ? Number(url.port) : security === "tls" ? 465 : 587,
    security,
    username: decodeURIComponent(url.username),
  };
}
