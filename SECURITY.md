# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in PACTORA, please report it privately. **Do not put the details in a public GitHub issue, discussion or pull request.**

Send your report through GitHub's private vulnerability reporting: open the [Report a vulnerability](https://github.com/kierantrestain/PACTORA/security/advisories/new) form, which is also on this repository's security advisories page. The report stays between you and the repository's maintainers. Include:

- A description of the vulnerability.
- Steps to reproduce or a proof of concept.
- The potential impact as you understand it.

If that form is not available to you, open an issue that asks the maintainers for a private way to reach them, and leave every detail of the vulnerability out of it.

The project has no email address for reports. Each organization that runs PACTORA gives its own install a support address, and that address reaches the organization, not the people who maintain this code. A problem with one particular site, such as its settings or the documents it holds, belongs with the organization that runs it.

We will acknowledge your report within 7 days and aim to provide a fix or mitigation plan within 30 days, depending on severity and complexity.

## Scope

This policy covers the PACTORA application code in this repository, including:

- Authentication and session handling
- Signing token and download token generation and verification
- Document storage and access controls
- API route authorization and rate limiting
- Email delivery logic

## Out of scope

- Vulnerabilities in third-party dependencies (report those to the upstream project, though we appreciate a heads-up)
- Issues in your own self-hosted deployment configuration (infrastructure, DNS, TLS, etc.)
- Social engineering attacks

## Supported versions

Security fixes are applied to the latest release only.

## How the code is checked

- **Static analysis.** GitHub CodeQL (the `security-extended` queries) runs on every pull request, on `main` and weekly, over the TypeScript and over the GitHub Actions workflows. See `.github/workflows/codeql.yml`.
- **Dependencies.** Every pull request runs GitHub's dependency review, which fails on a new dependency with a known high or critical vulnerability, or under a license this project does not take (GPL, AGPL, SSPL). `npm audit` checks what the app ships every week and on `main`. See `.github/workflows/dependency-audit.yml`.
- **Repository practices.** OpenSSF Scorecard scores the repository weekly; the result is at [scorecard.dev](https://scorecard.dev/viewer/?uri=github.com/kierantrestain/PACTORA).
- **Tests.** Typecheck, lint, unit tests, tests against a real Postgres and an end-to-end browser test run on every pull request (`.github/workflows/ci.yml`).

## Accounts, mailboxes and email (1.1)

- **Owner registration.** The first owner can be claimed without a token only where every request already passes an access gate: local development, or a deployment whose operator sets `PACTORA_ACCESS_PROTECTED=1` behind Vercel Authentication, a VPN or an SSO proxy. The claim is a single transaction, so two people racing for it cannot both win. Everywhere else the owner is provisioned from the server (`npm run owner:provision`) or with `OWNER_PROVISIONING_TOKEN`. Every later sign-up is an ordinary user; only an administrator grants the administrator role.
- **Mailbox authorisation.** Messages are sent only through a mailbox the sender owns, or an organisation mailbox an administrator shared with them, or the workspace default. A personal mailbox is invisible and unusable to everyone else, administrators included. A mailbox that needs reconnecting is never swapped for another one.
- **Credentials.** SMTP passwords, API keys and OAuth tokens are encrypted with AES-256-GCM, bound to the account they belong to, and never returned by any API or shown in Settings. Pending retries are stored encrypted and erased once sent or abandoned.
- **OAuth.** Google and Microsoft connections use the authorization code flow with PKCE (S256), a single-use state bound to the signed-in person and valid for ten minutes, and request send permission only (`gmail.send`, `Mail.Send`). Mailbox reading is never requested.
- **SMTP.** TLS is required (implicit on 465, mandatory STARTTLS elsewhere), only mail ports are dialled, and the host is resolved once and refused if it is private, loopback or link-local, so a DNS rebinding answer cannot redirect the connection. Certificates are verified against the host name.
- **Requests.** Every state-changing `/api/email` route requires a verified session, refuses cross-site requests (`Sec-Fetch-Site`, `Origin`), requires JSON bodies, and is rate limited.
- **Delivery log and personal data.** The delivery history keeps recipient, subject and outcome, never message bodies. A signer data export includes the delivery records for that address; a signer erasure and a closed-account purge erase the address and subject from them, except for envelopes kept for an in-progress signing or a Part 11 record.
- **Honest status.** A failed, queued or unverified delivery is never reported as sent, and a provider whose OAuth app is not configured is shown as unavailable rather than simulated.

## Verifying a release

Each release from v0.3.0 on has these files attached, made by `.github/workflows/release-artifacts.yml`:

- `signudoc-<version>.tar.gz`: the source of the tagged commit.
- `signudoc-<version>.cdx.json`: a software bill of materials in CycloneDX format, listing every npm package the app ships with its version and license.
- `SHA256SUMS`: their checksums.

Each file has a GitHub artifact attestation, signed through Sigstore, saying which workflow run in this repository made it from which commit. To check one with the GitHub CLI:

```sh
gh attestation verify signudoc-<version>.tar.gz -R kierantrestain/PACTORA
```

## Recognition

We appreciate responsible disclosure. If you report a valid vulnerability, we are happy to credit you in the fix commit or release notes unless you prefer to remain anonymous.
