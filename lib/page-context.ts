/**
 * The page-context contract.
 *
 * The load-bearing idea behind "the front-end IS the core": every page publishes
 * a machine-readable description of what the user is looking at, and the
 * conversational assistant READS it — so answers are grounded in the current page
 * (which certified report, which source/dataset), not a blind chat box.
 *
 * Pure types (no React) so both server and client can import them.
 */
export type PageObjectKind = "report" | "dataset" | "kpi";
export type SourceKind = "powerbi" | "databricks" | "mock" | "genie" | "qlik";

export interface PageObject {
  kind: PageObjectKind;
  id: string;
  name: string;
  source: SourceKind;
  /** Source-specific binding the adapters/embed need (dataset/workspace/report ids). */
  binding?: Record<string, string>;
}

/**
 * Live state read from the embedded report via the powerbi-client JS API — the
 * host app CAN see this because the report is a native object with a sanctioned
 * postMessage channel, not an opaque iframe. The assistant grounds its queries
 * in these filters/selection so its answer matches what is on screen.
 */
/** One on-screen visual's data, read via the powerbi-client `exportData` API. */
export interface VisibleVisual {
  title?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface EmbedState {
  activePage?: string;
  /** Human-readable filter descriptions, e.g. "Sales[Region] In EMEA". */
  filters?: string[];
  /** Human-readable current selection, e.g. "Category = Metals". */
  selection?: string[];
  /** Data currently rendered by the on-screen visuals — what the user sees. */
  visibleData?: VisibleVisual[];
}

export interface PageContext {
  route: string;
  title: string;
  /** Human-readable scope shown in the assistant header ("Sales — certified"). */
  scope: string;
  /** What is on the page right now — sent with every ask. */
  objects: PageObject[];
  /** Page-specific prompt chips. */
  suggestions: string[];
  /** Live embed state (active page, filters, selection), when a report is open. */
  embed?: EmbedState;
}

export const EMPTY_PAGE_CONTEXT: PageContext = {
  route: "/",
  title: "ade-lens",
  scope: "active catalog",
  objects: [],
  suggestions: [],
};
