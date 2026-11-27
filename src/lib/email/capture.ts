import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { CAPTURED_MESSAGE_ID_PREFIX } from "../services/captured-email.ts";
import { isLocalDeployment, readEnv, type EnvSource } from "../utils/env.ts";
import { buildResendPayload } from "./resend.ts";
import { type EmailTransport, type OutgoingMessage } from "./types.ts";

// Development and test driver (EMAIL_DRIVER=capture): nothing is sent.
// Each message is written as a JSON file so a person, or the end-to-end
// test, can read the links in it. Never allowed on Vercel or on a deployed
// production site, because it drops every email.

const DEFAULT_CAPTURE_DIR = ".data/outbox";

export const CAPTURE_IN_PRODUCTION_ERROR_MESSAGE =
  "EMAIL_DRIVER=capture drops every email and cannot be used in production.";

/**
 * Whether EMAIL_DRIVER=capture may be used in this deployment.
 * Allowed in development, and for a production build that is being run on
 * localhost (which is what the end-to-end test does). Never on Vercel or on
 * a deployed production site.
 */
export function isCaptureEmailDriverAllowed(
  env: EnvSource = process.env,
): boolean {
  if (readEnv(env, "VERCEL") === "1") {
    return false;
  }

  if (env.NODE_ENV !== "production") {
    return true;
  }

  try {
    return isLocalDeployment(env);
  } catch {
    return false;
  }
}

export function createCaptureTransport(
  env: EnvSource = process.env,
): EmailTransport {
  if (!isCaptureEmailDriverAllowed(env)) {
    throw new Error(CAPTURE_IN_PRODUCTION_ERROR_MESSAGE);
  }

  // The comment stops Turbopack from tracing the whole project into the
  // server bundle because of a path it cannot analyse.
  const captureDir = path.resolve(
    /*turbopackIgnore: true*/ env.EMAIL_CAPTURE_DIR?.trim() ||
      DEFAULT_CAPTURE_DIR,
  );

  return {
    // Nothing leaves the machine, so anything fits.
    maxAttachmentBytes: Number.MAX_SAFE_INTEGER,
    provider: "capture",
    async send(message: OutgoingMessage) {
      const messageId = `${CAPTURED_MESSAGE_ID_PREFIX}${randomUUID()}`;
      const filePath = path.join(
        /*turbopackIgnore: true*/ captureDir,
        `${String(Date.now())}-${messageId}.json`,
      );
      const temporaryPath = `${filePath}.tmp`;

      // Written under a temporary name and renamed, so anything watching
      // the outbox never reads a half-written file.
      await mkdir(captureDir, { recursive: true });
      await writeFile(
        temporaryPath,
        JSON.stringify(
          {
            ...buildResendPayload({ ...message, attachments: [] }),
            // The files themselves are not written out; their names, sizes
            // and fingerprints are enough to check what would have been sent.
            attachments: message.attachments.length
              ? message.attachments.map((attachment) => ({
                  bytes: attachment.content.byteLength,
                  contentType: attachment.contentType,
                  filename: attachment.filename,
                  sha256: createHash("sha256")
                    .update(attachment.content)
                    .digest("hex"),
                }))
              : undefined,
            capturedAt: new Date().toISOString(),
            messageId,
            template: message.template,
          },
          null,
          2,
        ),
      );
      await rename(temporaryPath, filePath);
      console.info(
        `[email:capture] ${message.template} to ${message.to} -> ${filePath}`,
      );

      return { providerMessageId: messageId };
    },
  };
}
