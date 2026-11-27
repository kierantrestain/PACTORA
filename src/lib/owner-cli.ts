import { randomBytes } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { withTransaction, type DbPool } from "./db/connection.ts";
import { emailSchema, nameSchema } from "./schemas/common.ts";
import { readSetupState, saveSettings } from "./settings.ts";
import { SETUP_ADVISORY_LOCK_ID } from "./setup.ts";
import { suggestSignupPolicy } from "./signup-policy.ts";

// Secure production owner provisioning, run by the operator with the
// database credentials (`npm run owner:provision`). It never goes through
// the web, so a public deployment has no owner claim anyone could race for.
// It takes the same lock as web setup, so the two cannot both create one.

export class OwnerProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerProvisioningError";
  }
}

const MIN_PASSWORD_LENGTH = 15;
const MAX_PASSWORD_LENGTH = 128;

export async function provisionOwner(
  input: { email: string; name: string; password: string },
  database: DbPool,
): Promise<{ email: string; userId: string }> {
  const email = emailSchema.safeParse(input.email);
  const name = nameSchema.safeParse(input.name);

  if (!email.success) {
    throw new OwnerProvisioningError("Give a valid email address.");
  }

  if (!name.success) {
    throw new OwnerProvisioningError("Give the owner's full name.");
  }

  if (
    input.password.length < MIN_PASSWORD_LENGTH ||
    input.password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new OwnerProvisioningError(
      `The password must be ${String(MIN_PASSWORD_LENGTH)} to ${String(MAX_PASSWORD_LENGTH)} characters.`,
    );
  }

  const normalizedEmail = email.data.toLowerCase();
  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [
      SETUP_ADVISORY_LOCK_ID,
    ]);

    const state = await readSetupState(tx);

    if (state.status === "complete") {
      throw new OwnerProvisioningError("This workspace already has an owner.");
    }

    if (state.status === "unmigrated") {
      throw new OwnerProvisioningError(
        "The database has no tables yet. Run `npm run db:migrate` first.",
      );
    }

    if (state.status === "unclaimed") {
      throw new OwnerProvisioningError(
        "This workspace already has accounts. Choose one of them with --promote <email>.",
      );
    }

    const userId = randomBytes(16).toString("base64url");

    await tx.query(
      `
        insert into public."user"
          (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        values ($1, $2, $3, true, 'admin', now(), now())
      `,
      [userId, name.data, normalizedEmail],
    );
    await tx.query(
      `
        insert into public.account
          (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        values ($1, $2, 'credential', $2, $3, now(), now())
      `,
      [randomBytes(16).toString("base64url"), userId, passwordHash],
    );

    const policy = suggestSignupPolicy(normalizedEmail);

    await saveSettings(
      {
        allowedEmailDomains: [...policy.allowedEmailDomains],
        setupCompletedAt: Math.floor(Date.now() / 1000),
        signupMode: policy.signupMode,
      },
      tx,
    );

    return { email: normalizedEmail, userId };
  }, database);
}

/** Makes an existing, verified account the owner of an unclaimed install. */
export async function promoteOwner(
  emailInput: string,
  database: DbPool,
): Promise<{ email: string; userId: string }> {
  const email = emailInput.trim().toLowerCase();

  return withTransaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [
      SETUP_ADVISORY_LOCK_ID,
    ]);

    const state = await readSetupState(tx);

    if (state.status === "complete") {
      throw new OwnerProvisioningError("This workspace already has an owner.");
    }

    const promoted = await tx.query<{ id: string }>(
      `
        update public."user" set role = 'admin', "updatedAt" = now()
        where lower(email) = $1 and "emailVerified"
        returning id
      `,
      [email],
    );
    const userId = promoted.rows[0]?.id;

    if (!userId) {
      throw new OwnerProvisioningError(
        "No verified account has that email address.",
      );
    }

    await saveSettings({ setupCompletedAt: Math.floor(Date.now() / 1000) }, tx);

    return { email, userId };
  }, database);
}
