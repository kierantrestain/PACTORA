# Feature-gap matrix

Status against DocuSign, PandaDoc, Adobe Acrobat Sign, Documenso, DocuSeal,
Dropbox Sign and SignWell, for the 1.0.0 release candidate.

**Existing**: in the SignuDoc 0.9.2 foundation and kept as is. **Improve**:
existed and was extended in this release. **Missing → built**: added in this
release. **Blocked**: needs something outside the codebase. **Verified**:
covered by automated tests in this repository.

| Area | Capability | Status | Verified by |
| --- | --- | --- | --- |
| Envelopes | Upload PDF, up to 25 signers, sequential and parallel steps, approvers, copy recipients | Existing | `signing-steps.test.ts`, `approvers.dbtest.ts`, e2e |
| Envelopes | Deadlines, automatic and manual reminders, void, correct a signer's email, copy to draft | Existing | `envelope-deadline.*`, `automatic-reminders.dbtest.ts`, `signer-correction.*` |
| Fields | Signature, initials, date, name, text, number, checkbox, dropdown, radio; required/optional | Existing | `choice-fields.dbtest.ts`, `field.test.ts` |
| Identity | Access code, emailed one-time code, Part 11 re-authentication and signature meanings | Existing | `signer-email-code.dbtest.ts`, `part11.*` |
| Evidence | PAdES seal, LTV, hash-chained audit trail, audit certificate, public Verify page | Existing | `pdf-seal.test.ts`, `pdf-ltv.test.ts`, `verify.*` |
| Templates | Save envelope as template with roles, use template, Send to many (CSV) | Existing | `templates.*`, `bulk-send.*` |
| Integration | REST API with OpenAPI, signed webhooks, embedded signing with origin allow-list | Existing | `api/*.dbtest.ts`, `webhooks.*`, `embedding.dbtest.ts` |
| Administration | Teams, roles, SSO, two-step sign-in, session controls, backup and restore, retention | Existing | `teams`, `sso.*`, `backup.*`, `retention-job.*` |
| Brand | Product name PACTORA, upstream attribution, update channel | Improve | `software-update.test.ts` |
| Document creation | Document Builder: compose agreements from blocks (headings, text, pricing tables, signature blocks), variables, and a starter library; renders a PDF and opens a ready-to-send envelope with signature fields placed | Missing → built | `document-builder.test.ts`, `document-builder.dbtest.ts` |
| Document creation | Pricing tables with quantities, discounts, tax and totals | Missing → built | `document-builder.test.ts` |
| Agreement management | Completed-agreement repository with counterparty, value, effective and end dates, renewal notice, tags; expiring-soon view | Missing → built | `agreements.test.ts`, `agreements.dbtest.ts` |
| Compliance | CycloneDX SBOM, licence review | Missing → built | `docs/pactora/dependency-review.md` |
| Licensing | Perpetual licence, no licence server, no per-signature fees | Missing → built | `docs/pactora/licensing.md` |
| Bot protection | Vercel BotID (optional) | Improve later | Replace with a self-hosted challenge so the optional dependency can go |
| Payments | Collect payment on signing | Blocked | Needs a payment processor chosen and contracted by each customer |
| Qualified signatures | eIDAS QES through a qualified trust service | Blocked | Needs a contract with a QTSP; the signing-provider interface (`signing-providers.ts`) is the integration point |
| Deployment | Production deployment | Blocked until the owner connects hosting | See `docs/pactora/release.md` |
