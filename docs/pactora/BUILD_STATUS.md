# PACTORA 1.1 build status

Recorded on 2026-11-27 in the development container, on branch
`claude/exciting-bardeen-lcwt8a`. Node.js 22.23 locally (the Docker image and
Vercel use Node.js 24), PostgreSQL 17 in Docker.

## Quality gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass: 0 errors, 8 warnings (all pre-existing, none in 1.1 code) |
| `npm test` | **630 / 630** pass |
| `npm run test:db` | **474 / 474** pass (461 before 1.1, plus 13 for the email engine and privacy) |
| `npm run test:e2e` (Playwright, production build) | **25 / 25** pass (2.8 min) |
| `docker build` | Pass (image `pactora:1.1-test`, built from the committed tree) |

## What each acceptance test covered

| Acceptance test | How it was verified | Result |
| --- | --- | --- |
| Token-free development sign-up | e2e first step: name, email, password only; no token or support field; lands on the dashboard with the checklist | Pass |
| First-owner concurrency protection | `owner-provisioning.dbtest.ts` (concurrent registrations, one owner); e2e second claim answered 409 `owner_exists` | Pass |
| Ordinary-user permissions | e2e: a later sign-up gets 403 from admin APIs and is redirected away from admin sections | Pass |
| Login, invitations, recovery, onboarding without email | e2e sign-up/verify/login; `invitations.dbtest.ts` (link returned when email fails); `manual-signing-link.dbtest.ts` | Pass |
| SMTP against a real test server | `email/engine.dbtest.ts`: `smtp-server` with STARTTLS and its own CA on 127.0.0.1:2525; messages parsed with `mailparser` (From, To, Reply-To, subject, body) | Pass |
| Gmail and Microsoft OAuth with authorised accounts | **Not run**: no Google or Microsoft OAuth client credentials in this environment. The Gmail flow (PKCE, state binding, single-use state, `gmail.send`-only scope, token refresh, revoked grant) passes against local stand-ins of Google's endpoints | Blocked externally |
| Expired tokens, reconnect, revocation, retries, duplicate prevention, mailbox isolation | `email/engine.dbtest.ts` | Pass |
| Delivery history, personal-data export and erasure | `email/engine.dbtest.ts` (history visibility, export, erasure), `signer-data.test.ts`, `retention-job.test.ts`, `account-purge.dbtest.ts` | Pass |
| create → edit → send → sign → seal → download → verify | e2e main flow | Pass |
| Existing documents, agreements and signatures remain valid | Full DB suite on the unchanged schema plus one additive migration; the 1.1 migration applied cleanly to an existing development database holding 1.0 data | Pass |
| Docker installation, migrations, persistent storage | `docker-compose.selfhost.yml`: 43/43 migrations on first start; `/api/health` ok; owner, envelope and stored PDF survived `up --force-recreate` and `down`/`up` | Pass |
| Backup restoration | `pg_dump` plus a tar of the files volume restored into a new stack with the same secrets: owner signed in, and the envelope's PDF came back byte-identical (SHA-256 `d3838676948fa0e3…`) | Pass |
| Desktop and mobile screenshots | 27 screenshots in `docs/pactora/screenshots`, captured from the Docker install and reviewed; defects found were fixed (see below) | Pass |

## Defects found by browser review and fixed

- Sign-up error swallowed when the server answered with empty field errors.
- The Support address label pointed at a wrapper with the same id, so the
  field had no accessible name.
- Page titles dropped the organisation name on pages with their own title.
- New panels used an undefined border token and rendered near-black borders.
- Editing a team-shared organisation mailbox silently widened it to everyone.

## Live deployment

- `https://pactora-indol.vercel.app` was checked from this container: it
  answers publicly (HTTP 307 to `/setup`, no Vercel Authentication challenge),
  so it is **not** behind deployment protection, and it still runs pre-1.1
  code that has never been set up.
- No Vercel CLI or token is available here, so a deployment could not be
  triggered or inspected directly. Pushing the branch triggers Vercel's Git
  integration if it is connected; see `RELEASE_REPORT.md` for the steps.

## Environment notes

- Inside the sandboxed Docker network the containers have no internet, so the
  self-host test ran with `PASSWORD_BREACH_CHECK=off`. A normal server keeps
  the breach check on.
- The Docker build in this container used `--network host` and the proxy CA as
  a build secret; an ordinary build needs neither.
