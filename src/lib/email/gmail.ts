import { fetchFailure, kindForHttpStatus, retryAfterMs } from "./classify.ts";
import { buildRawMime } from "./mime.ts";
import {
  EmailTransportError,
  type EmailTransport,
  type OutgoingMessage,
} from "./types.ts";

// Sends through the Gmail API (users.messages.send) with the mailbox's own
// OAuth grant, scope gmail.send. The message goes up as raw MIME, so what
// arrives is exactly what was composed.
// https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send

export const GMAIL_API_BASE = "https://gmail.googleapis.com";

/**
 * Gmail takes messages up to 35 MB as sent; base64url makes the upload a
 * third larger than the attachments, and the request is capped too, so
 * attachments stay at 25 MB.
 */
export const GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type GmailTransportOptions = {
  apiBase?: string;
  fetch?: typeof fetch;
  /** A current access token; refreshed by the caller when it runs out. */
  getAccessToken: () => Promise<string>;
};

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; status?: string };
  } | null;

  return (
    body?.error?.message ??
    `Gmail refused the message (HTTP ${String(response.status)}).`
  );
}

export function createGmailTransport({
  apiBase = GMAIL_API_BASE,
  fetch: fetchImpl = fetch,
  getAccessToken,
}: GmailTransportOptions): EmailTransport {
  return {
    maxAttachmentBytes: GMAIL_MAX_ATTACHMENT_BYTES,
    provider: "gmail",
    async send(message: OutgoingMessage) {
      const raw = (await buildRawMime(message)).toString("base64url");
      const accessToken = await getAccessToken();
      let response: Response;

      try {
        response = await fetchImpl(
          `${apiBase}/gmail/v1/users/me/messages/send`,
          {
            body: JSON.stringify({ raw }),
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            method: "POST",
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (error) {
        throw fetchFailure(error, "Gmail");
      }

      if (!response.ok) {
        throw new EmailTransportError(await readError(response), {
          kind: kindForHttpStatus(response.status),
          retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
          statusCode: response.status,
        });
      }

      const body = (await response.json().catch(() => null)) as {
        id?: string;
      } | null;

      return { providerMessageId: body?.id };
    },
  };
}
