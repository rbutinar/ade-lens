/**
 * Report Lens — the agent beside an embedded report.
 *
 * WHAT REACHES THE MODEL UNASKED is where the user is — report, page, filters, selection, what
 * they just did — and nothing else. The rows on screen and every figure from the model arrive
 * only as the return value of a tool it chose to call, and every call comes back as the trail.
 * The model may phrase an answer; it never supplies a number.
 *
 * WHOSE IDENTITY: the user's. On the real road the model is queried with the user's OBO token,
 * so the agent can see no row its user cannot.
 *
 * WHAT IT CAN DO TO THE REPORT: filter, clear, change page, open another report — PROPOSED here as
 * actions and APPLIED by the page through the same control object its own tabs use, so the log
 * reads the same whoever asked. Data it can never change.
 *
 * Defects kept fixed here:
 *  #4 step budget: 12 steps, the ceiling named in the answer, the prompt stops searching early.
 *  #5 actions are user-requested only — never used to explore.
 *  #7 an answer that CLAIMS an action with none recorded is sent back once (`CLAIMED_ACTION`),
 *     and the trail says the check fired. Prose alone did not hold it.
 */
import type { LensAction, LensAnswer, LensCall, LensState } from "@/lib/lens/contract";
import type { Usage } from "@/lib/lens/usage";
import { resolvePage } from "@/lib/lens/contract";
import { findReportPage, lensReport, listReports } from "@/lib/lens/catalog";
import { tidy } from "@/lib/lens/excel";
import type { ModelAccess, Schema } from "@/lib/lens/model";

export const MAX_STEPS = 12;
const ROWS_TO_MODEL = 50;
// Enough for a monthly chart over two years: at 20, a 21-month chart lost its last month.
const SCREEN_ROWS = 50;
const FIND_CAP = 40;
const LIST_CAP = 40;

/**
 * An answer that SAYS the report was acted on. Measured 2026-10-09: "filter the
 * report to …" got a DAX check of the value and then "I asked the report to filter on …" with no
 * apply_filter call — the report never moved.
 */
export const CLAIMED_ACTION =
  /\bI(?: have|'ve| just)? (?:asked|requested|told) the report\b|\bI(?: have|'ve)? (?:applied|set|added|cleared|removed) (?:the |a |that |your )?filters?\b|\bI(?: have|'ve)? (?:opened|switched to|moved to|navigated to|went to)\b/i;
const NUDGE =
  "Your answer says you acted on the report, but no action tool was called, so nothing happened on screen. If the user asked for it, call the tool now; otherwise correct the answer so it does not claim an action.";

export const SYSTEM = `You are the assistant inside a web page that hosts an embedded Power BI report. A user is looking at the report right now. You are told WHERE they are — which report, page, filters and selection — and what they just did. You are NOT given the data.

For anything factual, call a tool:
- read_screen: what the visuals on the current page are showing, under the filters in force.
- list_tables / describe_table / find_fields: the report's semantic model. Use them before writing DAX.
- run_dax: a read-only DAX query against that model, run as the user (their row-level security applies).

Rules:
- Never state a figure you did not get from a tool call in this conversation.
- Say where a figure came from: "on screen" (read_screen) or "from the model" (run_dax). They can differ, because the screen is filtered and a query is not unless you filter it.
- When the user says "this", "these", "here" or "the one I clicked", they mean the page, filters and selection you were given. Apply the SAME filters in DAX (CALCULATETABLE / TREATAS) and say so.
- Budget your lookups. If two or three find_fields / describe_table calls have not found what the question needs, STOP searching: say it does not exist by that name, name the closest fields you did find, and offer an alternative.
- Prefer the model's own measures over re-deriving them: a measure is the business definition, a SUM you wrote is not.
- DAX only: a query starts with EVALUATE (or DEFINE ... EVALUATE). Use TOPN to keep results small.
- You can change what the report SHOWS, and nothing else, with apply_filter, clear_filters, go_to_page and open_report — ONLY when the user explicitly asks to filter, navigate or open something. Never use them to explore on your own: moving the user's report is not a lookup. An action happens ONLY by calling its tool: writing that you filtered, opened or moved something does nothing. The page applies the action after your answer, so once the tool has returned ok, say what you requested, not that it is done.
- Before apply_filter, find the exact table and column. The tool checks the values exist and refuses the ones that do not; report that rather than guessing.
- list_reports reads the report catalogue (what each report covers, its domain). find_report_page finds the PAGE that covers a topic — prefer it when the user asks where to see something, and pass its page to open_report so the report opens on that page. Whenever you list reports or pages, END by offering to open one here, naming the best match (and its page) — users do not expect you can, so say it. A find_report_page hit whose "covers" matches the question carries everything open_report needs — open it straight away; do not search again with other terms or re-check it with list_reports. After open_report, stop: the new report's model is only reachable on the user's next question.
- The user can switch report, page and filters by hand. "Where the user is" is the truth NOW; if it differs from what the conversation says happened earlier, the user moved — never "correct" it by acting.
- Be short. Lead with the finding, then at most one line on how you got it.`;

const TOOLS = [
  { name: "read_screen", description: "The current page of the embedded report as the user sees it: page, filters, selection, and the rows each visual renders (bounded).", input_schema: { type: "object", properties: {} } },
  { name: "list_tables", description: "The visible tables of the report's semantic model, with how many columns and measures each has.", input_schema: { type: "object", properties: {} } },
  { name: "describe_table", description: "Visible columns (with data type) and measures of ONE table of the model.", input_schema: { type: "object", properties: { table: { type: "string" } }, required: ["table"] } },
  { name: "find_fields", description: "Search visible columns and measures across the whole model by a keyword in their name or table (case-insensitive).", input_schema: { type: "object", properties: { search: { type: "string" } }, required: ["search"] } },
  { name: "run_dax", description: `Run one read-only DAX query against the report's semantic model, as the user. Returns at most ${ROWS_TO_MODEL} rows.`, input_schema: { type: "object", properties: { query: { type: "string", description: "Starts with EVALUATE or DEFINE." } }, required: ["query"] } },
  { name: "apply_filter", description: "Filter the report on one column to the given values. Replaces any filter on that same column and keeps the report author's other filters. The values are checked against the model first.", input_schema: { type: "object", properties: { table: { type: "string" }, column: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["table", "column", "values"] } },
  { name: "clear_filters", description: "Remove the filters applied from outside the report, back to the author's own.", input_schema: { type: "object", properties: {} } },
  { name: "export_to_excel", description: "Export what the user sees to an Excel file, aggregated as the visuals show it, under the filters on screen: scope 'page' = the page on screen (one sheet), 'report' = every page (one sheet each, plus an index). Only when the user asks for an export.", input_schema: { type: "object", properties: { scope: { type: "string", enum: ["page", "report"] } }, required: ["scope"] } },
  { name: "go_to_page", description: "Show another page of the current report, by its display name.", input_schema: { type: "object", properties: { page: { type: "string" } }, required: ["page"] } },
  { name: "list_reports", description: "The report catalogue: each report with what it covers, its domain and its report_id. Optionally narrowed by domain (Sales, Procurement, Operations) or by a keyword.", input_schema: { type: "object", properties: { module: { type: "string" }, search: { type: "string" } } } },
  { name: "find_report_page", description: "Find the report PAGE that covers a topic, a page title or a domain — with the report_id and the page to pass to open_report.", input_schema: { type: "object", properties: { term: { type: "string" } }, required: ["term"] } },
  { name: "open_report", description: "Replace the embedded report with another one from the catalogue, optionally opening it on a page.", input_schema: { type: "object", properties: { report_id: { type: "string" }, page: { type: "string", description: "Optional: the page title from find_report_page." } }, required: ["report_id"] } },
];

export interface AskInput {
  question: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  reportId: string;
  context: LensState;
  interactions: Array<{ label: string; detail?: string }>;
  /** The model as the user may reach it, or null when it cannot be reached (says why in `modelWhy`). */
  access: ModelAccess | null;
  modelWhy?: string;
  userAssertion?: string;
  /** Called once per model call with its token usage: a plane's usage cap reads it. */
  onUsage?: (model: string, usage: Usage) => void;
}

const DAX_START = /^\s*(--[^\n]*\n|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(EVALUATE|DEFINE)\b/i;

export function guardDax(query: string): string | null {
  const q = (query ?? "").trim();
  if (!q) return "empty query";
  if (q.length > 6000) return "query longer than 6000 characters";
  if (!DAX_START.test(q)) return "a query must start with EVALUATE or DEFINE";
  return null;
}

// ------------------------------------------------------------------------------------------
// the tools, bound to one request
// ------------------------------------------------------------------------------------------

type Tool = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Did THIS message ask the report to change? Actions are user-requested only (defect
 * #5), and prose did not hold it here either: measured live 2026-10-11, "what am I looking at?" on a
 * report the user had switched to by hand made the agent re-open the previous one — its history said
 * it had opened one report, the context said another, and it "corrected" the difference.
 * So the action tools refuse unless the message asks for an action, or confirms one the assistant
 * just offered ("yes" / "sì" after "want me to open it?").
 */
// Verbs only: "page" alone asks nothing ("what am I looking at on this page?"). "show" alone stays
// out ("which measures does it show?"); the narrowing phrasings are in — measured 2026-10-16,
// "Which region is behind plan? Show only that one." was refused and the agent only offered.
const ACTION_WORDS =
  /\b(open|show me|show only|only show|just show|keep only|narrow\w*|limit (it |the \w+ )?to|switch|go to|take me|navigate|move to|jump to|filter|clear|remove|reset|export\w*|download|excel|apri\w*|mostra\w*|vai|portami|passa|filtra\w*|togli\w*|rimuovi\w*|azzera\w*|esporta\w*|scarica\w*|solo)\b/i;
const YES = /^\s*(yes|yeah|yep|sure|ok(ay)?|please|go ahead|do it|s[iì]|certo|va bene|vai|dai|perfetto)\b/i;
export function actionRequested(input: Pick<AskInput, "question" | "history">): boolean {
  if (ACTION_WORDS.test(input.question)) return true;
  const last = [...input.history].reverse().find((h) => h.role === "assistant")?.text ?? "";
  return YES.test(input.question) && /\b(open|filter|page|export|excel|apr|filtr|pagin|esport)/i.test(last);
}

/**
 * Low / high / total of every numeric column of a visual, computed here over ALL its rows.
 * Measured live 2026-10-11 (second channel: the source SQL): handed 21 monthly rows, the model
 * named the SECOND-lowest month as the low. Picking an extreme out of a list is arithmetic, and
 * arithmetic is the tool's job, not the sentence's.
 */
/** A number as exportData may format it: 35144, "35144", "€35,144", "48.6%". Anything else: NaN. */
function num(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (!/^[€$£]?\s?-?[\d,]+(\.\d+)?\s?%?$/.test(s)) return Number.NaN;
  return Number(s.replace(/[€$£,%\s]/g, ""));
}

export function extremes(columns: string[], rows: Array<Array<string | number | null>>) {
  const out: Record<string, { low: [string, number]; high: [string, number]; total: number }> = {};
  columns.forEach((col, i) => {
    if (i === 0) return; // the first column is the label
    const vals = rows
      .map((r) => [String(r[0] ?? ""), num(r[i])] as [string, number])
      .filter(([, n]) => Number.isFinite(n));
    if (vals.length < 2) return;
    const low = vals.reduce((a, b) => (b[1] < a[1] ? b : a));
    const high = vals.reduce((a, b) => (b[1] > a[1] ? b : a));
    out[col] = { low, high, total: Math.round(vals.reduce((s, [, n]) => s + n, 0) * 100) / 100 };
  });
  return out;
}

/**
 * Per-row gap between two ADJACENT percentage columns ("Historical" → "Recent"), the three largest
 * drops and rises, computed over ALL rows. Measured live 2026-10-16 on a supplier-risk page: asked
 * for the runners-up after the first, the model named one at −13.8 pts and skipped one at −16.6 —
 * ranking a difference by eye, the same defect `extremes` fixed.
 */
function changes(columns: string[], rows: Array<Array<string | number | null>>) {
  const pct = (v: unknown) => /%\s*$/.test(String(v ?? "").trim());
  const out: Record<string, { largest_drops: Array<[string, number]>; largest_rises: Array<[string, number]> }> = {};
  if (rows.length < 3) return out;
  for (let i = 1; i < columns.length - 1; i++) {
    const j = i + 1;
    if (!rows.every((r) => pct(r[i]) && pct(r[j]))) continue;
    const d = rows
      .map((r) => [String(r[0] ?? ""), Math.round((num(r[j]) - num(r[i])) * 10) / 10] as [string, number])
      .filter(([, n]) => Number.isFinite(n));
    const asc = [...d].sort((a, b) => a[1] - b[1]);
    out[`${columns[i]} → ${columns[j]} (points)`] = {
      largest_drops: asc.slice(0, 3).filter(([, n]) => n < 0),
      largest_rises: asc.reverse().slice(0, 3).filter(([, n]) => n > 0),
    };
  }
  return out;
}

/**
 * How many rows carry a non-zero value (and which), per numeric column, computed over ALL rows —
 * and per label group when the labels are "<name> <code>" ("Packaging Material 018" → "Packaging
 * Material"). Measured live on a warehouse floor-plan page: on 2026-10-18 the model called six €0 items
 * "four", and on 2026-10-23 it listed five stockout items outside Packaging and called them "four".
 * Counting rows is arithmetic too, the same defect `extremes` and `changes` fixed.
 */
export function counts(columns: string[], rows: Array<Array<string | number | null>>) {
  const LIST = 25;
  const kept = rows.filter((r) => !/^\s*total\s*$/i.test(String(r[0] ?? "")));
  const labels = kept.map((r) => String(r[0] ?? ""));
  const groupOf = (l: string) => /^(.*\S)\s+[A-Z]{0,3}-?\d+$/.exec(l)?.[1] ?? null;
  const groups = labels.map(groupOf);
  const grouped = groups.every(Boolean) && new Set(groups).size < labels.length;
  const out: Record<string, Record<string, unknown>> = {};
  columns.forEach((col, i) => {
    if (i === 0) return; // the first column is the label
    const vals = kept.map((r) => num(r[i]));
    const idx = vals.map((_, k) => k).filter((k) => Number.isFinite(vals[k]));
    if (idx.length < 2) return;
    const nz = idx.filter((k) => vals[k] !== 0).map((k) => labels[k]);
    const z = idx.filter((k) => vals[k] === 0).map((k) => labels[k]);
    const entry: Record<string, unknown> = { rows: idx.length, non_zero: nz.length, zero: z.length };
    if (nz.length && nz.length <= LIST) entry.non_zero_rows = nz;
    if (z.length && z.length <= LIST) entry.zero_rows = z;
    if (grouped) {
      const by: Record<string, { rows: number; non_zero: number; zero: number; total: number }> = {};
      for (const k of idx) {
        const g = (by[groups[k]!] ??= { rows: 0, non_zero: 0, zero: 0, total: 0 });
        g.rows += 1;
        if (vals[k] === 0) g.zero += 1;
        else g.non_zero += 1;
        g.total = Math.round((g.total + vals[k]) * 100) / 100;
      }
      entry.by_group = by;
    }
    out[col] = entry;
  });
  return out;
}

export function makeTools(input: AskInput, actions: LensAction[]): Record<string, Tool> {
  const { context, access, reportId } = input;
  let schemaP: Promise<Schema> | null = null;
  const schema = () => (schemaP ??= access!.schema());
  const noModel = () => ({
    error: `the report's model cannot be queried here: ${input.modelWhy ?? "no model access"}. Only read_screen and the catalogue are available.`,
  });
  const switching = () =>
    !asked
      ? {
          error:
            "refused: the user did not ask to change the report in this message. Answer the question; at most OFFER the action and let the user ask for it.",
        }
      : actions.some((a) => a.type === "open_report")
        ? { error: "a different report is being opened; act on it after it has loaded" }
        : null;
  const asked = actionRequested(input);
  const str = (v: unknown) => String(v ?? "").trim();

  return {
    async read_screen() {
      return {
        page: context.activePage ?? null,
        filters: context.filters ?? [],
        selection: context.selection ?? [],
        // Colour helpers out first, the same rule the Excel export uses: "Late Color" = "#E4572E" is
        // presentation, not data, and canvas reports often export one beside most bars (2026-10-16).
        visuals: (context.visibleData ?? []).slice(0, 10).map((raw) => {
          const { visual: v, dropped } = tidy(raw);
          return {
            title: v.title ?? "visual",
            columns: v.columns,
            rows: v.rows.slice(0, SCREEN_ROWS),
            rows_on_screen: v.rows.length,
            // Named for whose cut it is. "truncated" alone read as a fact about the SCREEN: a
            // 21-bar chart cut to 20 here was described as "truncated on screen", missing its last
            // month (review, 2026-10-11).
            rows_withheld_from_you: Math.max(0, v.rows.length - SCREEN_ROWS),
            extremes: extremes(v.columns, v.rows),
            changes: changes(v.columns, v.rows),
            counts: counts(v.columns, v.rows),
            ...(dropped.length ? { colour_columns_left_out: dropped } : {}),
          };
        }),
        visuals_not_read: context.unreadVisuals ?? [],
        note:
          "Rows as the visuals export them (summarised, as displayed). The SCREEN shows all rows_on_screen; " +
          "if rows_withheld_from_you > 0, only YOUR copy is cut — never say the screen is truncated, and do not " +
          "state a range beyond the rows you got without saying so. For a highest / lowest / total, quote `extremes` " +
          "(computed over every row) — never pick one out of the rows by eye; for the biggest gap between two columns " +
          "(historical vs recent, plan vs actual) quote `changes`, likewise computed over every row; for HOW MANY rows / items carry a value or none (also per group, e.g. an aisle " +
          "or a category) quote `counts`, likewise computed. Never count rows by eye: a number you write next to a list " +
          "must equal the length of that list. `visuals_not_read` names visuals that ARE " +
          "on the page but gave you no rows: say you cannot read them, never that they are empty. A filter line ending " +
          "in (slicer …) is a selection on a slicer of the page; (page filter …) was set by the report's author. " +
          "\"[image]\" in a cell is a picture on screen. `colour_columns_left_out` were conditional-colour codes: " +
          "say what the data columns say, not which colour something is. Describe WHERE something is only with what " +
          "the data or the page labels carry (coordinates, zone / aisle / region names): never a compass direction, " +
          "left / right or top / bottom unless a label on the page says so.",
      };
    },
    async list_tables() {
      if (!access) return noModel();
      const sc = await schema();
      return {
        tables: Object.entries(sc.tables)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([table, v]) => ({ table, columns: v.columns.length, measures: v.measures.length })),
      };
    },
    async describe_table(a) {
      if (!access) return noModel();
      const sc = await schema();
      const name = str(a.table);
      const key = Object.keys(sc.tables).find((k) => k.toLowerCase() === name.toLowerCase());
      if (!key) return { error: `no visible table \`${name}\` — call list_tables for the exact names` };
      return { table: key, ...sc.tables[key] };
    },
    async find_fields(a) {
      if (!access) return noModel();
      const s = str(a.search).toLowerCase();
      const hits: Array<Record<string, string>> = [];
      for (const [t, v] of Object.entries((await schema()).tables)) {
        for (const kind of ["measures", "columns"] as const) {
          for (const f of v[kind]) {
            if (s && (f.name.toLowerCase().includes(s) || t.toLowerCase().includes(s))) {
              hits.push({ kind: kind.slice(0, -1), table: t, name: f.name, type: f.type, dax: kind === "measures" ? `[${f.name}]` : `'${t}'[${f.name}]` });
            }
          }
        }
      }
      return { search: a.search, matches: hits.slice(0, FIND_CAP), total: hits.length, truncated: hits.length > FIND_CAP };
    },
    async run_dax(a) {
      const why = guardDax(str(a.query));
      if (why) return { error: why };
      if (!access) return noModel();
      const out = await access.dax(str(a.query));
      if ("error" in out) return { error: out.error, hint: "check names with describe_table / find_fields" };
      return { rows: out.rows.slice(0, ROWS_TO_MODEL), row_count: out.rows.length, truncated: out.rows.length > ROWS_TO_MODEL };
    },
    async apply_filter(a) {
      const blocked = switching();
      if (blocked) return blocked;
      const table = str(a.table);
      const column = str(a.column);
      const vals = (Array.isArray(a.values) ? a.values : []).map(str).filter(Boolean).slice(0, 50);
      if (!table || !column || !vals.length) return { error: "table, column and at least one value are required" };
      if (!access) return noModel();
      const col = (await schema()).tables[table]?.columns.find((c) => c.name === column);
      if (!col) return { error: `no visible column '${table}'[${column}] — use find_fields for the exact name` };
      // Checked, because a Power BI filter on a value that does not exist is not an error: it
      // empties the visuals and the report keeps rendering — silent success.
      const found = await access.existing(table, column, vals, col.type);
      if ("error" in found) return found;
      const missing = vals.filter((v) => !found.present.includes(v));
      if (!found.present.length) return { error: "none of those values exist in the column", missing, some_existing_values: found.sample };
      actions.push({ type: "filter", table, column, values: found.present });
      return {
        requested: `'${table}'[${column}] In ${found.present.join(", ")}`,
        missing_values_dropped: missing,
        // Said only when true: a fixed "the author's other filters stay" was repeated live on a
        // page that had none (review, 2026-10-11).
        note: (() => {
          const others = (context.filters ?? []).filter((f) => !new RegExp(`^'?${table}'?\\[${column}\\]`).test(f));
          const base = others.length
            ? `The page applies it after this answer; these other filters stay in force: ${others.join("; ")}.`
            : "The page applies it after this answer. No other filter is in force on this page — do not mention any.";
          // Measured live 2026-10-11: a click on "Household" then a filter to "Snacks" left
          // every card at (Blank) — Power BI intersects the selection with the filter — and the
          // agent said nothing. The report is right; staying silent about it is not.
          const sel = context.selection ?? [];
          return sel.length
            ? `${base} WARNING: a data-point selection is also in force (${sel.join("; ")}). Power BI combines it with this filter, so the visuals may narrow further or show (Blank). Tell the user, and say that clicking the selected point again clears it.`
            : base;
        })(),
      };
    },
    async export_to_excel(a) {
      const blocked = switching();
      if (blocked) return blocked;
      const scope = a.scope === "report" ? "report" : "page";
      actions.push({ type: "export", scope });
      return {
        requested: scope === "report" ? "an Excel file with every page of the report" : `an Excel file of the page “${context.activePage ?? "on screen"}”`,
        note: "The page builds and downloads the file after this answer, from what the visuals render under the user's filters. Say it is being prepared — not that it is done.",
      };
    },
    async clear_filters() {
      const blocked = switching();
      if (blocked) return blocked;
      actions.push({ type: "clear_filters" });
      return { requested: "back to the author's filters" };
    },
    async go_to_page(a) {
      const blocked = switching();
      if (blocked) return blocked;
      const hit = resolvePage(context.pages, str(a.page));
      if (!hit) return { error: `no page named '${str(a.page)}'`, pages: (context.pages ?? []).map((p) => p.displayName) };
      actions.push({ type: "page", name: hit.name, displayName: hit.displayName });
      return { requested: `page '${hit.displayName}'` };
    },
    async list_reports(a) {
      const res = await listReports({ module: str(a.module), search: str(a.search), userAssertion: input.userAssertion });
      return {
        source: res.source,
        reports: res.rows.slice(0, LIST_CAP).map((r) => ({ ...r, current: r.report_id === reportId })),
        total: res.rows.length,
        truncated: res.rows.length > LIST_CAP,
        next: "End your answer by offering to open one of these here — name the best match. Users do not expect you can open reports, so say it.",
      };
    },
    async find_report_page(a) {
      const term = str(a.term);
      if (!term) return { error: "a term is required" };
      const res = await findReportPage(term, input.userAssertion);
      return {
        source: res.source,
        pages: res.rows.slice(0, LIST_CAP).map((p) => ({ ...p, current_report: p.report_id === reportId })),
        total: res.rows.length,
        truncated: res.rows.length > LIST_CAP,
        next: "End your answer by offering to open the best-matching page here — name it. Users do not expect you can open reports, so say it.",
      };
    },
    async open_report(a) {
      // The same gate as the other actions — and the one that mattered: measured live 2026-10-11,
      // "what am I looking at?" reopened a report the user had just left, because only this tool
      // skipped the check.
      const blocked = switching();
      if (blocked) return blocked;
      const rid = str(a.report_id);
      const page = str(a.page);
      if (rid === reportId && !page) return { error: "that report is already open" };
      if (rid === reportId) {
        // Same report, another page: that is a page change, not a reload.
        const hit = resolvePage(context.pages, page);
        if (!hit) return { error: `no page named '${page}' in this report`, pages: (context.pages ?? []).map((p) => p.displayName) };
        actions.push({ type: "page", name: hit.name, displayName: hit.displayName });
        return { requested: `page '${hit.displayName}' of the report already open` };
      }
      const r = lensReport(rid);
      if (!r) return { error: `report ${rid} is not in the catalogue this page can embed from` };
      const pg = page ? r.pages.find((p) => p.page === page || p.title.toLowerCase() === page.toLowerCase()) : undefined;
      if (page && !pg) return { error: `report '${r.name}' has no page '${page}'`, pages: r.pages.map((p) => p.title) };
      actions.push({ type: "open_report", report_id: r.report_id, name: r.name, page: pg?.page, pageTitle: pg?.title });
      return {
        requested: `open '${r.name}'${pg ? ` on page '${pg.title}'` : ""}`,
        note: "Not open yet: the page loads it after this answer. Say you asked for it, and stop — its model is queried only on the next question.",
      };
    },
  };
}

// ------------------------------------------------------------------------------------------
// where the user is
// ------------------------------------------------------------------------------------------

export function contextBlock(reportName: string, input: AskInput): string {
  const c = input.context;
  // Before the embed has published anything, "nothing on screen" is not a finding about the
  // report: it is still connecting. Saying so stops the agent describing a real report as an
  // empty or mock one.
  // …but only while it IS loading. A report that failed to render (no token, refused identity) is
  // not "connecting" and must not be promised as coming (review 2026-10-11): the
  // page says which, and only absent that word does the empty state count as loading.
  const status = c.embedStatus ?? (!c.activePage && !c.pages?.length ? "loading" : "ready");
  const lines = [
    `Report: ${reportName}${
      status === "failed"
        ? ` — DID NOT RENDER for this user (${c.embedError ?? "no reason given"}). Nothing is on screen and it is not loading; say so, and say access is granted at Power BI, not here`
        : status === "loading"
          ? " — STILL CONNECTING: the embed has not published its state yet, so the page, filters and visuals are not known; say so rather than describing the report as empty"
          : ""
    }`,
    `Model access: ${input.access ? (input.access.road === "mock" ? "synthetic model (mock road)" : input.access.road === "sp" ? "the report's semantic model, as an app identity (every visitor sees the same rows)" : "the report's semantic model, as the user") : `none — ${input.modelWhy ?? "unavailable"}`}`,
    `Active page: ${c.activePage ?? "unknown"}`,
    `Filters in force: ${(c.filters ?? []).join("; ") || "none"}`,
    `Selection: ${(c.selection ?? []).join("; ") || "none"}`,
  ];
  const pages = (c.pages ?? []).map((p) => p.displayName);
  if (pages.length) lines.push(`Pages in this report: ${pages.slice(0, 20).join(", ")}`);
  const recent = input.interactions.slice(-12).map((e) => `- ${e.label}${e.detail ? `: ${e.detail}` : ""}`);
  if (recent.length) lines.push(`What the user just did, oldest first:\n${recent.join("\n")}`);
  // Said outright, because the event alone did not carry it: measured live 2026-10-11, the agent
  // saw "Opened <a report>" in the list and still told the user its own earlier open "didn't go
  // through". A report the user chose by hand is not a failed action to apologise for.
  const switched = [...input.interactions].reverse().find((e) => /^Opened “/.test(e.label));
  if (switched) {
    lines.push(
      `NOTE: the user switched report BY HAND (${switched.label.replace(/^Opened /, "")}). Any report opened earlier in this conversation DID open; the user then left it. Do not say an earlier action failed, and do not reopen anything unless asked.`,
    );
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------
// the loop — Anthropic tool use
// ------------------------------------------------------------------------------------------

export async function answerWithModel(input: AskInput, reportName: string): Promise<LensAnswer> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default as any;
  const client = new Anthropic();
  const model = process.env.LENS_AGENT_MODEL ?? "claude-opus-5";
  const actions: LensAction[] = [];
  const tools = makeTools(input, actions);
  const calls: LensCall[] = [];
  const t0 = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  let text = "";
  let nudged = false;

  // Re-sent every turn: the user moves through the report under the conversation, and the page
  // they were on three questions ago is not the page "this" refers to now.
  const system = `${SYSTEM}\n\n## Where the user is\n${contextBlock(reportName, input)}`;
  const messages: any[] = input.history
    .slice(-8)
    .map((h) => ({ role: h.role, content: h.text.slice(0, 4000) }))
    .filter((m) => m.content);
  messages.push({ role: "user", content: input.question });

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp: any = await client.messages.create({ model, max_tokens: 1400, system, tools: TOOLS, messages } as any);
    tokensIn += resp.usage?.input_tokens ?? 0;
    tokensOut += resp.usage?.output_tokens ?? 0;
    input.onUsage?.(model, resp.usage ?? {});
    if (resp.stop_reason !== "tool_use") {
      text = (resp.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      // Once only: a second claim without a call is returned as it is, and the trail says so.
      if (!nudged && !actions.length && CLAIMED_ACTION.test(text)) {
        nudged = true;
        messages.push({ role: "assistant", content: resp.content });
        messages.push({ role: "user", content: NUDGE });
        text = "";
        continue;
      }
      break;
    }
    messages.push({ role: "assistant", content: resp.content });
    const results: any[] = [];
    for (const block of resp.content as any[]) {
      if (block.type !== "tool_use") continue;
      const fn = tools[block.name];
      let result: unknown;
      try {
        result = fn ? await fn(block.input ?? {}) : { error: `unknown tool ${block.name}` };
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      calls.push({ tool: block.name, arguments: block.input ?? {}, result });
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
  }

  const queries = calls.filter((c) => c.tool === "run_dax").length;
  return {
    text:
      text ||
      `I ran out of steps (${MAX_STEPS}) before reaching an answer — the trail shows how far I got. Narrowing the question, or naming the table, usually helps.`,
    calls,
    actions,
    model,
    ms: Date.now() - t0,
    hitStepCeiling: !text,
    trail: [
      `model: ${model} · Anthropic API`,
      "prompt: where the user is (report, page, filters, selection, recent actions) — no rows",
      `${calls.length} tool call(s), ${queries} DAX quer${queries === 1 ? "y" : "ies"} ${input.access?.road === "obo" ? "as the user (OBO)" : input.access?.road === "sp" ? "as an app identity" : input.access ? "on the synthetic model" : "— model not reachable"}`,
      `tokens: ${tokensIn} in / ${tokensOut} out`,
      ...(nudged
        ? [`check: the first answer claimed an action with no action tool called; sent back once${actions.length ? "" : " — still no action recorded"}`]
        : []),
    ],
  };
}
