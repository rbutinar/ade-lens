# Architecture — Report Lens

One Power BI report, embedded as a native object, and an agent beside it that sees what the user
sees and can drive the report. A Next.js app (App Router, TypeScript): the page in the browser, a
thin backend-for-frontend (BFF) in the same app.

```
 browser                                 server (Next.js route handlers)              Power BI / model
 ───────                                 ───────────────────────────────              ────────────────
 ReportLens (page)  ── report key ──▶   /api/embed-token  ── OBO ──▶ embed token ──▶  the report
   LensEmbed (powerbi-client)                                                          (RLS as the user)
     OUT: pages, filters, slicers,
          selection, visual data
     IN : setPage, filters, slicers
   assistant panel  ── question +  ──▶  /api/lens/ask ── agent loop ── tools ──────▶  executeQueries
                       where the user is                 (LLM)        read_screen       (DAX, as the user)
                                                                      list/describe/find_fields, run_dax
                    ◀── answer + actions + every call ──              apply_filter / page / open_report
   interaction log  ── events ──────▶   /api/lens/events  ──▶ store (memory | SQL Server)
```

## Principles

1. **Embed, don't rebuild.** The certified report renders where its measures live; the app never
   re-implements a measure. The agent prefers the model's own measures to sums it would write.
2. **The user's identity, end to end.** The browser signs into the app's own API scope; the server
   exchanges it On-Behalf-Of for Power BI; the engine applies the user's RLS to the visuals AND to
   every query the agent runs. The app is never the security boundary ([security.md](security.md)).
3. **The model phrases, it never supplies a number.** What reaches the agent unasked is WHERE the
   user is (report, page, filters, selection, what they just did). Every figure arrives as the
   return value of a tool it chose to call, and every call comes back to the page as the trail.
4. **Actions go through the page.** Filter, change page, open another report: the agent PROPOSES,
   the page APPLIES through the same control object its own tabs use, so the log reads the same
   whoever asked. Data is never changed.
5. **Honest states.** Mock or live, signed in or not, which store recorded the log, which catalogue
   answered: each is said, not implied.

## Where things are

| Concern | Files |
|---|---|
| The page | `app/app/lens/page.tsx`, `components/lens/ReportLens.tsx` |
| The embed, driven from outside | `components/lens/LensEmbed.tsx` (live), `components/lens/MockLensEmbed.tsx` (mock) |
| Contracts between report, page and agent | `lib/lens/contract.ts` |
| The agent loop and its tools | `lib/lens/agent.ts` (live), `lib/lens/mock-agent.ts` (mock planner) |
| The model, as the agent reaches it | `lib/lens/model.ts`, `lib/powerbi/embed.ts` (`executeQueries`) |
| The token road | `lib/powerbi/access.ts`, `lib/auth/entra.ts` (OBO), `lib/auth/browser.ts` (MSAL) |
| Embed-token broker | `app/api/embed-token/route.ts` |
| Report catalogue | `lib/lens/catalog.ts` — file (`content/lens-estate.ts`) or Databricks |
| Store: chats + interaction log | `lib/lens/store.ts`, `lib/lens/store-sqlserver.ts` |
| Excel export (what the user sees) | `lib/lens/excel.ts` |
| The composition point | `lib/lens/plane.ts` (see below) |

## The composition point

Everything a deployment adds AROUND the core — a closed set of reports, its own sign-in, usage
caps, an app identity on public sample data — goes behind one interface, `LensPlane`
(`lib/lens/plane-contract.ts`). The core asks `plane` (`lib/lens/plane.ts`) and nothing else. This
repository ships the self-host plane: the user's identity only, nothing restricted beyond what the
engine enforces, nothing metered, and on the live road a question without a signed-in user is
refused before the model runs.

## Mock first

With nothing configured (`LENS_MOCK=1`, the default) the page, the agent's tools and its actions
run end to end on synthetic reports and a deterministic planner (`content/lens-demo.ts`,
`lib/lens/mock-engine.ts`): no Entra, no Power BI, no model key.
