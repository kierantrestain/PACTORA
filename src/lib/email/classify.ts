import { EmailTransportError, type DeliveryFailureKind } from "./types.ts";

// Whether a failed send is worth trying again. Everything a transport
// throws passes through here, so the rest of the engine only sees
// EmailTransportError with a kind.

const NETWORK_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDNS",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ESOCKET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** For an HTTP API: 429 and 5xx pass, 401/403 are the credentials. */
export function kindForHttpStatus(status: number): DeliveryFailureKind {
  if (status === 429 || status >= 500 || status === 408) {
    return "transient";
  }

  return status === 401 || status === 403 ? "auth" : "permanent";
}

function readProperty(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null && name in error
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

/** The kind of a failure nodemailer reported for an SMTP conversation. */
export function kindForSmtpError(error: unknown): DeliveryFailureKind {
  const code = readProperty(error, "code");
  const responseCode = readProperty(error, "responseCode");

  if (code === "EAUTH" || responseCode === 535 || responseCode === 534) {
    return "auth";
  }

  if (typeof responseCode === "number") {
    if (responseCode >= 400 && responseCode < 500) {
      return "transient";
    }

    if (responseCode >= 500) {
      return "permanent";
    }
  }

  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return "transient";
  }

  const causeCode = readProperty(readProperty(error, "cause"), "code");

  if (typeof causeCode === "string" && NETWORK_CODES.has(causeCode)) {
    return "transient";
  }

  // A certificate that does not verify, a server without TLS, a message
  // the server cannot take: none of these fix themselves.
  return "permanent";
}

/** Any thrown value as an EmailTransportError. */
export function toTransportError(error: unknown): EmailTransportError {
  if (error instanceof EmailTransportError) {
    return error;
  }

  const code = readProperty(error, "code");
  const kind =
    typeof code === "string" && NETWORK_CODES.has(code)
      ? "transient"
      : error instanceof TypeError && /fetch failed/i.test(error.message)
        ? "transient"
        : "permanent";

  return new EmailTransportError(
    error instanceof Error && error.message
      ? error.message
      : "Email delivery failed.",
    { code: typeof code === "string" ? code : null, kind },
  );
}

/**
 * A fetch that threw never got an answer (no connection, a timeout), so
 * nothing was sent and it is worth trying again.
 */
export function fetchFailure(
  error: unknown,
  service: string,
): EmailTransportError {
  const timedOut =
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");

  return new EmailTransportError(
    timedOut
      ? `${service} did not answer in time.`
      : `${service} could not be reached.`,
    { code: timedOut ? "ETIMEDOUT" : "ECONNECTION", kind: "transient" },
  );
}

/** Retry-After in milliseconds, when the header is a number of seconds. */
export function retryAfterMs(header: string | null | undefined): number | null {
  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}
