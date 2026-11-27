# Release 1.0.0-rc.1

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
4. Integrations: add Resend and connect it, so signing emails are
   delivered. Until then, the dashboard shows an email setup warning and
   envelopes cannot reach signers.
5. Redeploy, open the site, and complete `/setup` as the first visitor.
   Set `SETUP_TOKEN` first if the URL could be found by someone else.

Self-hosted: see `docs/self-hosting.md`.
