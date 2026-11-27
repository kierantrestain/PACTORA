# PACTORA 1.1 work in progress (saved at usage limit)

Merged and tested on this branch:

- Owner provisioning and token-free first-owner registration (`/api/register`,
  `src/lib/owner-provisioning.ts`, `npm run owner:provision`).
- Google and Microsoft sign-in config with unverified-email (nOAuth) refusal.
- Workspace invitations and onboarding API.
- BotID removed; agreement metadata audit trail; copy-signing-link fallback.
- Unit tests: 630/630 pass. Full database suite: 461/461 pass. New-module database tests
  (provisioning 5, setup 14, invitations 8, agreements 12, manual link 3).

Not merged yet, saved as patches against this branch's history:

- `interface.patch`: new sign-up, sign-in and recovery pages; setup page retired
  (Agent A, partial: onboarding checklist and settings reorganisation unfinished).
- `email-engine.patch`: universal email engine in progress (Agent B, partial,
  untested).

Apply with `git apply --3way docs/pactora/wip/<name>.patch`, then run
`npm run typecheck && npm run lint && npm test && npm run test:db`.

Not done: settings reorganisation, Email & Integrations UI, real SMTP/OAuth
verification, Playwright and screenshots, Vercel redeploy (no Vercel access from
this environment), release documents.
