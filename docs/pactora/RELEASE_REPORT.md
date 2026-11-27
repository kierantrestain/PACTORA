# PACTORA 1.1 release report

Branch `claude/exciting-bardeen-lcwt8a`. Test results are in
`BUILD_STATUS.md`, capabilities in `FEATURE_MATRIX.md`, dependencies in
`LICENSE_AUDIT.md`, and the security model in `/SECURITY.md`.

## What changed

1. **Sign-up.** The setup page is gone. The first visitor on a protected or
   local install creates the workspace with a name, an email and a password and
   lands in the dashboard. Public, unprotected deployments refuse that claim;
   their owner is provisioned from the server. Sign in, forgot password and
   Google/Microsoft buttons (shown only when configured) are on the new pages.
2. **Onboarding.** An optional, dismissible Getting Started checklist on the
   dashboard: name the workspace, add branding, connect a mailbox, create a
   first document, invite the team. Nothing is required to start sending; with
   no mailbox, senders copy signing links.
3. **Universal email engine.** One delivery engine behind the existing email
   interface, so every workflow uses it: sender-authorised routing, persistent
   history, idempotency, encrypted retries with backoff, a retry job,
   deferral until reconnect, and no silent fallback to another mailbox.
4. **Email & Integrations.** Gmail, Google Workspace, Microsoft 365, Outlook
   and Hotmail by OAuth (send permission only); Zoho, Yahoo and iCloud with app
   passwords; custom SMTP and optional Resend under Advanced. Connect,
   reconnect, disconnect, test email, sender choice, display name, reply-to,
   organisation sharing and default, delivery history with retry, and editable
   email wording that changes the messages actually sent.
5. **Settings.** Ten sections (Profile, Workspace, Team & Permissions, Email &
   Integrations, Branding, Document Defaults, Notifications, Security, Data &
   Backups, Advanced Administration) with search and redirects from old links;
   invitations UI; backups status.
6. **Privacy.** Delivery records are part of signer data exports and are
   erased by signer erasure and closed-account purges, except where an
   in-progress or Part 11 envelope must keep them.
7. **Self-hosting.** A Docker image and compose file with PostgreSQL and a
   persistent private files volume; `/api/health`; documented backup and
   restore, verified end to end.

## Deploying to the existing Vercel project

No Vercel access was available from the development container, so these steps
are for the project owner. Nothing here creates new Neon or Blob resources or
changes `BETTER_AUTH_SECRET` or any encryption key.

1. **Protection first.** In Vercel, Project `pactora` → Settings → Deployment
   Protection: turn on Vercel Authentication for **all deployments, including
   production** (`pactora-indol.vercel.app` currently answers the public
   without a challenge). Check it by opening the URL in a private window: you
   should see Vercel's sign-in, not PACTORA.
2. **Only then, token-free registration.** Add `PACTORA_ACCESS_PROTECTED=1`
   (Development/Preview, and Production only if step 1 covers production), and
   remove `SETUP_TOKEN` from those same environments. If protection stays off,
   leave `PACTORA_ACCESS_PROTECTED` unset and create the owner with
   `DATABASE_URL=<Neon URL> npm run owner:provision -- --email you@… --name "…"`
   or by keeping `SETUP_TOKEN` (now also read as `OWNER_PROVISIONING_TOKEN`) and
   calling `POST /api/setup` with it.
3. **Email (optional).** Either nothing (copy signing links), or
   `PLATFORM_SMTP_URL` for account emails, and mailboxes connected in Settings.
   For Google/Microsoft buttons set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
   and `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`, and register
   `https://<site>/api/auth/callback/google`,
   `https://<site>/api/auth/callback/microsoft` and
   `https://<site>/api/email/oauth/callback`.
4. **Deploy the tested commit.** Merge or promote the branch head (the commit
   that adds this report). The build runs `db/migrate.mjs`, which applies one
   additive migration (`20261128100000_email_accounts.sql`); existing data is
   untouched. `vercel.json` adds a daily `/api/internal/email` retry job.
5. **Check live.** `/api/health` → `{"status":"ok"}`; `/signup` shows "Create
   your workspace" (protected) or "Owner account not set up yet" (public);
   after signing in, Settings → Email & Integrations lists the providers, with
   Google/Microsoft marked "Not available yet" until step 3's credentials exist.

## Remaining external blockers

| Blocker | Needed from |
| --- | --- |
| Vercel deployment and runtime inspection | Vercel access (token or dashboard) for this project |
| Deployment protection on the production URL | Project owner, in Vercel settings |
| Live Gmail and Microsoft sending tests | OAuth client credentials; Google's verification of the `gmail.send` scope for external users; Microsoft tenant admin consent where required |
| Native S3 storage | Not built; use local disk (optionally a mounted bucket) or Vercel Blob |

## Recovered work

The saved `interface.patch` and `email-engine.patch` were applied with
`git apply --3way` in commit `e2bb19d` and completed in later commits, so the
`docs/pactora/wip` folder is removed in this release; both patches remain in
Git history.
