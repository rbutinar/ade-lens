# ade-lens — ADE (Agentic Data Engineering)

**Report Lens: a Power BI report with an agent beside it.** The agent sees what you see — the
page, the filters, the selection, what the visuals render — answers from the semantic model *as
you*, and can filter the report, change page or open another report when you ask. Every figure it
gives comes from a tool call you can inspect.

> **Open-source core.** This repository is the open core of ade-lens: what works on one report
> and its neighbours, self-hosted in your own tenant. It is an open-source core, with delivery
> around it: the estate-level features (finding the right report among hundreds, certification,
> provenance down to source columns, the catalog integration) are not part of it.

## What it does

- **Embeds** a Power BI report as a native object, as the signed-in user (OBO): Power BI applies
  that user's row-level security to the report and to every query the agent runs.
- **Answers** what is on screen (`read_screen`) and what is in the model (`run_dax`, read-only
  DAX through `executeQueries`), saying which one each figure came from.
- **Acts** on the report when asked: filter a column (through the page's slicer when there is
  one), clear filters, go to a page, open another report on the right page.
- **Exports** what you see to Excel — a page or the whole report, aggregated as the visuals show it.
- **Records** an interaction log, attributed by the server, in memory or SQL Server.

## Quick start (mock, no credentials)

Needs **Node.js 22.18 or later**.

```bash
git clone <this repository>
cd ade-lens
npm ci
npm run dev            # http://localhost:3000/app/lens
npm test               # the token-validation tests
```

With nothing configured, Report Lens runs end to end on synthetic reports and a deterministic
planner: no Entra, no Power BI, no model key. Try *"What am I looking at on this page?"*,
*"Filter the report to Milan Centrale"*, *"Where can I see late orders by store? Open it there."*

`npm ci` may warn that `msnodesqlv8` has install scripts: it is optional, a native Windows driver
used only by the SQL Server store (`LENS_STORE=sqlserver`). Everything else runs without it.

## On your reports

1. **An Entra app registration** with delegated Power BI permissions, an exposed API scope and a
   client secret — step by step in [docs/entra-setup.md](docs/entra-setup.md).
2. **Your reports** in [`content/lens-estate.ts`](content/lens-estate.ts): report id, workspace
   id, and for each page what it covers, in your users' words.
3. **A model key** for the agent (`ANTHROPIC_API_KEY`).
4. `cp .env.example .env.local`, fill it in, set `LENS_MOCK=0` and `NEXT_PUBLIC_LENS_AUTH=1`.
5. Run on the origin you registered as the SPA redirect URI. `npm run dev` uses port 3000; if 3000
   is busy, Next.js moves to 3001 without asking and sign-in then fails on the redirect URI. Free
   the port, or start with `npx next dev -p <your registered port>`.

Optional: a **report catalogue on Databricks** (two Unity Catalog functions, read as the user)
instead of the file, and a **SQL Server store** for chats and the log (`db/sqlserver/`). Both are
in `.env.example`.

## Security

Which rows a user may see is decided by the Power BI engine, bound to the user's identity — never
by report filters, embed filters or `WHERE` clauses over a connection that can see everything. The
agent writes its own queries, so anything weaker is a breach waiting to happen. The rule and the
patterns it allows are in [docs/security.md](docs/security.md). This repository reaches Power BI
as the signed-in user only.

Before exposing a deployment, put it behind your own sign-in (App Service authentication, a
reverse proxy with SSO) or set `LENS_GATE_SECRET` (mandatory on Vercel). On the live road a
question without a signed-in user is refused before the model runs.

## Embedding Report Lens patterns in your own portal

[docs/integration/](docs/integration/README.md) is a stack-neutral kit: the secure embed, the
page ↔ report contract, the interaction log, the Excel export and the report catalogue, level by
level, each with a *done when* checklist.

## Architecture

[docs/architecture.md](docs/architecture.md): the page, the BFF, the agent loop, the token road,
and the one composition point (`lib/lens/plane.ts`) where a deployment adds what it needs around
the core without touching it.

## License

[Apache-2.0](LICENSE).
