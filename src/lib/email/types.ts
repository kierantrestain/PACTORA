import { type EmailTemplateKind } from "../types/domain.ts";

// The shapes the email engine is built from. See
// docs/pactora/v1.1-architecture.md, section 4.

export type EmailAttachment = {
  content: Uint8Array;
  contentType: string;
  filename: string;
};

export type TransactionalEmailMessage = {
  /**
   * Where the organisation's own wording (Settings, Email & Integrations,
   * Email wording) may replace PACTORA's: the default opening paragraph as
   * this message has it, in both parts, and the values its placeholders
   * take. Links, deadlines and legal text are never part of it.
   */
  customization?: {
    introHtml: string;
    introText: string;
    variables: Partial<
      Record<
        | "document_title"
        | "organization_name"
        | "recipient_name"
        | "sender_name",
        string
      >
    >;
  };
  /**
   * The mailbox to send through, by id. Only test_email uses it: the
   * sender must be allowed to use that account, or nothing is sent.
   */
  accountId?: string;
  /** Not allowed in sendBatch: Resend's batch endpoint takes none. */
  attachments?: EmailAttachment[];
  /**
   * The envelope the message is about. The router finds the sender from
   * it when senderUserId is not given.
   */
  envelopeId?: string;
  htmlBody?: string;
  replyTo?: string;
  /** The person on whose behalf agreement mail is sent. */
  senderUserId?: string;
  subject: string;
  template: EmailTemplateKind;
  textBody: string;
  to: string;
};

export type EmailDeliveryResult = {
  accepted: string[];
  messageId?: string;
  rejected: string[];
};

export type EmailSendOptions = {
  idempotencyKey?: string;
};

export type EmailStream = "platform" | "agreement";

export type TransportProvider =
  "gmail" | "microsoft" | "smtp" | "resend" | "capture";

export type MailboxAddress = { address: string; name: string | null };

/** A message with its sender identity settled, ready for a transport. */
export type OutgoingMessage = {
  attachments: EmailAttachment[];
  from: MailboxAddress;
  htmlBody?: string;
  idempotencyKey?: string;
  replyTo: string | null;
  subject: string;
  template: EmailTemplateKind;
  textBody: string;
  to: string;
};

export interface EmailTransport {
  readonly provider: TransportProvider;
  readonly maxAttachmentBytes: number;
  send(message: OutgoingMessage): Promise<{ providerMessageId?: string }>;
}

/**
 * - transient: worth trying again (network, timeouts, 429, 5xx, SMTP 4xx).
 * - auth: the mailbox's credentials no longer work. Not tried again until
 *   someone reconnects it.
 * - permanent: trying again would fail the same way (a refused recipient,
 *   a message the provider will not take).
 */
export type DeliveryFailureKind = "transient" | "auth" | "permanent";

export class EmailTransportError extends Error {
  readonly kind: DeliveryFailureKind;
  readonly code: string | null;
  readonly statusCode: number | null;
  /** How long the provider asked to wait, when it said. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    {
      code = null,
      kind,
      retryAfterMs = null,
      statusCode = null,
    }: {
      code?: string | null;
      kind: DeliveryFailureKind;
      retryAfterMs?: number | null;
      statusCode?: number | null;
    },
  ) {
    super(message);
    this.name = "EmailTransportError";
    this.kind = kind;
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}
