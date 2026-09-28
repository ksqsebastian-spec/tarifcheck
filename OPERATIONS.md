# Tarifcheck operations (September 2026)

Live app: https://tarifcheck.ksqsebastian.workers.dev

## Update ownership

The ChatGPT cloud task **Tarifcheck – Tarife prüfen und aktualisieren** owns the monthly schedule: the first of each month at 09:00 Europe/Berlin. The Cloudflare Workflow `tarifcheck-update` is only an on-demand executor. The authenticated “Jetzt prüfen” action starts the same executor.

The task checks official publishers and verifies document identity before correcting existing source URLs. It invokes a workflow instance with a unique date-based ID and reads its final result. A successful create response does not mean the download succeeded. Run history is available at `/api/laeufe`; `/api/gesundheit` checks the oldest active source inspection. Keep the cloud-compatible ChatGPT app **Cloudflare Tarifcheck** connected. Its official MCP endpoint is `https://mcp.cloudflare.com/mcp`; the similarly named desktop plugin does not supply tools to ChatGPT cloud tasks. The user approved D1 read/write and Workers Scripts read/write plus required identity/background scopes. These OAuth permissions are broader than Tarifcheck; the task instructions restrict usage but do not enforce resource isolation. If access is unavailable, the task must report the failure rather than claim success, and leave the next monthly check active.

Workflow steps retry individual sources and preserve previous versions. Each source has a short database lock. Redirects are checked against the approved HTTPS publisher list; downloaded PDFs must have a PDF signature. Identical source failures are not repeatedly added as new notifications, and recovered fetch errors are marked read.

## Source limitations

The archive currently monitors 17 sources: 14 PDF sources and three webpages. A reachable URL or unchanged file does not establish legal applicability or prove the publisher has no newer document at another URL. Membership-only tariff documents require an authorized manual PDF upload. The interface labels these distinctions explicitly.

## Accounts and security

Named accounts are stored in `benutzer` using the existing salted PBKDF2 format. Passwords are never committed. Susan Khallaf has a named account; existing shared login remains supported. Login attempts are rate limited by a Durable Object, sessions use signed secure cookies, and cross-origin API writes are rejected. Publisher URL changes are restricted to approved HTTPS hosts. Manual uploads cannot replace automated sources. Uploaded original PDFs require a session for download.

The original application publishes its document catalogue and extracted text through its read API. It is a shared tariff reference, not a confidential document vault. Only upload tariff documents appropriate for that model. MCP access continues to use OAuth with read-only tariff scope.

## Deployment

GitHub Actions `Deploy` applies D1 migrations and publishes using the existing repository secret. It can be dispatched against an explicit branch. Never put Cloudflare API tokens, session keys or user passwords in source, task prompts or issue bodies.

Before deployment: `npm ci`, `npm run typecheck`, `npm test`, `npx wrangler deploy --dry-run`. Afterwards verify health, a completed workflow, named login and an archived PDF download. Changes in `wrangler.jsonc` must reflect the active scheduling arrangement.

## Visual references

Original geometric folded-T logo with a white workspace, neutral typography and compact status panels. Logo studies are in `brand/`; the folded-T direction is applied. References: [Mobbin](https://mobbin.com/), [DocuWare brand material](https://start.docuware.com/de/bildmaterial), and the compact [Coda wordmark reference](https://mobbin.com/sites/sections/5267d6c6-eeca-4050-bbae-119af1bb9106). The marks are original, not copied brand assets. Motion respects reduced-motion preferences. No third-party tracking or remote font dependency was added.
