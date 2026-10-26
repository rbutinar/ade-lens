/**
 * The mock engine behind Report Lens in mock mode — the synthetic models of
 * `content/lens-demo.ts`, evaluated in process.
 *
 * It exists so the demo's real machinery — the tools, the value check before a filter, the
 * actions the page applies, the trail — runs with no Power BI and no model key. It is NOT a DAX
 * engine and does not pretend to be: `run` accepts one shape, a SUMMARIZECOLUMNS over at most one
 * column, one measure and optional TREATAS filters, and refuses everything else by saying so.
 * A mock that quietly answered any query would be indistinguishable from a real one in a trail.
 */
import { MOCK_MODELS, type MockModel } from "@/content/lens-demo";

export interface Filter {
  column: string;
  values: string[];
}

export function mockModel(reportId: string): MockModel | undefined {
  return MOCK_MODELS[reportId];
}

/** The model as `INFO.VIEW.*` would describe it: one fact table, its columns and measures. */
export function mockSchema(m: MockModel) {
  const numeric = Object.keys(m.rows[0] ?? {}).filter((k) => !(k in m.dims));
  return {
    tables: {
      [m.table]: {
        columns: [
          ...Object.keys(m.dims).map((name) => ({ name, type: "Text" })),
          ...numeric.map((name) => ({ name, type: "Int64" })),
        ],
        measures: m.measures.map((x) => ({ name: x.name, type: "Double" })),
      },
    },
  };
}

function matches(row: Record<string, string | number>, filters: Filter[]): boolean {
  return filters.every((f) => f.values.includes(String(row[f.column])));
}

/** One measure, grouped by one column (or none), under the given filters. */
export function evaluate(
  m: MockModel,
  measure: string,
  by: string | null,
  filters: Filter[] = [],
): Array<Record<string, string | number>> {
  const def = m.measures.find((x) => x.name.toLowerCase() === measure.toLowerCase());
  if (!def) throw new Error(`no measure [${measure}] in the model`);
  if (by && !(by in m.dims)) throw new Error(`no column '${m.table}'[${by}] in the model`);
  const acc = new Map<string, number>();
  for (const row of m.rows) {
    if (!matches(row, filters)) continue;
    const key = by ? String(row[by]) : "";
    const v = def.field ? Number(row[def.field]) : 1;
    acc.set(key, (acc.get(key) ?? 0) + v);
  }
  const out = [...acc.entries()].map(([k, v]) =>
    by ? { [by]: k, [def.name]: v } : { [def.name]: v },
  );
  return out.sort((a, b) => Number(b[def.name]) - Number(a[def.name]));
}

/** The distinct values of a column — what the filter check reads. */
export function values(m: MockModel, column: string): string[] {
  return m.dims[column] ?? [];
}

// ------------------------------------------------------------------------------------------
// the one DAX shape the mock understands
// ------------------------------------------------------------------------------------------

const COL = String.raw`'?([A-Za-z_][\w ]*)'?\[([^\]]+)\]`;

/**
 * `EVALUATE [TOPN(n,] SUMMARIZECOLUMNS([<col>,] [TREATAS({..}, <col>),]* "<name>", [<Measure>]) …`
 * Anything else → an error naming the limit, which the agent reports instead of retrying blind.
 */
export function runMockDax(m: MockModel, query: string): { rows: Array<Record<string, unknown>> } | { error: string } {
  const q = query.replace(/\s+/g, " ").trim();
  if (!/SUMMARIZECOLUMNS/i.test(q)) {
    return {
      error:
        "the mock engine evaluates only EVALUATE SUMMARIZECOLUMNS(<column>?, TREATAS(...)*, \"name\", [Measure]) — this is synthetic demo data, not a Power BI model",
    };
  }
  const measure = q.match(/"[^"]*"\s*,\s*\[([^\]]+)\]/)?.[1] ?? q.match(/,\s*\[([^\]]+)\]\s*\)/)?.[1];
  if (!measure) return { error: "no measure found — write \"name\", [Measure] inside SUMMARIZECOLUMNS" };

  const filters: Filter[] = [];
  const treatas = new RegExp(String.raw`TREATAS\s*\(\s*\{([^}]*)\}\s*,\s*${COL}\s*\)`, "gi");
  let body = q;
  for (const t of q.matchAll(treatas)) {
    const vals = [...t[1].matchAll(/"((?:[^"]|"")*)"/g)].map((v) => v[1].replace(/""/g, '"'));
    filters.push({ column: t[3], values: vals });
    body = body.replace(t[0], "");
  }
  const inner = body.match(/SUMMARIZECOLUMNS\s*\((.*)$/i)?.[1] ?? "";
  const groupCol = inner.match(new RegExp(String.raw`^\s*${COL}`))?.[2] ?? null;
  const topn = Number(q.match(/TOPN\s*\(\s*(\d+)/i)?.[1] ?? 0);

  try {
    const rows = evaluate(m, measure, groupCol, filters);
    return { rows: topn ? rows.slice(0, topn) : rows };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
