"use client";

/**
 * The report as a native `powerbi-client` object, driven from outside.
 *
 *   OUT — getPages / getFilters / exportData and the pageChanged / filtersApplied / dataSelected
 *         events: what lets the agent see what the user is looking at.
 *   IN  — setPage / updateFilters: the page's tabs and the agent driving the report IN PLACE.
 *
 * Defects kept fixed here:
 *  #1 the AUTHOR's filters are kept — only a filter on the same field is replaced;
 *  #2 `filter === undefined` leaves filters alone; only `null` resets to the author's;
 *  #3 the embed is TORN DOWN on unmount (`svc.reset`) and each mount builds its own Service, so a
 *     second report embeds into the same pane instead of "already has embedded component".
 *
 * Canvas reports (built with slicers and decoration) add what simpler reports never had, all read and driven here:
 *  - SLICERS on the page: their state is a filter the user sees, so it is read into `filters`, and
 *    a filter on a field a slicer of the active page targets is applied THROUGH that slicer — the
 *    audience watches the button light up instead of data changing under an unlit one;
 *  - PAGE-level filters set by the author (a page scoped to one warehouse) — read, labelled;
 *  - decoration (a full-page background image, nav buttons, shapes) — skipped, never "a visual
 *    that exported nothing"; a data visual that exports nothing is NAMED to the agent.
 * The ade-lens broker hands out an EMBED token (OBO, server-side), so tokenType is Embed.
 */
import { useEffect, useRef, useState } from "react";
import {
  resolvePage,
  type ExportBundle,
  type ExportPage,
  type ExportScope,
  type LensEvent,
  type LensExporter,
  type LensState,
  type ReportControl,
} from "@/lib/lens/contract";
import type { VisibleVisual } from "@/lib/page-context";

interface Props {
  embed: { token: string; embedUrl: string; reportId: string };
  control: ReportControl;
  onState: (s: LensState | null) => void;
  onEvent: (e: Omit<LensEvent, "id" | "ts">) => void;
  /** Handed an exporter once the report has loaded, null when it goes. */
  onExporter?: (x: LensExporter | null) => void;
}

export function LensEmbed({ embed, control, onState, onEvent, onExporter }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const report = useRef<any>(null);
  const author = useRef<any[] | null>(null);
  const latest = useRef(control);
  latest.current = control;
  const applied = useRef("");
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const el = host.current;
    if (!el) return;
    let svc: any = null;
    setFailed(null);

    (async () => {
      const pbi = await import("powerbi-client");
      if (disposed) return;
      svc = new pbi.service.Service(pbi.factories.hpmFactory, pbi.factories.wpmpFactory, pbi.factories.routerFactory);
      const r: any = svc.embed(el, {
        type: "report",
        id: embed.reportId,
        embedUrl: embed.embedUrl,
        accessToken: embed.token,
        // Open straight on the requested page when the control names a section id (a report the
        // agent opened from the catalogue), so the landing page never flashes and logs a view.
        ...(latest.current.page && /^(ReportSection\w*|[0-9a-f]{20})$/.test(latest.current.page)
          ? { pageName: latest.current.page }
          : {}),
        tokenType: pbi.models.TokenType.Embed,
        settings: {
          background: pbi.models.BackgroundType.Transparent,
          // A designed page has a fixed 16:9 canvas: fit it to the width instead of letterboxing it
          // with bands above and below in a taller pane.
          layoutType: pbi.models.LayoutType.Custom,
          customLayout: { displayOption: pbi.models.DisplayOption.FitToWidth },
          // Power BI's own panes hidden: the page's tabs and the agent are the controls, and a
          // visible filter pane would make it impossible to tell which one drove a change.
          panes: { filters: { visible: false }, pageNavigation: { visible: false } },
        },
      } as any);
      report.current = r;
      // While an export moves through pages, what it shows is not the user looking: no state, no
      // "Viewing page" events, no slicer mirroring.
      const busy = { exporting: false };
      const sync = () => {
        if (!busy.exporting) void publish(r, onState);
      };

      r.on("loaded", async () => {
        onEvent({ actor: "system", kind: "load", label: "Report loaded" });
        // No theme of ours over the report's: designed canvas reports carry their own theme, and
        // ours turned their navigation buttons into blank white boxes (seen live 2026-10-11).
        try {
          author.current = (await r.getFilters()) ?? [];
        } catch {
          author.current = [];
        }
        // A control set BEFORE the report existed (the page a report was opened on, a filter asked
        // for while loading) would otherwise never be applied: the effect only reruns on change.
        applied.current = JSON.stringify(latest.current);
        if (latest.current.page || latest.current.filter !== undefined) {
          await apply(r, latest.current, onEvent, author.current ?? []);
        }
        sync();
        onExporter?.({
          collect: async (scope) => {
            busy.exporting = true;
            try {
              return await collect(r, scope, () => hiddenEmbed(pbi, embed), latest.current.filter);
            } finally {
              busy.exporting = false;
              sync();
            }
          },
        });
      });
      r.on("rendered", sync);
      r.on("pageChanged", async () => {
        // A filter the agent applied through a slicer lives on THAT page's slicer: carry it to the
        // slicer on the same field of the page the user moved to, so it survives a page change
        // (v1 defect #2) and stays visible.
        if (busy.exporting) return;
        const f = latest.current.filter;
        if (f?.values.length) await mirrorSlicers(r, f, onEvent, latest.current.by ?? "user");
        sync();
      });
      r.on("filtersApplied", sync);
      r.on("dataSelected", (event: any) => {
        const points: any[] = event?.detail?.dataPoints ?? [];
        const selection = points
          .flatMap((p) => (p.identity ?? []).map((id: any) => `${id.target?.column ?? id.target?.hierarchy ?? "value"} = ${id.equals}`))
          .filter(Boolean);
        onState({ selection });
      });
      r.on("error", (event: any) => {
        const d = event?.detail ?? {};
        setFailed(`${d.message ?? "embed error"}${d.detailedMessage ? ` — ${d.detailedMessage}` : ""}`);
        onEvent({ actor: "system", kind: "error", label: "Embed error", detail: JSON.stringify(d).slice(0, 300) });
      });
    })().catch((e) => setFailed(String(e)));

    return () => {
      disposed = true;
      onExporter?.(null);
      report.current = null;
      author.current = null;
      try {
        svc?.reset(el);
      } catch {
        /* already gone */
      }
      el.innerHTML = "";
      onState(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embed.reportId, embed.embedUrl, embed.token]);

  useEffect(() => {
    const r = report.current;
    const key = JSON.stringify(control);
    if (!r || author.current === null || key === applied.current) return;
    applied.current = key;
    void apply(r, control, onEvent, author.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control]);

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" />
      {failed && (
        <div className="absolute inset-x-4 top-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <p className="font-medium">This report did not render.</p>
          <p className="mt-1 text-xs">{failed}</p>
          <p className="mt-1 text-xs text-rose-700">
            Access is granted at Power BI, not here: the viewer needs a licence in the tenant and access to the workspace.
          </p>
        </div>
      )}
    </div>
  );
}

/** Drive the report from outside. Each step logged with whether the API accepted it. */
async function apply(r: any, control: ReportControl, onEvent: Props["onEvent"], author: any[]) {
  const log = (label: string, detail?: string, kind: "control" | "error" = "control") =>
    onEvent({ actor: control.by ?? "user", kind, label, detail });

  if (control.page) {
    try {
      const pages: any[] = await r.getPages();
      const hit = resolvePage(pages.map((p) => ({ name: p.name, displayName: p.displayName })), control.page);
      if (!hit) log("page not found in this report", control.page, "error");
      else {
        await r.setPage(hit.name);
        log("setPage accepted — no reload", hit.displayName);
      }
    } catch (e) {
      log("setPage refused", String(e), "error");
    }
  }

  if (control.filter !== undefined) {
    try {
      const pbi = await import("powerbi-client");
      const same = (f: any) => f?.target?.table === control.filter?.table && f?.target?.column === control.filter?.column;
      if (control.filter?.values.length) {
        const f = {
          $schema: "http://powerbi.com/product/schema#basic",
          target: { table: control.filter.table, column: control.filter.column },
          operator: "In",
          values: control.filter.values,
          filterType: pbi.models.FilterType.Basic,
        };
        const label = `${control.filter.table}[${control.filter.column}] In ${control.filter.values.join(", ")}`;
        // A slicer on this field on the active page: apply it THERE, visibly. Any report-level
        // filter of ours on the same field goes, or the two would intersect.
        const viaSlicer = await mirrorSlicers(r, control.filter, onEvent, control.by ?? "user");
        if (viaSlicer) {
          await r.updateFilters(pbi.models.FiltersOperations.ReplaceAll, author.filter((x) => !same(x)));
          log("setSlicerState accepted", `${label} · on the page's slicer “${viaSlicer}”`);
        } else {
          // One ReplaceAll of "the author's, minus any on this field, plus ours": repeated calls
          // cannot accumulate, and the author's filters survive.
          await r.updateFilters(pbi.models.FiltersOperations.ReplaceAll, [...author.filter((x) => !same(x)), f]);
          log("updateFilters accepted", `${label}${author.length ? " · author's filters kept" : ""}`);
        }
      } else {
        const cleared = await clearSlicers(r);
        if (author.length) {
          await r.updateFilters(pbi.models.FiltersOperations.ReplaceAll, author);
          log("filters reset to the author's", cleared.length ? `slicers cleared: ${cleared.join(", ")}` : undefined);
        } else {
          await r.updateFilters(pbi.models.FiltersOperations.RemoveAll);
          log("filters removed", cleared.length ? `slicers cleared: ${cleared.join(", ")}` : undefined);
        }
      }
    } catch (e) {
      log("filter call refused", String(e), "error");
    }
  }
}

async function publish(r: any, onState: (s: LensState) => void) {
  try {
    const pages: any[] = await r.getPages();
    const active = pages.find((p) => p.isActive) ?? pages[0];
    const filters: any[] = (await r.getFilters()) ?? [];
    const pageFilters: any[] = (await active?.getFilters?.().catch(() => [])) ?? [];
    const screen = await readVisuals(active);
    onState({
      activePage: active?.displayName,
      pages: pages.filter((p) => p.visibility !== 1).map((p) => ({ name: p.name, displayName: p.displayName })),
      filters: [
        ...filters.map(describeFilter),
        ...pageFilters.map((f) => `${describeFilter(f)} (page filter, set by the report's author)`),
        ...screen.slicers,
      ].filter(Boolean),
      visibleData: screen.data.length ? screen.data : undefined,
      unreadVisuals: screen.unread.length ? screen.unread : undefined,
    });
  } catch {
    /* transient during a repaint — the next `rendered` re-reads */
  }
}

/** Visual types that draw, navigate or decorate — nothing in them is data. */
const DECOR = new Set(["image", "actionButton", "shape", "basicShape", "textbox", "pageNavigator", "bookmarkNavigator"]);
const SLICERS = new Set(["slicer", "advancedSlicerVisual"]);

/** The active page's visuals in reading order (top-to-bottom, left-to-right), hidden ones out. */
async function pageVisuals(page: any): Promise<any[]> {
  if (!page?.getVisuals) return [];
  const all: any[] = await page.getVisuals();
  return all
    .filter((v) => v.layout?.displayState?.mode !== 1)
    .sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0));
}

/**
 * What the page shows, as the agent can know it:
 *  - data: what each data visual renders, via exportData — up to 10 visuals, 100 rows each. The agent
 *    is handed at most 20 rows per visual by read_screen, WITH the true count: exporting only 10 made
 *    a 21-month chart read as "10 months, Jan–Oct" (measured live 2026-10-11) — a cap must never look
 *    like the data. Ten, not six: a canvas page leads with four KPI cards, and six left its table out;
 *  - slicers: each slicer's selection, as a filter line;
 *  - unread: data visuals that exported nothing — named, so "nothing came back" is never read as
 *    "nothing is there".
 */
async function readVisuals(page: any): Promise<{ data: VisibleVisual[]; slicers: string[]; unread: string[] }> {
  const data: VisibleVisual[] = [];
  const slicers: string[] = [];
  const unread: string[] = [];
  let visuals: any[] = [];
  try {
    visuals = await pageVisuals(page);
  } catch {
    return { data, slicers, unread };
  }
  for (const v of visuals) {
    if (DECOR.has(v.type)) continue;
    const name = v.title || v.type;
    if (SLICERS.has(v.type)) {
      try {
        const st = await v.getSlicerState();
        for (const f of st?.filters ?? []) slicers.push(`${describeFilter(f)} (slicer “${name}” on the page)`);
      } catch {
        // A slicer the API cannot read: its state is unknown, not empty.
        unread.push(`“${name}” (slicer) — its selection could not be read`);
      }
      continue;
    }
    if (data.length >= 10) {
      unread.push(`“${name}” (${v.type}) — not read: ten visuals already read on this page`);
      continue;
    }
    try {
      const res = await v.exportData(0 /* Summarized */, 100);
      const parsed = parseCsv(String(res?.data ?? ""));
      if (parsed.columns.length) data.push({ title: v.title, columns: parsed.columns, rows: parsed.rows });
      else unread.push(`“${name}” (${v.type}) — exported no rows`);
    } catch (e) {
      unread.push(`“${name}” (${v.type}) — exports nothing (${String((e as { message?: string })?.message ?? e).slice(0, 80)})`);
    }
  }
  return { data, slicers, unread };
}

/** A basic In filter, the shape both updateFilters and setSlicerState take. */
async function basicFilter(filter: NonNullable<ReportControl["filter"]>) {
  const pbi = await import("powerbi-client");
  return {
    $schema: "http://powerbi.com/product/schema#basic",
    target: { table: filter.table, column: filter.column },
    operator: "In",
    values: filter.values,
    filterType: pbi.models.FilterType.Basic,
  };
}

/** Set every slicer of the active page that targets this field. Returns the first one's name, or null. */
async function mirrorSlicers(r: any, filter: NonNullable<ReportControl["filter"]>, onEvent: Props["onEvent"], by: "user" | "agent") {
  try {
    const page = (await r.getPages()).find((p: any) => p.isActive);
    let hit: string | null = null;
    for (const v of await pageVisuals(page)) {
      if (!SLICERS.has(v.type)) continue;
      const st = await v.getSlicerState().catch(() => null);
      const targets: any[] = st?.targets ?? (st?.filters ?? []).map((f: any) => f.target);
      const on = targets.some(
        (t) => t?.table?.toLowerCase() === filter.table.toLowerCase() && t?.column?.toLowerCase() === filter.column.toLowerCase(),
      );
      if (!on) continue;
      await v.setSlicerState({ filters: [await basicFilter(filter)] });
      hit ??= v.title || v.type;
    }
    return hit;
  } catch (e) {
    onEvent({ actor: by, kind: "error", label: "setSlicerState refused", detail: String(e).slice(0, 300) });
    return null;
  }
}

/** Clear every slicer selection on the active page; returns the ones that had one. */
async function clearSlicers(r: any): Promise<string[]> {
  const out: string[] = [];
  try {
    const page = (await r.getPages()).find((p: any) => p.isActive);
    for (const v of await pageVisuals(page)) {
      if (!SLICERS.has(v.type)) continue;
      const st = await v.getSlicerState().catch(() => null);
      if (!st?.filters?.length) continue;
      await v.setSlicerState({ filters: [] });
      out.push(v.title || v.type);
    }
  } catch {
    // Nothing to clear.
  }
  return out;
}

function parseCsv(csv: string, max = 100): { columns: string[]; rows: Array<Array<string | number | null>> } {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { columns: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else quoted = false;
        } else cur += c;
      } else if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"') quoted = true;
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const columns = parseLine(lines[0]);
  const rows = lines.slice(1, max + 1).map((l) =>
    parseLine(l).map((v) => {
      const t = v.trim();
      if (t !== "" && Number.isFinite(Number(t))) return Number(t);
      if (v === "") return null;
      // A product picture is a data URI thousands of characters long: the agent gets that a
      // picture is there, not its bytes. Any other long cell is cut and says so.
      if (/^data:image\//i.test(t)) return "[image]";
      return v.length > 300 ? `${v.slice(0, 300)}… [cut, ${v.length} chars]` : v;
    }),
  );
  return { columns, rows };
}

// ---------------------------------------------------------------------------------------------
// Export to Excel: what the user sees, aggregated
// ---------------------------------------------------------------------------------------------

/** Rows asked of exportData per visual for an export; a smaller retry if the API refuses it. */
const EXPORT_ROWS = 30000;
const EXPORT_ROWS_RETRY = 1000;

/** Wait for the report to finish drawing (or give up after `ms`, and say so). */
function rendered(r: any, ms = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(t);
      r.off?.("rendered", on);
      resolve(ok);
    };
    const on = () => done(true);
    const t = setTimeout(() => done(false), ms);
    r.on("rendered", on);
  });
}

/** One page as the export sees it: filters, slicer selections, every data visual's rows. */
async function collectPage(page: any): Promise<{ page: ExportPage; tried: number; failed: number; errors: string[] }> {
  const out: ExportPage = { title: page.displayName, filters: [], visuals: [], unread: [] };
  const errors: string[] = [];
  let tried = 0;
  let failed = 0;
  try {
    for (const f of (await page.getFilters?.()) ?? []) out.filters.push(`${describeFilter(f)} (page filter, set by the report's author)`);
  } catch {
    /* a page that cannot list its filters still exports its visuals */
  }
  for (const v of await pageVisuals(page)) {
    if (DECOR.has(v.type)) continue;
    const name = v.title || v.type;
    if (SLICERS.has(v.type)) {
      const st = await v.getSlicerState().catch(() => null);
      for (const f of st?.filters ?? []) out.filters.push(`${describeFilter(f)} (slicer “${name}”)`);
      continue;
    }
    tried++;
    let cap = EXPORT_ROWS;
    let res: any = null;
    try {
      res = await v.exportData(0 /* Summarized */, cap);
    } catch (e) {
      // Measured, not assumed: the row limit the embedded API accepts is part of this spike.
      cap = EXPORT_ROWS_RETRY;
      try {
        res = await v.exportData(0, cap);
        errors.push(`“${name}”: ${EXPORT_ROWS} rows refused (${String((e as { message?: string })?.message ?? e).slice(0, 80)}), ${cap} accepted`);
      } catch (e2) {
        failed++;
        const why = String((e2 as { message?: string })?.message ?? e2).slice(0, 100);
        errors.push(`“${name}”: ${why}`);
        out.unread.push(`“${name}” (${v.type}) — exports nothing (${why})`);
        continue;
      }
    }
    const parsed = parseCsv(String(res?.data ?? ""), cap);
    if (parsed.columns.length) out.visuals.push({ title: name, type: v.type, columns: parsed.columns, rows: parsed.rows, rowCap: cap });
    else out.unread.push(`“${name}” (${v.type}) — exported no rows`);
  }
  return { page: out, tried, failed, errors };
}

/**
 * A second, invisible copy of the same report, for reading pages the user is not on.
 *
 * MEASURED live 2026-10-11 on two canvas reports: exportData refuses every visual
 * of a page that is not the active one. Moving the user's own report through its pages works but
 * shows them flashing by; this copy is moved instead, offscreen but with a real size (Power BI does
 * not draw into a hidden element). Same embed token, same report.
 */
async function hiddenEmbed(pbi: any, embed: Props["embed"]): Promise<{ report: any; dispose: () => void } | null> {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:fixed;left:-20000px;top:0;width:1600px;height:900px;pointer-events:none;";
  document.body.appendChild(el);
  const svc = new pbi.service.Service(pbi.factories.hpmFactory, pbi.factories.wpmpFactory, pbi.factories.routerFactory);
  const dispose = () => {
    try {
      svc.reset(el);
    } catch {
      /* already gone */
    }
    el.remove();
  };
  try {
    const r: any = svc.embed(el, {
      type: "report",
      id: embed.reportId,
      embedUrl: embed.embedUrl,
      accessToken: embed.token,
      tokenType: pbi.models.TokenType.Embed,
      settings: { panes: { filters: { visible: false }, pageNavigation: { visible: false } } },
    });
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 45000);
      r.on("loaded", () => {
        clearTimeout(t);
        resolve(true);
      });
      r.on("error", () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    if (!ok) {
      dispose();
      return null;
    }
    return { report: r, dispose };
  } catch {
    dispose();
    return null;
  }
}

/**
 * The export. The page on screen is read as it is. Other pages are read in the invisible copy,
 * given the same report-level filters (and the agent's slicer filter, if it set one); if that copy
 * cannot be made or cannot read a page, the user's report shows that page for a moment instead,
 * and the file says which road each page took.
 */
async function collect(
  r: any,
  scope: ExportScope,
  makeHidden: () => Promise<{ report: any; dispose: () => void } | null>,
  agentFilter: ReportControl["filter"],
): Promise<ExportBundle> {
  const pages: any[] = (await r.getPages()).filter((p: any) => p.visibility !== 1);
  const active = pages.find((p) => p.isActive) ?? pages[0];
  const targets = scope === "page" ? [active] : pages;
  const reportFiltersRaw: any[] = (await r.getFilters()) ?? [];
  const reportFilters = reportFiltersRaw.map(describeFilter).filter(Boolean);
  const notes: string[] = [`Each visual exported with exportData (summarised), up to ${EXPORT_ROWS} rows.`];
  const viaCopy: string[] = [];
  const shown: string[] = [];
  const out: ExportPage[] = [];
  let hidden: { report: any; dispose: () => void } | null | undefined;
  let moved = false;
  try {
    for (const p of targets) {
      if (p.name === active.name) {
        const res = await collectPage(p);
        out.push(res.page);
        for (const e of res.errors) notes.push(`${p.displayName} · ${e}`);
        continue;
      }
      // ---- another page: the invisible copy first ----
      if (hidden === undefined) {
        hidden = await makeHidden();
        if (hidden) {
          await hidden.report.updateFilters(1 /* ReplaceAll */, reportFiltersRaw).catch(() => undefined);
        } else notes.push("The invisible copy of the report could not be opened; other pages were read by showing them.");
      }
      let res: Awaited<ReturnType<typeof collectPage>> | null = null;
      if (hidden) {
        const hp = (await hidden.report.getPages()).find((x: any) => x.name === p.name);
        if (hp) {
          await hp.setActive();
          await rendered(hidden.report);
          // The slicer must have REDRAWN the page before it is read: exporting straight after
          // setSlicerState read two pages unfiltered while the file claimed the filter (measured
          // live 2026-10-11, a region slicer).
          // Listening BEFORE the slicer is set, so a fast redraw is not missed.
          const redraw = agentFilter?.values.length ? rendered(hidden.report, 15000) : null;
          if (redraw && agentFilter && (await mirrorSlicers(hidden.report, agentFilter, () => undefined, "agent"))) {
            if (!(await redraw)) {
              notes.push(`“${p.displayName}”: the slicer filter was set but the page did not report a redraw within 15 s — check its figures.`);
            }
          }
          res = await collectPage(hp);
          if (res.tried > 0 && res.failed === res.tried) res = null;
          else viaCopy.push(p.displayName);
        }
      }
      // ---- fallback: show the page in the user's report ----
      if (!res) {
        await p.setActive();
        moved = true;
        if (!(await rendered(r))) notes.push(`“${p.displayName}” did not report "rendered" within 20 s; read anyway.`);
        res = await collectPage(p);
        shown.push(p.displayName);
      }
      out.push(res.page);
      for (const e of res.errors) notes.push(`${p.displayName} · ${e}`);
    }
  } finally {
    hidden?.dispose();
    if (moved) {
      await active.setActive();
      await rendered(r, 10000);
    }
  }
  if (viaCopy.length) {
    notes.push(
      `Read in an invisible copy of the report, with the same report filters${agentFilter?.values.length ? " and the assistant's slicer filter" : ""}: ${viaCopy.join(", ")}. ` +
        "A slicer selection made by hand on one of those pages is not carried over.",
    );
  }
  if (shown.length) notes.push(`Read by showing them for a moment, then back to “${active.displayName}”: ${shown.join(", ")}.`);
  notes.push('Pictures in table cells (product images) are written as "[image]".');
  // The report's NAME is the page's to fill: the embed knows ids, the catalogue knows names.
  return { report: "", scope, reportFilters, pages: out, notes };
}

function describeFilter(f: any): string {
  const t = f?.target;
  const col = t?.column ?? t?.hierarchy ?? t?.measure ?? "field";
  const target = t?.table ? `${t.table}[${col}]` : String(col);
  if (Array.isArray(f?.values) && f.values.length) return `${target} ${f.operator ?? "In"} ${f.values.join(", ")}`;
  if (Array.isArray(f?.conditions) && f.conditions.length) {
    return `${target} ${f.conditions.map((c: any) => `${c.operator} ${c.value}`).join(" & ")}`;
  }
  return `${target} filtered`;
}
