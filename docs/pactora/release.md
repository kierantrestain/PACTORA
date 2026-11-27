# Release 1.1 (and 1.0.0-rc.1)

PACTORA 1.1 adds token-free sign-up, the universal email engine and the
sectioned Settings; see `RELEASE_REPORT.md` in this folder.

## 1.0.0-rc.1

## What is in this release

- The SignuDoc 0.9.2 foundation (envelopes, signing, PAdES sealing, audit
  certificates, templates, bulk send, API, webhooks, embedded signing,
  teams, SSO, Part 11 mode), rebranded as PACTORA.
- **Document Builder** (`/builder`): write agreements from blocks, pricing
  tables, signature blocks and variables, with a starter library and
  personal templates. Sending renders a PDF and opens a draft envelope
  with every field placed.
- **Agreements** (`/agreements`): completed envelopes as a managed
  repository with counterparty, value, dates, tags, renewal reminders and
  CSV export.
- SBOM (`sbom.cdx.json`), dependency review, feature-gap matrix and
  licensing model in `docs/pactora`.

## Quality gates

Run before every release:

```bash
npm run typecheck
npm run lint
npm test
npm run test:db
npm run test:e2e
npm run build
```

## Deploying

A PACTORA install needs Postgres, a private file store and an email
sender, all in the customer's own accounts.

On Vercel:

1. Create a project from the repository.
2. Storage: create a **private** Blob store and connect it to the project.
3. Storage: create a Neon Postgres database and connect it to the project.
   The build runs the migrations (`vercel.json` build command).
4. Email (optional, no paid service needed): after the owner exists,
   connect a mailbox in Settings, Email & Integrations, or set
   `PLATFORM_SMTP_URL`. Without one, senders copy signing links instead.
5. The first owner. If the deployment is protected (Vercel Authentication on
   every URL that reaches it), set `PACTORA_ACCESS_PROTECTED=1` and sign up at
   `/signup`. Otherwise do not: provision the owner with
   `DATABASE_URL=… npm run owner:provision -- --email … --name …`, or with
   `OWNER_PROVISIONING_TOKEN` through `POST /api/setup`. Token-free
   registration on an unprotected public URL is refused by design.

Self-hosted: see `docs/self-hosting.md`.
