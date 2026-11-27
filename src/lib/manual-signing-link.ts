import {
  getDb,
  queryOne,
  withTransaction,
  type DbPool,
} from "./db/connection.ts";
import {
  isEnvelopeExpired,
  signingLinkLifetimeSeconds,
} from "./envelope-deadline.ts";
import { recordAuditEvent } from "./services/audit.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import type { EnvSource } from "./utils/env.ts";

// A signing link the sender copies and shares themselves, for when email
// cannot reach a signer (no mailbox connected, a bounce, a strict filter).
//
// Only the envelope's sender may ask, only for a signer whose turn it is,
// and only while the envelope is out and inside its deadline. Asking issues
// a fresh link and retires the previous one, so there is never more than
// one live link per signer. The signer still passes every check the
// envelope asks for (access code, email code, account sign-in): a copied
// link is the same link an email would carry, nothing more.

export class ManualLinkError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ManualLinkError";
    this.statusCode = statusCode;
  }
}

export async function issueManualSigningLink(
  input: {
    actor: { email: string; id: string };
    envelopeId: string;
    ipAddress?: string | null;
    signerId: string;
    userAgent?: string | null;
  },
  {
    database = getDb(),
    env = process.env,
    now = Math.floor(Date.now() / 1000),
  }: { database?: DbPool; env?: EnvSource; now?: number } = {},
): Promise<{ expiresAt: number; url: string }> {
  return withTransaction(async (tx) => {
    const envelope = await queryOne<{
      delivery: string | null;
      expiresAt: number | null;
      status: string;
    }>(
      tx,
      `select status, delivery, expires_at as "expiresAt"
       from envelopes
       where id = $1 and user_id = $2
       for no key update`,
      [input.envelopeId, input.actor.id],
    );

    if (!envelope) {
      throw new ManualLinkError("This envelope is unavailable.", 404);
    }

    if (envelope.status !== "sent") {
      throw new ManualLinkError(
        "Signing links can only be shared while an envelope is out for signature.",
        409,
      );
    }

    if (envelope.delivery === "embedded") {
      throw new ManualLinkError(
        "This envelope is signed in another app, which holds its links.",
        409,
      );
    }

    if (isEnvelopeExpired(envelope, now)) {
      throw new ManualLinkError(
        "This envelope's deadline has passed. Set a new deadline first.",
        409,
      );
    }

    const signer = await queryOne<{ email: string; id: string; name: string }>(
      tx,
      `select id, name, email from signers
       where id = $1 and envelope_id = $2 and status = 'notified'
       for update`,
      [input.signerId, input.envelopeId],
    );

    if (!signer) {
      throw new ManualLinkError(
        "It isn't this person's turn to sign, or they have already finished.",
        409,
      );
    }

    const link = await issueSigningLink(
      {
        expiresInSeconds: signingLinkLifetimeSeconds(envelope.expiresAt, now),
        issuedAt: now,
      },
      { env },
    );

    await tx.query(
      `update signers
       set signing_token_hash = $1, signing_token_expires_at = $2, updated_at = $3
       where id = $4`,
      [link.tokenHash, link.exp, now, signer.id],
    );
    await recordAuditEvent(
      {
        actorEmail: input.actor.email,
        actorType: "sender",
        createdAt: now,
        envelopeId: input.envelopeId,
        event: "link_shared",
        ipAddress: input.ipAddress ?? null,
        metadata: {
          signerEmail: signer.email,
          signerId: signer.id,
          signerName: signer.name,
        },
        userAgent: input.userAgent ?? null,
      },
      tx,
    );

    return { expiresAt: link.exp, url: link.url };
  }, database);
}
