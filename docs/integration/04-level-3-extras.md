# 04 · Level 3 — extras: Excel export, and a catalogue that opens the right page

Two independent features built on levels 0–2. Take either, both, or neither.

- **A. Export to Excel**: a page, or the whole report, in **one workbook** — an index sheet and one
  sheet per page, each visual a real Excel table. Power BI's own export works one visual at a time.
- **B. Report catalogue**: "where do I see X?" → **the report and the page** that cover it, opened
  directly on that page.

Then **C**: what level 4 (an assistant) would add, and why levels 1–3 are its foundation.

---

## A. Export to Excel

### A1. Scope: what the viewer sees, aggregated

The export contains exactly what the visuals show, **as they show it** (summarised), under the
filters in force, under the viewer's own identity — the same rows RLS already allowed on screen.
No detail rows, no unfiltered data, no second query. It is built **in the browser** from the embed,
so it can never contain anything the viewer could not see. (Scope decided in ade-lens 2026-10-11;
everything below VERIFIED live the same night unless marked.)

Prerequisite outside your code — DESCRIBED: `exportData` obeys the report's and the tenant's
export settings. If export of data is disabled there, every visual refuses and the file says so.

### A2. Collecting the data

For each data visual of a page (decoration skipped, slicers read as filters — level 1 §3):

```ts
const res = await visual.exportData(models.ExportDataType.Summarized, 30000);  // CSV in res.data
```

What we measured:

| Fact | Consequence |
|---|---|
| **`exportData` refuses every visual of a page that is not active** | to export other pages you must make them active somewhere (below) |
| 30,000 rows per visual accepted (a 240-row table came back whole) | ask for 30,000; if refused, retry with 1,000 **and write that in the file** |
| A whole 4-page / 26-visual report exported in ~7 s | fine for a button; show progress anyway |
| Reading straight after setting a slicer read the **previous, unfiltered** figures while the file claimed the filter | wait for the `rendered` that follows the change — subscribe **before** setting it, so a fast redraw is not missed; if it never comes (15 s), say so in the file |

**Other pages — use an invisible second embed.** Moving the viewer's own report through its pages
works, but they watch pages flash by and it fires level-2 `view` events that are not the viewer
looking. Instead:

1. Embed the **same report with the same token** into an offscreen container that still has a real
   size (`position:fixed; left:-20000px; width:1600px; height:900px; pointer-events:none`, `aria-hidden`).
   Power BI does not draw into a hidden (`display:none`) element.
2. Copy the report-level filters onto it (`updateFilters(ReplaceAll, report.getFilters())`), and any
   filter your page applied through a slicer (level 1 §6).
3. For each page: `setActive()`, wait for `rendered`, apply the slicer filter if any and wait for the
   redraw, then export its visuals.
4. Dispose it (`service.reset`, remove the element) — always, in a `finally`.
5. If the copy cannot be made or cannot read a page, fall back to showing that page in the viewer's
   report, then return to where they were — and **note which road each page took**.

Known gap, said in the file: a slicer the viewer set **by hand** on a page other than the current
one is not carried into the copy (read each page's slicer state before leaving it, if it matters).

Pause your level-2 diffing while an export moves through pages — what the report shows then is not
the viewer looking.

### A3. Writing the workbook

ade-lens uses `exceljs` in the browser; any library that writes real tables will do.

| Sheet | Contents |
|---|---|
| **Index** | report name, scope (this page / every page), when, **as whom** (from the server, level 2), report filters in force; one row per page with its filters, number of visuals, number not exported, and a **link to its sheet**; the list of visuals that could **not** be exported, with why; "how this file was made" (the roads of A2, retries, anything dropped) |
| **one per page** | title and the filters on that page; for each visual: its title, type, "N rows, as the visual shows them" — or "the export stopped at its limit: there may be more" — then the visual as an Excel **table** (filter buttons, stripes) |

Rules, each one a defect we would otherwise ship:

- **Write numbers as numbers.** Values arrive formatted (`"€40,514"`, `"12.5%"`, `"+2.7%"`,
  `"1,112,670"`); parse them back and set an Excel number format (`€#,##0`, `0.0%`, `#,##0`). A text
  `"€40,514"` neither sums nor sorts. Anything that does not parse stays text.
- **A missing visual is named, never silent** — in the Index, with the reason. A visual missing from
  the file must not read as a visual that was empty.
- **Drop conditional-colour helper columns** (a column whose every value is a hex colour such as
  `#0F9D8A`) and list them as dropped. Name an untitled column of pictures "Image"; picture cells
  become `"[image]"`.
- **Excel's naming rules**: sheet names ≤ 31 chars, none of `[]:*?/\`, unique (case-insensitive);
  table names letters/digits/underscore, starting with a letter, unique; table headers unique and
  non-empty. A table needs at least one row — give an empty visual a single empty row.
- **File name** in the viewer's local time: `Report - Page - 20261012-1430.xlsx`, unsafe characters
  replaced.
- Log it: a level-2 `export` event (scope, report, pages, visuals exported / not exported). An export
  is data leaving the screen — it belongs in the record.

### A4. Done when

- [ ] "This page" and "whole report" each produce one workbook; the Index links to every page sheet.
- [ ] Under a filter, **every** sheet's figures match the filtered screen (check one total against
      the source) — including pages that were not on screen.
- [ ] Money and percentages sum and sort in Excel.
- [ ] A visual that cannot export appears in the Index with its reason.
- [ ] The viewer's report did not visibly move (or, on the fallback road, the file says it did).
- [ ] The export is in the level-2 log.

---

## B. Report catalogue → the report AND the page

### B1. Why

Portals with more than a handful of reports lose people between them: the answer exists, on page 4
of a report nobody remembers. A small catalogue — maintained with the reports — turns "where do I see
stock by warehouse?" into *Operations report → page "Stock by Warehouse"*, opened right there.
Without an assistant this powers a search box or a "related pages" panel; with one (level 4) it is a
tool.

### B2. The shape

Two tables, kept by whoever maintains the reports:

```sql
report_catalog (report_key, name, module, description, nr_pages, env)
report_page    (report_key, page_name, page_title, covers)   -- covers: plain words, what the page answers
```

Two read functions over them (ade-lens: SQL functions in Databricks Unity Catalog, called through
the Statement Execution API — VERIFIED 2026-10-11; any database works):

- `list_reports(module)` → reports with what they cover;
- `find_report_page(term)` → the pages whose `covers` / title / report name match the term.

### B3. Rules

- **The catalogue names your report keys (level 0), not Power BI ids.** Opening a hit still goes
  through the broker, which still decides whether this viewer may open that report. The catalogue
  is a map, not a permission.
- **Store the page title next to its id, and resolve at open time** (level 1 §5: id *or* title).
  Page ids can change when a report is rebuilt — on our estate they did, until the reports' build
  started deriving ids from report + page name. A stale id resolved by title still lands right.
- **Open on the page directly** — `pageName` at embed time (level 0 §4), no landing-page flash.
- **Search tolerantly**: a function that matches the term as one phrase misses "inventory stock
  levels by warehouse". On no hit, ade-lens retries per word (simple plural stripped) and ranks pages
  by words matched.
- **Mind cold starts**: a serverless SQL warehouse woke slower than a 20 s inline wait — the call came
  back PENDING. Poll the statement until it finishes (bounded), and never fall back **silently**: if
  the catalogue is unreachable, say so, or serve a file copy that says it is one.
- Read the catalogue **as the viewer** where your platform allows it (DESCRIBED for Entra OBO →
  Azure Databricks; on a non-Azure Databricks workspace only a service token works, for development only). If it runs
  on a service identity, keep it to metadata — never let it reach report data.

### B4. Done when

- [ ] A search for a topic returns report + page; choosing it opens that report **on that page**.
- [ ] A hit on a report the viewer may not open is refused by the broker, not by hiding the link only.
- [ ] Renaming nothing but rebuilding a report (new page ids) does not break the links.
- [ ] With the catalogue down, the page says so.

---

## C. Level 4, for orientation — out of scope here

An assistant beside the report needs nothing new from the report side. It **reads** the level-1
state (page, filters, slicers, selection, rows on screen, what was not read), **acts** only through
the level-1 control object, **finds** reports through B, **exports** through A, and every step it
takes lands in the level-2 log with `actor: agent`. What it adds on top is its own: a model, tools,
queries against the semantic model **as the viewer** (`executeQueries` under the same identity, so
the same RLS — on app-owns-data with the effective identity on the query too), and gates so it acts
only when asked.

That is why the earlier levels are strict about labels, three-valued filters, named gaps and server
attribution: an assistant believes the contract literally. A cap that looks like the data, or a
filter it cannot see, becomes a confident wrong answer.
