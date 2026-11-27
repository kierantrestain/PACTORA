# PACTORA 1.1 licence audit

PACTORA is MIT licensed. It is built on SignuDoc (MIT); the upstream copyright
notice is kept in `LICENSE` and `THIRD_PARTY_NOTICES.md`, and per-package
licence texts are under `LICENSES/`.

## Added in 1.1

| Package | Version | Licence | Used for | Shipped |
| --- | --- | --- | --- | --- |
| `nodemailer` | 10.6.1 | MIT-0 | SMTP transport and MIME for the email engine | Yes |
| `mailparser` | 3.15.0 | MIT | Reading messages received by the test SMTP server | No (dev only) |
| `smtp-server` | 3.21.7 | MIT-0 | Real STARTTLS SMTP server in `email/engine.dbtest.ts` | No (dev only) |
| `@types/nodemailer`, `@types/mailparser`, `@types/smtp-server` | 8.0.2, 3.9.0, 3.5.13 | MIT | Type definitions | No (dev only) |

No other runtime dependency was added. Gmail and Microsoft Graph are called
with the platform `fetch`; no Google or Microsoft SDK is included.

## Removed

- `botid` (Vercel BotID): removed in 1.1 because its package declares no
  licence. Confirmed absent from `package.json` and `package-lock.json`, and no
  source file references it.

## Production dependency licences (from `package-lock.json`)

Counted over every non-development package in the lockfile on the release
commit: MIT 180, Apache-2.0 29, ISC 8, MIT-0 2, 0BSD 2, BSD-3-Clause 1,
Unlicense 1, MIT AND Zlib 1, CC-BY-4.0 1, BSD-3-Clause OR GPL-2.0 1, and the
LGPL-3.0-or-later `sharp` platform binaries below.

Items that need a note, all present before 1.1:

| Package | Licence | Note |
| --- | --- | --- |
| `@img/sharp-libvips-*`, `@img/sharp-*` | LGPL-3.0-or-later (with Apache-2.0/MIT) | Optional platform binaries pulled in by Next.js image optimisation. PACTORA sets `images.unoptimized` and never calls them. libvips is dynamically linked; LGPL obligations (offer source, allow relinking) are met by the unmodified upstream packages. |
| `node-forge` | BSD-3-Clause OR GPL-2.0 | Dual licence; PACTORA uses it under BSD-3-Clause. |
| `caniuse-lite` | CC-BY-4.0 | Browser-support data used at build time; attribution is in its package. |

## Software cost versus running cost

The software has no licence fee, seat price, per-signature charge, activation
server or remote kill switch. Running costs are the operator's own choice of
hosting: a server or Vercel plan, PostgreSQL (for example Neon), file storage
(local disk or Vercel Blob), and optionally an email provider. Standard SMTP,
or a Gmail or Microsoft 365 mailbox the organisation already has, is enough
for email. Qualified signatures through a trust service, if wanted, are a
separate contract with that provider.
