import { fetchFailure, kindForHttpStatus, retryAfterMs } from "./classify.ts";
import {
  EmailTransportError,
  type EmailTransport,
  type OutgoingMessage,
} from "./types.ts";

// Sends through Microsoft Graph (POST /me/sendMail) with the mailbox's own
// OAuth grant, scope Mail.Send. Works for Microsoft 365 work and school
// mailboxes and for Outlook.com / Hotmail.
// https://learn.microsoft.com/graph/api/user-sendmail

export const GRAPH_API_BASE = "https://graph.microsoft.com";

/**
 * Graph takes a request of up to 4 MB, attachments included, and the
 * attachments go inline as base64. Kept at 3 MB of files; callers send
 * download links instead when the files are larger (fitsAsAttachments).
 */
export const GRAPH_MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

type MicrosoftTransportOptions = {
  apiBase?: string;
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string>;
};

export function buildGraphSendMailBody(message: OutgoingMessage) {
  return {
    message: {
      attachments: message.attachments.map((attachment) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        contentBytes: Buffer.from(attachment.content).toString("base64"),
        contentType: attachment.contentType,
        name: attachment.filename,
      })),
      body: message.htmlBody
        ? { content: message.htmlBody, contentType: "HTML" }
        : { content: message.textBody, contentType: "Text" },
      ...(message.replyTo
        ? { replyTo: [{ emailAddress: { address: message.replyTo } }] }
        : {}),
      subject: message.subject,
      toRecipients: [{ emailAddress: { address: message.to } }],
    },
    saveToSentItems: true,
  };
}

async function readError(response: Response): Promise<{
  code: string | null;
  message: string;
}> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;

  return {
    code: body?.error?.code ?? null,
    message:
      body?.error?.message ??
      `Microsoft refused the message (HTTP ${String(response.status)}).`,
  };
}

export function createMicrosoftTransport({
  apiBase = GRAPH_API_BASE,
  fetch: fetchImpl = fetch,
  getAccessToken,
}: MicrosoftTransportOptions): EmailTransport {
  return {
    maxAttachmentBytes: GRAPH_MAX_ATTACHMENT_BYTES,
    provider: "microsoft",
    async send(message: OutgoingMessage) {
      const size = message.attachments.reduce(
        (total, attachment) => total + attachment.content.byteLength,
        0,
      );

      if (size > GRAPH_MAX_ATTACHMENT_BYTES) {
        throw new EmailTransportError(
          "The attachments are too large for Microsoft to send. Send download links instead.",
          { code: "attachments_too_large", kind: "permanent" },
        );
      }

      const accessToken = await getAccessToken();
      let response: Response;

      try {
        response = await fetchImpl(`${apiBase}/v1.0/me/sendMail`, {
          body: JSON.stringify(buildGraphSendMailBody(message)),
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          method: "POST",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        throw fetchFailure(error, "Microsoft Graph");
      }

      if (!response.ok) {
        const { code, message: text } = await readError(response);

        throw new EmailTransportError(text, {
          code,
          // A mailbox without an Exchange Online licence, or one whose
          // sending was blocked, answers 403 too: either way the account
          // has to be looked at, not the message.
          kind: kindForHttpStatus(response.status),
          retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
          statusCode: response.status,
        });
      }

      // 202 Accepted, with no body and no message id. Graph's request id
      // is what Microsoft support asks for, so that is kept instead.
      const requestId = response.headers.get("request-id");

      return {
        providerMessageId: requestId ? `graph-request-${requestId}` : undefined,
      };
    },
  };
}
