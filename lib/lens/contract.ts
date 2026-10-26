/**
 * Report Lens — the contracts between the embedded report, the page and the agent.
 *
 * Started from this repo's `lib/page-context.ts` + `lib/interaction-log.ts`. What came back is larger: the
 * report's PAGES (so the agent can navigate), a CONTROL object the page applies to the live
 * report (so the agent can act), and attribution fields on every event (so the log can be
 * recorded server-side). Pure types and functions, no React — server and client import both.
 */
import type { VisibleVisual } from "@/lib/page-context";

export type { VisibleVisual };

/** Live state read OUT of the embedded report. */
export interface LensState {
  activePage?: string;
  /** Every page the report has: `name` is Power BI's section id, `displayName` the tab title. */
  pages?: { name: string; displayName: string }[];
  /** Human-readable filter descriptions, e.g. `Sales[Region] In EMEA`. */
  filters?: string[];
  /** Human-readable selection, e.g. `product = Tokyo Tidbits`. */
  selection?: string[];
  /** What the visuals on screen actually render (exportData), bounded. */
  visibleData?: VisibleVisual[];
  /** Data visuals on the page that gave no rows (exports nothing, or past the read cap) — named. */
  unreadVisuals?: string[];
  /** Set by the PAGE, not the embed: whether the report is loading, rendered, or refused. */
  embedStatus?: "loading" | "ready" | "failed";
  embedError?: string;
}

/**
 * What the page asks the report to do — one plain object, applied through the JS API with no
 * reload, whoever asked (the page's tabs or the agent).
 */
export interface ReportControl {
  /**
   * A page, by section id OR display title — the catalogue speaks titles, Power BI speaks ids,
   * and the embed resolves one to the other against the report's own page list.
   */
  page?: string;
  /**
   * `undefined` leaves the filters alone; `null` returns to the author's; a value applies one.
   * Defect paid for: reading "no filter" as "remove all" made a click on a page
   * tab wipe the author's own filter.
   */
  filter?: { table: string; column: string; values: string[] } | null;
  /** Who asked — logged as the actor. */
  by?: "user" | "agent";
  /** Bumped on every request, so asking for the same page twice is still a request. */
  seq?: number;
}

/** What the agent asked the REPORT to do. The page applies them, in order, after the answer. */
export type LensAction =
  | { type: "filter"; table: string; column: string; values: string[] }
  | { type: "clear_filters" }
  | { type: "page"; name: string; displayName: string }
  /** `page` is the section id the embed opens straight onto; `pageTitle` is what the log says. */
  | { type: "open_report"; report_id: string; name: string; page?: string; pageTitle?: string }
  /** Export what the user sees to Excel: the current page, or every page of the report. */
  | { type: "export"; scope: ExportScope };

/** One tool call, as the trail shows it. */
export interface LensCall {
  tool: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface LensAnswer {
  text: string;
  calls: LensCall[];
  actions: LensAction[];
  /** One line per fact about HOW the answer was produced (model, road, tokens, checks). */
  trail: string[];
  model: string;
  ms: number;
  hitStepCeiling: boolean;
  conversationId?: string;
  /** Set when the turn could NOT be saved: the answer stands, the chat did not keep it. */
  saveError?: string;
}

// ------------------------------------------------------------------------------------------
// the interaction log
// ------------------------------------------------------------------------------------------

export type LensActor = "user" | "agent" | "system";

export type LensKind =
  | "control" // a page tab or the agent asked the report for something
  | "view" // a report page became active
  | "filter" // filters changed on the embed
  | "select" // a data-point selection changed
  | "load" // the embed loaded
  | "error"
  | "ask"
  | "answer"
  | "query" // the agent ran a DAX query against the report's model, as the user
  | "export"; // what the user sees went to an Excel file

/** Which road the embed was on: mock · obo (as the user) · sp (an app identity, lib/lens/plane.ts). */
export type EmbedRoad = "mock" | "obo" | "sp";

export interface LensEvent {
  id: string;
  /** Epoch ms. */
  ts: number;
  actor: LensActor;
  kind: LensKind;
  label: string;
  detail?: string;
  /**
   * Attribution, stamped by the page when the event is recorded. The VIEWER is deliberately
   * absent: who did it is asserted by the server, never sent from here — a value the browser
   * sends is a label anyone can set.
   */
  report_id?: string;
  road?: EmbedRoad;
}

let seq = 0;

export function makeEvent(e: Omit<LensEvent, "id" | "ts">): LensEvent {
  seq += 1;
  return { id: `evt-${Date.now()}-${seq}`, ts: Date.now(), ...e };
}

export function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * The events implied by a CHANGE between two states. An identical re-sync produces nothing: the
 * embed fires `rendered` on every repaint, and a log of states instead of changes fills with
 * duplicates within seconds and stops being read.
 */
export function diffState(
  prev: LensState | null,
  next: LensState | null,
): Array<Omit<LensEvent, "id" | "ts">> {
  const out: Array<Omit<LensEvent, "id" | "ts">> = [];
  if (!next) return out;
  if (next.activePage && next.activePage !== prev?.activePage) {
    out.push({ actor: "user", kind: "view", label: `Viewing page “${next.activePage}”` });
  }
  const pf = (prev?.filters ?? []).join(" · ");
  const nf = (next.filters ?? []).join(" · ");
  if (nf !== pf) {
    out.push(
      next.filters?.length
        ? { actor: "user", kind: "filter", label: "Filters in force", detail: nf }
        : { actor: "user", kind: "filter", label: "Filters cleared" },
    );
  }
  const ps = (prev?.selection ?? []).join(" · ");
  const ns = (next.selection ?? []).join(" · ");
  if (ns !== ps && next.selection?.length) {
    out.push({ actor: "user", kind: "select", label: "Selected data point", detail: ns });
  }
  return out;
}

/** Resolve a page reference (section id or display title, case-insensitive) against a page list. */
export function resolvePage(
  pages: { name: string; displayName: string }[] | undefined,
  ref: string | undefined,
): { name: string; displayName: string } | undefined {
  if (!ref || !pages?.length) return undefined;
  const r = ref.trim().toLowerCase();
  return (
    pages.find((p) => p.name.toLowerCase() === r) ??
    pages.find((p) => p.displayName.toLowerCase() === r)
  );
}

// ------------------------------------------------------------------------------------------
// Export to Excel ("what I see, aggregated")
// ------------------------------------------------------------------------------------------

export type ExportScope = "page" | "report";

/** One visual as exported: the rows it renders, summarised, under the filters on screen. */
export interface ExportVisual {
  title: string;
  type: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  /** The row count asked of exportData: `rows.length === rowCap` means the export may be cut. */
  rowCap: number;
}

export interface ExportPage {
  title: string;
  /** Page filters, slicer selections — what narrowed THIS page. */
  filters: string[];
  visuals: ExportVisual[];
  /** Data visuals on the page that gave no rows, named with why. */
  unread: string[];
}

export interface ExportBundle {
  report: string;
  scope: ExportScope;
  /** Report-level filters in force when it was exported. */
  reportFilters: string[];
  pages: ExportPage[];
  /** How it was collected, said plainly (e.g. "pages read by moving through them"). */
  notes: string[];
}

/** What an embed (live or mock) offers the page for exporting. */
export interface LensExporter {
  collect(scope: ExportScope): Promise<ExportBundle>;
}
