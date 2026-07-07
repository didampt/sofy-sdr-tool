# AGENTS

## Workflow

- Au début de chaque session, faire un `git pull` pour récupérer le HEAD.
- Demander la validation et la mise en production de chaque feature. Lorsque la validation est donnée, effectuer un ou plusieurs commits avec un récapitulatif de la feature/fix/etc.
- Push les commits pour mettre en production (le déploiement Vercel est déclenché par le push).

## Purpose

Internal Sofy SDR tool for building prospecting lists, enriching leads, scoring opportunities, and actioning them through Ringover, Lemlist, HubSpot, Slack, and SMS.

## Architecture

- Deployment is Vercel serverless.
- Frontend is primarily a single static app in `public/index.html`.
- Backend is a flat set of Vercel functions in `api/*.js`.
- Persistence is Neon Postgres through `api/db.js`.
- Core business data is stored as JSON in `listes.entreprises`.

## Key Files

- `public/index.html`: main UI, client state, navigation, API calls.
- `api/db.js`: DB connection, schema bootstrap, auth token signing, shared helpers, limits, locks, SMS sending.
- `api/listes.js`: list persistence, history, archive, stats, visibility rules.
- `api/liste.js`: Pappers-based list generation.
- `api/ia-liste.js` and `api/ia-liste-creer.js`: AI/Basile smart-list flow.

## Operating Model

- This repo has no framework app structure, no test suite, and almost no tooling.
- Many changes require touching both `public/index.html` and one or more `api/*.js` handlers.
- DB schema changes must be implemented compatibly inside `ensureSchema()` in `api/db.js`.
- Role checks (`sdr`, `admin`, `superadmin`) are part of application behavior and must be preserved.
- Cost control is part of the product: deduplication, monthly limits, and consumption logging are intentional.
- Background jobs run via Vercel cron from `vercel.json`.

## Editing Rules

- Prefer small, compatible edits.
- For user-facing French copy, keep correct accents and French typography in labels, messages, and marketing text.
- Treat `listes.entreprises` as the source of truth for lead state; preserve its shape unless a migration is deliberate.
- Preserve auth, role visibility, and lock behavior unless the task explicitly changes them.
- Be careful with duplicated frontend assets: `public/index.html` is the main entrypoint; `api/index.html` also exists and may drift.
- Never expose provider secrets client-side; external integrations should stay server-side in `api/*.js`.
