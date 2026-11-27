# Licensing and operating economics

PACTORA is sold on ownership, not on metering.

## What a customer gets

- **A perpetual licence.** The software is licensed under the MIT License
  (see `LICENSE`). A customer may run, copy, change and keep using any
  version they have received, for as long as they like, on as many
  installations as they like.
- **No per-signature, per-envelope or per-seat charges.** PACTORA itself
  counts nothing for billing. Unlimited standard signatures, documents,
  templates and users are limited only by the customer's own hosting.
- **No licence server.** PACTORA never calls home to check a key, and it
  keeps working with no connection to the vendor. The optional update check
  (Settings, Software updates) only reads the public release list on
  GitHub and can be ignored.
- **No mandatory subscription.** Updates are published as GitHub releases.
  A customer may take them, skip them, or stay on a version indefinitely.
- **Customer-owned infrastructure.** Documents live in the customer's own
  Postgres database and object store (Vercel Blob or local disk), in the
  customer's own accounts and region. Email goes through the customer's
  own Resend account.
- **No external AI services and no paid signing APIs.** Document creation
  is deterministic: the Document Builder lays out PDFs locally with
  `pdf-lib` and bundled fonts. Sealing uses the install's own PAdES
  certificate. Optional qualified signing providers can be added through
  `src/lib/services/signing-providers.ts`, but none is required.

## Commercial offers that fit this model

These are services around the software, never conditions for using it:

| Offer        | What it is                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Setup        | Deploying PACTORA into the customer's own accounts and handing over                             |
| Support plan | Optional, fixed yearly fee for help and priority fixes; lapsing it does not affect the software |
| Custom work  | Integrations, branding, compliance validation packages (see `docs/part11`)                      |

## Running costs (customer's own accounts)

On the free plans of Vercel, Neon and Resend a small team can send about
250 documents a month for $0. Beyond that, costs follow the hosting
providers' published prices, which the customer pays them directly.
