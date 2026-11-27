import MailComposer from "nodemailer/lib/mail-composer";

import { type OutgoingMessage } from "./types.ts";

/** The message as nodemailer takes it, for SMTP and for raw MIME. */
export function toNodemailerMessage(message: OutgoingMessage) {
  return {
    attachments: message.attachments.map((attachment) => ({
      content: Buffer.from(attachment.content),
      contentType: attachment.contentType,
      filename: attachment.filename,
    })),
    from: message.from.name
      ? { address: message.from.address, name: message.from.name }
      : message.from.address,
    html: message.htmlBody,
    replyTo: message.replyTo ?? undefined,
    subject: message.subject,
    text: message.textBody,
    to: message.to,
  };
}

/** The whole message as RFC 5322 bytes, as Gmail's API takes it. */
export async function buildRawMime(message: OutgoingMessage): Promise<Buffer> {
  return new MailComposer(toNodemailerMessage(message)).compile().build();
}
