/**
 * Report Lens in MOCK mode — a scripted planner in place of the model.
 *
 * It decides with regexes what a model would decide with judgement, and then goes through the
 * SAME tools (`makeTools`) against the synthetic models: so the value check before a filter, the
 * actions the page applies, the catalogue lookup and the trail are the real ones, and only the
 * choice of tool and the sentence are canned. The trail's first line says so — a mock answer must
 * never be mistakable for a model's.
 */
import type { LensAction, LensAnswer, LensCall } from "@/lib/lens/contract";
import { makeTools, type AskInput } from "@/lib/lens/agent";
import { mockModel } from "@/lib/lens/mock-engine";

const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? ""));

function table(rows: Array<Record<string, unknown>>, max = 6): string {
  if (!rows.length) return "_no rows_";
  const cols = Object.keys(rows[0]);
  return [
    `| ${cols.join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
    ...rows.slice(0, max).map((r) => `| ${cols.map((c) => fmt(r[c])).join(" | ")} |`),
  ].join("\n");
}

const FILLER =
  /\b(where|can|could|do|does|i|we|you|see|find|look|which|what|other|report|reports|page|pages|cover|covers|show|me|the|a|an|is|are|there|about|for|on|of|open|it|please|here|that|this|in|to)\b/gi;

/** Parse a published filter (`sales[country] In Japan, Italy`) into a TREATAS clause. */
function treatas(filters: string[] | undefined): string[] {
  return (filters ?? []).flatMap((f) => {
    const m = f.match(/^'?([^'[]+)'?\[([^\]]+)\]\s+In\s+(.+)$/i);
    if (!m) return [];
    const vals = m[3].split(/\s*,\s*/).map((v) => `"${v.replace(/"/g, '""')}"`).join(", ");
    return [`TREATAS({${vals}}, '${m[1]}'[${m[2]}])`];
  });
}

export async function answerMock(input: AskInput, reportName: string): Promise<LensAnswer> {
  const t0 = Date.now();
  const actions: LensAction[] = [];
  const tools = makeTools(input, actions);
  const calls: LensCall[] = [];
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = (await tools[tool](args)) as any;
    calls.push({ tool, arguments: args, result });
    return result;
  };
  const q = input.question.trim();
  const m = mockModel(input.reportId);
  let text = "";

  const done = (): LensAnswer => ({
    text,
    calls,
    actions,
    model: "mock planner",
    ms: Date.now() - t0,
    hitStepCeiling: false,
    trail: [
      "mock planner — no model: the tool is chosen by pattern, the sentence is a template; the tools, checks and actions are the real ones",
      `${calls.length} tool call(s) against the synthetic model of “${reportName}” (content/lens-demo.ts)`,
    ],
  });

  // ---- export ---------------------------------------------------------------------------------
  if (/\b(export\w*|excel|esporta\w*|scarica\w*|download)\b/i.test(q)) {
    const scope = /\b(whole|entire|all|every|full|report|tutt[oaie]|intero)\b/i.test(q) ? "report" : "page";
    const r = await call("export_to_excel", { scope });
    text = r?.error ?? `Requested: ${r.requested}. The page is preparing the download.`;
    return done();
  }

  // ---- clear ----------------------------------------------------------------------------------
  if (/\b(clear|remove|reset)\b.*\bfilters?\b/i.test(q)) {
    await call("clear_filters");
    text = "Requested: back to the report's own filters. The page applies it now.";
    return done();
  }

  // ---- catalogue: which reports / where can I see X / open it ---------------------------------
  if (/\bwhich (other )?reports?\b|\bwhat reports?\b|\breports? (do we|are there)\b/i.test(q) && !/\bpage\b/i.test(q)) {
    const r = await call("list_reports");
    const others = (r.reports as any[]).filter((x) => !x.current);
    text =
      `The catalogue lists **${r.total}** reports:\n\n` +
      (r.reports as any[]).map((x) => `- **${x.name}** (${x.module}) — ${x.covers}${x.current ? " _(open now)_" : ""}`).join("\n") +
      (others[0] ? `\n\nWant me to open **${others[0].name}** here?` : "") +
      `\n\n_Source: ${r.source}._`;
    return done();
  }
  if (/\bwhere\b.*\b(see|find|look)\b|\bopen\b|\bwhich page\b/i.test(q) && !/\bpage\b.*\bof this\b/i.test(q)) {
    const term = q.replace(/[?.!,]/g, " ").replace(FILLER, " ").replace(/\s+/g, " ").trim() || q;
    const r = await call("find_report_page", { term });
    const best = (r.pages ?? [])[0];
    if (!best) {
      text = `No page in the catalogue covers “${term}”. _Source: ${r.source}._`;
      return done();
    }
    if (/\bopen\b/i.test(q)) {
      const o = await call("open_report", { report_id: best.report_id, page: best.page_title });
      text = o.error
        ? `I could not open it: ${o.error}`
        : `**${best.report}**, page **${best.page_title}**, covers that — ${best.covers}.\n\nRequested: ${o.requested}. Ask your next question once it has loaded.`;
      return done();
    }
    text =
      `**${best.report}**, page **${best.page_title}** — ${best.covers}.` +
      ((r.pages as any[]).length > 1
        ? `\n\nAlso:\n${(r.pages as any[]).slice(1, 4).map((p) => `- ${p.report} · ${p.page_title} — ${p.covers}`).join("\n")}`
        : "") +
      `\n\nI can open **${best.report}** on **${best.page_title}** here — just say so.\n\n_Source: ${r.source}._`;
    return done();
  }

  // ---- go to page -----------------------------------------------------------------------------
  const pg = q.match(/\b(?:go to|switch to|show me|move to)\s+(?:the\s+)?(.+?)\s+page\b/i) ?? q.match(/\bpage\s+[“"']?([^”"'?]+)[”"']?/i);
  if (pg) {
    const r = await call("go_to_page", { page: pg[1].trim() });
    text = r.error ? `There is no page “${pg[1].trim()}” — the pages are ${(r.pages as string[]).join(", ")}.` : `Requested: ${r.requested}.`;
    return done();
  }

  // ---- filter ---------------------------------------------------------------------------------
  if (/\bfilter\b|\bonly\b|\bjust\b/i.test(q) && m) {
    for (const [col, vals] of Object.entries(m.dims)) {
      const hit = vals.filter((v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q));
      if (hit.length) {
        await call("find_fields", { search: col });
        const r = await call("apply_filter", { table: m.table, column: col, values: hit });
        text = r.error ? `I could not filter: ${r.error}` : `Requested: ${r.requested}. The report's own filters stay.`;
        return done();
      }
    }
    // A value the model does not have: try the last capitalised word, so the refusal is the tool's.
    const guess = q.match(/\b([A-Z][\w-]+)\s*[?.!]?$/)?.[1];
    const col = Object.keys(m.dims)[0];
    if (guess) {
      const r = await call("apply_filter", { table: m.table, column: col, values: [guess] });
      text = `I did not filter: “${guess}” is not a value of ${m.table}[${col}]. Some that exist: ${(r.some_existing_values ?? []).slice(0, 6).join(", ")}.`;
      return done();
    }
  }

  // ---- the model's vocabulary -----------------------------------------------------------------
  if (/\b(measures?|metrics|tables?|fields|columns)\b/i.test(q)) {
    const t = await call("list_tables");
    if (t.error) {
      text = t.error;
      return done();
    }
    const first = t.tables[0]?.table;
    const d = first ? await call("describe_table", { table: first }) : null;
    text =
      `The model has **${t.tables.length}** visible table${t.tables.length === 1 ? "" : "s"}. ` +
      (d
        ? `**${first}** carries the measures ${d.measures.map((x: any) => `\`[${x.name}]\``).join(", ")} and can be sliced by ${d.columns.filter((c: any) => c.type === "Text").map((c: any) => `\`${c.name}\``).join(", ")}.`
        : "");
    return done();
  }

  // ---- a figure: measure × dimension, under the filters on screen ------------------------------
  const measure = m?.measures.find((x) => new RegExp(x.name.replace(/^Total /, ""), "i").test(q));
  if (m && measure) {
    const by = Object.keys(m.dims).find((d) => new RegExp(`\\bby ${d}|\\bper ${d}|\\beach ${d}`, "i").test(q)) ?? null;
    const clauses = treatas(input.context.filters);
    const query = `EVALUATE\n  SUMMARIZECOLUMNS(${[by ? `'${m.table}'[${by}]` : null, ...clauses, `"${measure.name}", [${measure.name}]`].filter(Boolean).join(",\n    ")})`;
    const r = await call("run_dax", { query });
    if (r.error) {
      text = `The query failed: ${r.error}`;
      return done();
    }
    const scope = clauses.length ? ` under the filters on screen (${input.context.filters!.join("; ")})` : "";
    text = by
      ? `**${measure.name}** by ${by}${scope}, from the model:\n\n${table(r.rows)}`
      : `**${measure.name}** is **${fmt(r.rows[0]?.[measure.name])}**${scope} — from the model.`;
    return done();
  }

  // ---- what am I looking at -------------------------------------------------------------------
  const s = await call("read_screen");
  const vis = s.visuals as any[];
  if (!s.page && !vis.length && !(input.context.pages ?? []).length) {
    text = `**${reportName}** is still connecting — it has not published its pages, filters or visuals yet. Ask again in a moment.`;
    return done();
  }
  text =
    `You are on **${s.page ?? "the first page"}** of **${reportName}**` +
    (s.filters.length ? `, filtered by ${s.filters.join("; ")}` : ", with no filters") +
    (s.selection.length ? `, with ${s.selection.join("; ")} selected` : "") +
    ".\n\n" +
    (vis.length
      ? vis.map((v) => `**${v.title}** — top: ${fmt(v.rows[0]?.[0])} at ${fmt(v.rows[0]?.[1])} (${v.rows_on_screen} rows on screen)`).join("\n\n")
      : "Nothing exportable is on screen yet.") +
    "\n\n_Read from the visuals on screen._";
  return done();
}
