/**
 * The report's semantic model, as the agent may reach it — one interface, two roads.
 *
 *  REAL — `executeQueries` under the user's OBO token (lib/powerbi/embed `executeDax`), so Power
 *         BI applies the user's RLS to the agent exactly as to the visuals beside it. The schema is
 *         DISCOVERED through `INFO.VIEW.*` (no admin right: a user who can query the model can
 *         describe it), cached briefly, and never sent to the model wholesale — a real model
 *         can have 60 tables and 844 columns. `INFO.COLUMNS()` and friends can be blocked
 *         for non-admins (measured 2026-09-22), so only the VIEW family is used.
 *  SP   — the same, under an app identity, when the deployment's plane has an app road
 *         (lib/lens/plane.ts); never on a model with RLS.
 *  MOCK — the synthetic models of content/lens-demo.ts through lib/lens/mock-engine.
 */
import { executeDax } from "@/lib/powerbi/embed";
import { isError } from "@/lib/adapters/types";
import { mockModel, mockSchema, runMockDax, values as mockValues } from "@/lib/lens/mock-engine";

export interface Field {
  name: string;
  type: string;
}
export interface Schema {
  tables: Record<string, { columns: Field[]; measures: Field[] }>;
}
export type DaxResult = { rows: Array<Record<string, unknown>> } | { error: string };

export interface ModelAccess {
  road: "mock" | "obo" | "sp";
  schema(): Promise<Schema>;
  dax(query: string): Promise<DaxResult>;
  /** Which of `vals` exist in the column — the check before a filter. */
  existing(table: string, column: string, vals: string[], type: string): Promise<{ present: string[]; sample: string[] } | { error: string }>;
}

const TTL_MS = 15 * 60 * 1000;
// Power BI's auto date/time tables: hidden, one per date column, noise to a model reading the schema.
const AUTO_DATE = /^(LocalDateTable_|DateTableTemplate_)/;
const schemaCache = new Map<string, { at: number; schema: Schema }>();

function literal(v: string, type: string): string {
  const quoted = `"${v.replace(/"/g, '""')}"`;
  if (/text|string/i.test(type)) return quoted;
  return Number.isFinite(Number(v)) && v.trim() !== "" ? v : quoted;
}

/**
 * The report's semantic model id, read from Power BI with the request's token — for a catalogue entry that does
 * not carry it. Read rather than guessed: a configured id could drift from the report on screen.
 */
export async function datasetOf(binding: { workspaceId: string; reportId: string }, token: string): Promise<string> {
  const res = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${binding.workspaceId}/reports/${binding.reportId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`report lookup failed (${res.status})`);
  const ds = ((await res.json()) as { datasetId?: string }).datasetId;
  if (!ds) throw new Error("Power BI returned no datasetId for this report");
  return ds;
}

export function mockAccess(reportId: string): ModelAccess | null {
  const m = mockModel(reportId);
  if (!m) return null;
  return {
    road: "mock",
    schema: async () => mockSchema(m),
    dax: async (q) => runMockDax(m, q),
    existing: async (_t, column, vals) => {
      const all = mockValues(m, column);
      if (!all.length) return { error: `no text column ${column} to filter on` };
      return { present: vals.filter((v) => all.includes(v)), sample: all.slice(0, 15) };
    },
  };
}

export function realAccess(datasetId: string, token: string, road: "obo" | "sp" = "obo"): ModelAccess {
  const dax = async (query: string): Promise<DaxResult> => {
    const r = await executeDax(token, datasetId, query);
    if (isError(r)) return { error: r.error };
    return { rows: r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))) };
  };
  return {
    road,
    dax,
    async schema() {
      const hit = schemaCache.get(datasetId);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.schema;
      const q = (fn: string, cols: string) => dax(`EVALUATE SELECTCOLUMNS(FILTER(${fn}(), NOT [IsHidden]), ${cols})`);
      const [cols, meas, tabs] = await Promise.all([
        q("INFO.VIEW.COLUMNS", `"t", [Table], "n", [Name], "d", [DataType]`),
        q("INFO.VIEW.MEASURES", `"t", [Table], "n", [Name], "d", [DataType]`),
        q("INFO.VIEW.TABLES", `"n", [Name]`),
      ]);
      for (const part of [cols, meas, tabs]) {
        if ("error" in part) throw new Error(`the model could not be described: ${part.error}`);
      }
      const tables: Schema["tables"] = {};
      for (const r of (tabs as { rows: Array<Record<string, unknown>> }).rows) {
        const n = String(r.n);
        if (!AUTO_DATE.test(n)) tables[n] = { columns: [], measures: [] };
      }
      for (const r of (cols as { rows: Array<Record<string, unknown>> }).rows) {
        const t = tables[String(r.t)];
        if (t && !String(r.n).startsWith("RowNumber-")) t.columns.push({ name: String(r.n), type: String(r.d) });
      }
      for (const r of (meas as { rows: Array<Record<string, unknown>> }).rows) {
        tables[String(r.t)]?.measures.push({ name: String(r.n), type: String(r.d) });
      }
      const schema = { tables };
      schemaCache.set(datasetId, { at: Date.now(), schema });
      return schema;
    },
    async existing(table, column, vals, type) {
      const ref = `'${table}'[${column}]`;
      const lits = vals.map((v) => literal(v, type)).join(", ");
      const found = await dax(`EVALUATE SELECTCOLUMNS(FILTER(VALUES(${ref}), ${ref} IN {${lits}}), "v", ${ref})`);
      if ("error" in found) return found;
      const present = new Set(found.rows.map((r) => String(r.v)));
      const sample = await dax(`EVALUATE TOPN(15, VALUES(${ref}))`);
      return {
        present: vals.filter((v) => present.has(v)),
        sample: "rows" in sample ? sample.rows.map((r) => String(Object.values(r)[0])) : [],
      };
    },
  };
}
