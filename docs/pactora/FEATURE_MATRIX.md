# PACTORA 1.1 feature matrix

What the product does, checked against the code and the tests that exercise
it. **Verified** means an automated test in this repository runs the behaviour
end to end (unit, database or browser). **Built, not externally verified** means
the code is complete and tested against local stand-ins, but has not been run
against the real third-party service, because no credentials were available.

Standard signing, documents and users are unlimited. There are no per-signature
charges, seat limits, activation servers or licence checks.

## Accounts and onboarding

| Capability | Status | Evidence |
| --- | --- | --- |
| Sign-up with full name, email and password only; show/hide password | Verified | `e2e/signing-flow.spec.ts` (first step) |
| First owner is created token-free where the deployment is access-protected or local; a second claim is refused (409 `owner_exists`) | Verified | e2e first step, `owner-provisioning.dbtest.ts` |
| Ordinary sign-ups get role `user`, never administrator | Verified | e2e "log in" step (403 on admin APIs), `setup.dbtest.ts` |
| Public deployments without an access gate cannot be claimed from the web; owner provisioned with `npm run owner:provision` or a provisioning token | Verified | `owner-provisioning.dbtest.ts`, e2e "install with no administrator" step |
| Sign in, forgot password, reset, email verification pages | Verified | e2e (sign-up, verification, login steps); recovery shells |
| Continue with Google / Microsoft sign-in (identity scopes only) | Built, not externally verified | `auth/oauth-providers.test.ts`; buttons appear only when client IDs are set |
| Workspace invitations with copyable link, works without email | Verified | `invitations.dbtest.ts` |
| Getting Started checklist, every step optional, dismissible | Verified (API), screenshot-reviewed (UI) | `invitations.dbtest.ts` (onboarding), `docs/pactora/screenshots` |
| Documents can be created and sent with no email configured (manual signing links) | Verified | `manual-signing-link.dbtest.ts` |

## Email engine

| Capability | Status | Evidence |
| --- | --- | --- |
| One delivery engine behind `EmailService`; all existing workflows migrated | Verified | full `npm run test:db` and e2e suites send through it |
| Explicit mailbox routing: sender's own, shared organisation mailbox, workspace default, operator SMTP/Resend, dev outbox | Verified | `email/engine.dbtest.ts` |
| No unauthorised fallback: another person's mailbox, an unshared one, or a replacement for one that needs reconnecting is never used | Verified | `email/engine.dbtest.ts` |
| Persistent delivery history, idempotency keys, encrypted retry payloads, backoff, scheduled retry job, supersession of stale signing links | Verified | `email/engine.dbtest.ts` |
| SMTP with TLS, mail ports only, SSRF and DNS-rebinding refusal | Verified against a real STARTTLS server | `email/engine.dbtest.ts` (smtp-server on 127.0.0.1:2525) |
| Gmail / Google Workspace (OAuth PKCE, `gmail.send` only, refresh, revocation) | Built, not externally verified | `email/engine.dbtest.ts` against local stand-ins for Google's endpoints |
| Microsoft 365 / Outlook (OAuth PKCE, `Mail.Send` only, admin-consent detection) | Built, not externally verified | code paths in `email/oauth.ts`, `email/microsoft.ts` |
| Zoho, Yahoo, iCloud presets with app passwords; custom SMTP; optional Resend | Verified for SMTP; presets built | `email/engine.dbtest.ts`, `email/presets.ts` |
| Editable subject and opening paragraph for five messages, applied to sent mail, escaped | Verified | `email/engine.dbtest.ts` (custom wording) |
| Failed or queued delivery is never reported as sent | Verified | `email/engine.dbtest.ts`, `draft-changes.dbtest.ts` |

## Settings

| Capability | Status | Evidence |
| --- | --- | --- |
| Profile, Workspace, Team & Permissions, Email & Integrations, Branding, Document Defaults, Notifications, Security, Data & Backups, Advanced Administration | Verified | e2e navigates Workspace, Branding, Documents, Security, Data, Team, Advanced; screenshots of all |
| Settings search and old `/settings#anchor` links redirected | Built | `settings-frame.tsx`, `settings-index.ts` |
| Administrator-only sections hidden and redirected for ordinary users | Verified | e2e "log in" step |
| No stored credentials, signing keys or tokens ever displayed | Verified | API views exclude them (`accounts.ts` `toAccountView`); `email/engine.dbtest.ts` checks ciphertext |

## Core signing (carried from 1.0, re-verified)

| Capability | Status | Evidence |
| --- | --- | --- |
| PDF upload, Document Builder, templates, send to many | Verified | e2e, `templates.dbtest.ts`, `bulk-send.dbtest.ts`, `wizard-document-builder.spec.ts` |
| Fields, recipients, self-signing, sequential and parallel routing, approvers | Verified | e2e (`signing-same-time`, `signing-with-approvers`), `parallel-signing.dbtest.ts` |
| Consent, reminders, decline, void, deadlines, correction | Verified | e2e, `automatic-reminders.dbtest.ts`, `void-notification.dbtest.ts` |
| PAdES seal, LTV, audit certificate, tamper detection, independent verification | Verified | `pdf-seal.test.ts`, `pdf-ltv.test.ts`, `verify.dbtest.ts`, e2e verify step |
| Agreements repository, expiry and renewal reminders, metadata audit, CSV export | Verified | `agreements.dbtest.ts` |
| Part 11 mode, qualified signatures through a signing provider | Verified (provider stand-in) | e2e Part 11 and provider tests |

## Self-hosting

| Capability | Status | Evidence |
| --- | --- | --- |
| Docker install: app + PostgreSQL + persistent private storage volume | See `BUILD_STATUS.md` for the recorded run | `Dockerfile`, `docker-compose.selfhost.yml` |
| Local disk or Vercel Blob storage | Verified | `services/storage/blob.test.ts`, e2e uses local disk |
| Backup and restore, stable signing keys | Verified | `backup.dbtest.ts` |
| No phone-home, activation or kill switch | Verified by review | `docs/pactora/licensing.md` |

## Not in this release

| Item | Why |
| --- | --- |
| Native S3 storage driver | Local disk (which may be a mounted S3/NFS volume) and Vercel Blob are supported; a native driver would add a large SDK dependency |
| Live Gmail and Microsoft sending | Needs OAuth client credentials and, for Gmail, Google's app verification for the `gmail.send` scope |
| Collect payment on signing, eIDAS QES | Need contracts with a payment processor or a qualified trust service |
