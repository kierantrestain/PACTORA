# Dependency and licence review

Reviewed 2026-11-27 for the 1.0.0 release candidate. The full inventory is
`sbom.cdx.json` (CycloneDX, production dependencies, regenerate with
`npm run sbom`). 173 production packages: 148 MIT, 13 Apache-2.0, 4 ISC, and
the rest listed below.

| Package                                     | Licence                     | Decision                                                                                                                                                               |
| ------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-forge`                                | BSD-3-Clause OR GPL-2.0     | Used under BSD-3-Clause.                                                                                                                                               |
| `@img/sharp-libvips-*`, `@img/sharp-wasm32` | LGPL-3.0-or-later (libvips) | Optional image library pulled in by Next.js, dynamically linked and unmodified. LGPL obligations are met by linking; no PACTORA code is affected.                      |
| `pako`                                      | MIT AND Zlib                | Permissive.                                                                                                                                                            |
| `postal-mime`                               | MIT-0                       | Permissive.                                                                                                                                                            |
| `botid`                                     | none declared (Vercel)      | Optional Vercel BotID client. Off unless `BOTID=1` on a Vercel deployment; never loaded on self-hosted installs. Candidate for replacement by a self-hosted challenge. |

## Specialist components evaluated

| Component                       | Licence    | Decision                                                                                                                                                                                                                                     |
| ------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pdf-lib`                       | MIT        | Already in use: PDF generation, field rendering, the Document Builder's PDF output.                                                                                                                                                          |
| `mozilla/pdf.js` (`pdfjs-dist`) | Apache-2.0 | Already in use: page rendering in the editor and signing page.                                                                                                                                                                               |
| `@signpdf/*`                    | MIT        | Already in use: PAdES signing.                                                                                                                                                                                                               |
| `pyHanko`                       | MIT        | Not adopted. Python; PAdES-B-LTA and LTV are already covered by the Node signing stack (`pdf-ltv.ts`), so a second runtime adds operating cost without a capability gain.                                                                    |
| `LibPDF-js/core`                | MIT        | Not adopted. Overlaps `pdf-lib`, which is stable and already integrated.                                                                                                                                                                     |
| `signature_pad`                 | MIT        | Not adopted. The signing page already has a pointer-event drawing pad with pressure-free smoothing; swapping it would not change the output.                                                                                                 |
| `tiptap`                        | MIT (core) | Not adopted. The Document Builder uses a block model with plain-text paragraphs and light inline marks, which renders deterministically to PDF. A rich-text editor would add roughly 300 kB to the bundle and an HTML-to-PDF layout problem. |

## Competitive references

Licences checked against GitHub on 2026-11-27. Documenso (AGPL-3.0),
DocuSeal (AGPL-3.0), LibreSign (AGPL-3.0) and OpenSign (AGPL-3.0 with
additional terms; GitHub reports NOASSERTION) are copyleft. They were studied
through public documentation and product behaviour only. No code from them is
in PACTORA. `dicroce/signery` (MIT, last push 2026-09-18) is a desktop
signing tool; nothing in it improves the server signing path, so it is not
used.

Proprietary products (DocuSign, PandaDoc, Adobe Acrobat Sign, Dropbox Sign,
SignWell) were studied through their public documentation and published
workflows only. REA was not run against any proprietary software.
