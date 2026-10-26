# 02 · Level 1 — the page and the report talk

**Goal:** your page always knows **what the report is showing** — which page, which filters, which
slicer selections, which data point the viewer clicked, what the visuals render — and can **drive
the report in place** (change page, apply or clear a filter) without reloading it and without
destroying what the report's author set up.

Prerequisite: level 0. Everything here goes through the `report` object the embed returned.

```
              ┌──────────── STATE OUT ────────────┐
   report  ── │ page · filters · slicers ·         │ ──►  your page (breadcrumb, side panel,
 (powerbi-    │ selection · rows on screen         │       log of level 2, an assistant later)
  client)     └────────────────────────────────────┘
          ◄── ┌──────────── CONTROL IN ───────────┐ ◄──  your page (own tabs, deep links,
              │ one plain object: page, filter, by │       portal navigation)
              └────────────────────────────────────┘
```

Why it matters beyond the screen: level 2 logs **changes of this state**, and an assistant (level 4)
reads exactly this state and acts through exactly this control object. Get the contract right once.

---

## 1. State OUT — the shape

One plain object, owned by your page. This is the contract ade-lens uses (VERIFIED live 2026-10-11):

```ts
interface ReportState {
  activePage?: string;                               // display title of the page on screen
  pages?: { name: string; displayName: string }[];   // name = Power BI section id; hidden pages out
  filters?: string[];        // human-readable: report filters, page filters, slicer selections
  selection?: string[];      // e.g. "product = Tokyo Tidbits"
  visibleData?: { title?: string; columns: string[]; rows: (string | number | null)[][] }[];
  unreadVisuals?: string[];  // data visuals that gave no rows — NAMED, with why
  status?: "loading" | "ready" | "failed";           // set by the page (level 0 §6)
}
```

Strings, not Power BI objects: the state is for people, logs and (later) a model. Keep the raw
filter objects separately if your page needs to re-apply them.

## 2. State OUT — how to read it

| Field | Read with | Notes |
|---|---|---|
| `pages`, `activePage` | `report.getPages()` → `isActive`, `name`, `displayName`, `visibility` | `visibility === 1` is a hidden page: leave it out |
| report filters | `report.getFilters()` | |
| page filters | `activePage.getFilters()` | label them as **the author's** — the viewer did not set them |
| slicer selections | for each slicer visual: `visual.getSlicerState()` → `filters` | a slicer is a filter the viewer **sees**; one that cannot be read is *unknown*, not *empty* |
| `selection` | the `dataSelected` event → `detail.dataPoints[].identity[]` (`target.column`, `equals`) | an event, not a read |
| `visibleData` | `visual.exportData(models.ExportDataType.Summarized, maxRows)` → CSV text | see §3 |

**When to read:** on `loaded`, `rendered`, `pageChanged`, `filtersApplied`. `rendered` fires on
**every repaint**, so read freely but publish only what *changed* (level 2 depends on it). A read that
throws during a repaint is transient — ignore it, the next `rendered` re-reads.

Turning a filter object into a label (VERIFIED):

```ts
function describeFilter(f: any): string {
  const t = f?.target;
  const col = t?.column ?? t?.hierarchy ?? t?.measure ?? "field";
  const target = t?.table ? `${t.table}[${col}]` : String(col);
  if (f?.values?.length) return `${target} ${f.operator ?? "In"} ${f.values.join(", ")}`;
  if (f?.conditions?.length) return `${target} ${f.conditions.map((c: any) => `${c.operator} ${c.value}`).join(" & ")}`;
  return `${target} filtered`;
}
```

## 3. Reading what the visuals render

`page.getVisuals()` lists the visuals of the active page. Then, VERIFIED on our estate:

- **Skip decoration**: types `image`, `actionButton`, `shape`, `basicShape`, `textbox`,
  `pageNavigator`, `bookmarkNavigator` carry no data. Reporting them as "exported nothing" is noise.
- **Skip hidden visuals**: `layout.displayState.mode === 1`.
- **Reading order**: sort by `layout.y`, then `layout.x` — top-to-bottom, left-to-right, as a person
  reads the page.
- **Bound it**: ade-lens reads at most 10 data visuals × 100 rows. Anything not read goes into
  `unreadVisuals` **by name and with the reason** ("not read: ten visuals already read").
- **Parse the CSV properly** (quoted fields, doubled quotes); numbers as numbers, empty as null; a
  cell holding a picture (`data:image/…`) becomes `"[image]"`, any very long cell is cut **and says
  so**.
- `exportData` only works on the **active** page (MEASURED 2026-10-11: every visual of a non-active
  page refuses). For other pages see level 3.

DESCRIBED, not seen on our estate: some visual types (cards, gauges, some custom visuals) export
nothing on real reports — in one real report about 3 of 8. Name them in `unreadVisuals`; never
let "nothing came back" read as "nothing is there". Export also depends on the report's and the
tenant's export settings.

---

## 4. Control IN — the shape

One plain object your page sets; one function applies it. Whoever asks — your own page tabs, a deep
link, portal navigation, later an assistant — goes through the same object (VERIFIED):

```ts
interface ReportControl {
  page?: string;     // a section id OR a display title — resolved against the report's pages
  filter?: { table: string; column: string; values: string[] } | null;
                     // undefined = leave filters alone · null = back to the author's · value = apply
  by?: "user" | "system" | "agent";   // who asked — level 2 logs it
  seq?: number;      // bump on every request, so asking for the same page twice is still a request
}
```

The three-valued `filter` is the most important line on this page. **`undefined` and `null` are
different**: a page-tab click sends `{ page }` with no `filter`, and must not touch filters. Reading
"no filter given" as "remove all filters" made a page-tab click wipe the author's own filter — a
defect paid for before ade-lens.

## 5. Control IN — applying it

```ts
// At "loaded": remember the AUTHOR's filters once. They are what "reset" means.
author = (await report.getFilters()) ?? [];

async function apply(report, c: ReportControl) {
  if (c.page) {
    const pages = await report.getPages();
    const hit = pages.find(p => p.name.toLowerCase() === c.page!.toLowerCase())
             ?? pages.find(p => p.displayName.toLowerCase() === c.page!.toLowerCase());
    if (!hit) log("page not found in this report", c.page, "error");
    else { await report.setPage(hit.name); log("setPage accepted — no reload", hit.displayName); }
  }

  if (c.filter !== undefined) {
    const same = (f: any) => f?.target?.table === c.filter?.table && f?.target?.column === c.filter?.column;
    if (c.filter?.values.length) {
      const f = { $schema: "http://powerbi.com/product/schema#basic",
                  target: { table: c.filter.table, column: c.filter.column },
                  operator: "In", values: c.filter.values, filterType: models.FilterType.Basic };
      if (await setThroughSlicer(report, f)) {                 // §6
        await report.updateFilters(models.FiltersOperations.ReplaceAll, author.filter(x => !same(x)));
      } else {
        // the author's, minus any on this field, plus ours — repeated calls cannot pile up
        await report.updateFilters(models.FiltersOperations.ReplaceAll, [...author.filter(x => !same(x)), f]);
      }
    } else {                                                    // null → back to the author's
      await clearSlicers(report);
      await report.updateFilters(
        author.length ? models.FiltersOperations.ReplaceAll : models.FiltersOperations.RemoveAll,
        author.length ? author : undefined);
    }
  }
}
```

Rules, all VERIFIED in ade-lens:

- **Log every step with whether the API accepted it** ("setPage accepted", "updateFilters refused:
  …"). What was *asked* and what *happened* are two facts; level 2 needs both.
- **A control set before the report exists** (opening a report on a page, a filter requested while
  loading) is applied at `loaded`. An effect that only reruns on *change* would otherwise drop it.
- **Apply a control once**: remember the last one applied (e.g. its JSON) and skip an identical one;
  `seq` makes a deliberate repeat different.
- **Opening on a page**: if you already know the section id, pass it as `pageName` at embed time
  (level 0 §4) instead of `setPage` after load — no flash of the landing page.

## 6. Slicers: apply through them, visibly

On a designed page with a slicer on the same field, a filter applied with `updateFilters` changes
the numbers while the slicer still shows "All" — the viewer sees data change under an unlit button
and stops trusting the page. ade-lens (VERIFIED 2026-10-11 on canvas reports):

- applies the filter **through the slicer** (`visual.setSlicerState({ filters: [f] })`) when a slicer
  of the active page targets the same table/column (`getSlicerState().targets`), and drops any
  report-level filter of its own on that field so the two do not intersect;
- on `pageChanged`, sets the same-field slicer on the new page too, so the filter **survives a page
  change** and stays visible;
- on reset (`filter: null`), clears the page's slicers as well as restoring the author's filters.

---

## 7. Known pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Clicking a page tab removes the author's filter | "no filter" read as "remove all" | three-valued `filter` (§4) |
| Filters pile up after a few clicks | `Add` / `Merge` instead of one `ReplaceAll` | author's − same field + ours (§5) |
| A filter applied, the slicer still says "All" | filter set beside the slicer | through the slicer (§6) |
| A filter vanishes when the viewer changes page | it lived on the old page's slicer | mirror on `pageChanged` (§6) |
| "Showing 10 months" on a 21-month chart | a read cap taken for the data | always carry the true count; name what was not read |
| "Nothing on this page" while cards are visible | visuals that export nothing taken as empty | `unreadVisuals`, by name (§3) |
| Log flooded with identical entries | state published on every `rendered` | publish changes only |
| A requested page or filter never applied | control set before `loaded` | apply at `loaded` (§5) |

---

## Done when

- [ ] Your page shows (or logs) the active page, filters with the author's labelled as such, slicer
      selections, and the clicked data point — and they update when the viewer clicks in the report.
- [ ] A page tab of yours changes page **without** touching any filter, the author's included.
- [ ] Applying a filter twice leaves exactly one filter on that field; reset brings back exactly the
      author's filters.
- [ ] On a page with a slicer on that field, the slicer shows the filter — and keeps showing it after
      a page change.
- [ ] Opening a report straight on a page shows that page first, with no landing-page flash.
- [ ] Every control attempt produces an "accepted" or "refused: why" line.
- [ ] A visual that exports nothing is named, not silently missing.

Next: [level 2 — observability](03-level-2-interaction-log.md).
