/**
 * The report catalogue Report Lens reads — "which report, which page covers X".
 *
 * The agent depends on a CONTRACT of two calls, never on where the rows live:
 *   listReports(module?, search?)  — one row per report, with what it covers
 *   findReportPage(term)           — the PAGE that covers a topic, to open the report on it
 * which is how a report catalogue is commonly exposed: two SQL functions over a report table and
 * a page table.
 *
 * Two adapters behind it:
 *  - DATABRICKS: a table pair behind two UC SQL functions, called through the
 *    Statement Execution API. Configured by LENS_CATALOG_WAREHOUSE_ID + LENS_CATALOG_SCHEMA +
 *    DATABRICKS_HOST. The functions are `lens_list_reports(p_module)` and
 *    `lens_find_report_page(p_term)` over `lens_report_catalog` / `lens_report_page`.
 *  - FILE (`content/lens-demo.ts`), the fallback: answers whenever Databricks is not configured or
 *    not reachable, and the caller is told which one answered — a catalogue answer must say its
 *    source.
 */
import { LENS_CATALOG, MOCK_MODELS, type LensCatalogReport } from "@/content/lens-demo";
import { plane } from "@/lib/lens/plane";

const MOCK = process.env.LENS_MOCK !== "0";

/**
 * The estate THIS road can embed: on mock, the synthetic reports (they have a mock model); live,
 * the bound ones. Mixing them would offer a report the page cannot render.
 */
const estate = (): LensCatalogReport[] =>
  // A plane with a closed set (lib/lens/plane.ts): that set, in its order. Nothing else is reachable.
  (!MOCK && plane.estate()) ||
  LENS_CATALOG.filter((r) => (MOCK ? Boolean(MOCK_MODELS[r.report_id]) : Boolean(r.binding)));

export interface CatalogReportRow {
  report_id: string;
  name: string;
  module: string;
  pages: number;
  covers: string;
  env: string;
}

export interface CatalogPageRow {
  report_id: string;
  report: string;
  module: string;
  /** Section id, when the catalogue knows it. */
  page: string;
  page_title: string;
  covers: string;
}

export interface CatalogAnswer<T> {
  source: string;
  rows: T[];
}

// ------------------------------------------------------------------------------------------
// file adapter
// ------------------------------------------------------------------------------------------

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

/** Every word of the term found somewhere in the text — "late orders by store" matches a page about them. */
function covers(text: string, term: string): boolean {
  const words = term.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  return words.length > 0 && words.every((w) => has(text, w.replace(/s$/, "")));
}

const file = {
  source: "file catalogue (content/lens-demo.ts) — the Databricks catalogue is not configured here",
  listReports(module = "", search = ""): CatalogReportRow[] {
    return estate().filter((r) => !module || has(r.module, module))
      .filter((r) => !search || has(`${r.name} ${r.description} ${r.module}`, search))
      .map((r) => ({
        report_id: r.report_id,
        name: r.name,
        module: r.module,
        pages: r.pages.length,
        covers: r.description,
        env: r.env,
      }));
  },
  findReportPage(term: string): CatalogPageRow[] {
    const out: CatalogPageRow[] = [];
    for (const r of estate()) {
      for (const p of r.pages) {
        if (covers(`${p.title} ${p.covers} ${r.name} ${r.module}`, term)) {
          out.push({ report_id: r.report_id, report: r.name, module: r.module, page: p.page, page_title: p.title, covers: p.covers });
        }
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------------------------------
// databricks adapter
// ------------------------------------------------------------------------------------------

/**
 * A Databricks CLI profile (`~/.databrickscfg`), read at call time — DEVELOPMENT ONLY. It lets the
 * catalogue use a CLI profile a developer already maintains without copying its token into
 * another file. Never in production: it is one broad identity for everyone.
 */
function profile(): { host?: string; token?: string } {
  const name = process.env.LENS_CATALOG_PROFILE;
  if (!name || process.env.NODE_ENV === "production") return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    const text = fs.readFileSync(`${home}/.databrickscfg`, "utf8");
    const section = text.split(/^\[/m).find((s) => s.startsWith(`${name}]`)) ?? "";
    const val = (k: string) => section.match(new RegExp(String.raw`^\s*${k}\s*=\s*(\S+)`, "m"))?.[1];
    return { host: val("host"), token: val("token") };
  } catch {
    return {};
  }
}

function databricksConfig() {
  // The mock estate's keys are not in the live catalogue: on mock, the file answers. So it does on a
  // plane that rules the Databricks catalogue out (one with a closed set of reports).
  if (MOCK || !plane.databricksCatalogue) return null;
  const host = process.env.DATABRICKS_HOST ?? profile().host;
  const warehouse = process.env.LENS_CATALOG_WAREHOUSE_ID;
  const schema = process.env.LENS_CATALOG_SCHEMA; // e.g. "lens_demo.gold"
  return host && warehouse && schema ? { host: host.replace(/\/$/, ""), warehouse, schema } : null;
}

/**
 * One UC function, called with a NAMED parameter through the Statement Execution API. The value
 * is bound as a parameter, never concatenated into the statement.
 */
async function callFunction(
  fn: string,
  param: { name: string; value: string },
  token: string,
): Promise<Array<Record<string, string>>> {
  const cfg = databricksConfig();
  if (!cfg) throw new Error("not configured");
  const res = await fetch(`${cfg.host}/api/2.0/sql/statements`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      warehouse_id: cfg.warehouse,
      statement: `SELECT * FROM ${cfg.schema}.${fn}(:${param.name})`,
      parameters: [{ name: param.name, value: param.value, type: "STRING" }],
      wait_timeout: "20s",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    }),
  });
  if (!res.ok) throw new Error(`statement failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  type Statement = {
    statement_id?: string;
    status?: { state?: string; error?: { message?: string } };
    manifest?: { schema?: { columns?: Array<{ name: string }> } };
    result?: { data_array?: string[][] };
  };
  let d = (await res.json()) as Statement;
  // A serverless warehouse waking up outlasts the 20 s inline wait (measured 2026-10-11: the first
  // call came back PENDING and the answer silently fell back to the file). Poll, bounded.
  for (let i = 0; i < 20 && (d.status?.state === "PENDING" || d.status?.state === "RUNNING") && d.statement_id; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${cfg.host}/api/2.0/sql/statements/${d.statement_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!poll.ok) throw new Error(`statement poll failed (${poll.status})`);
    d = (await poll.json()) as Statement;
  }
  if (d.status?.state !== "SUCCEEDED") {
    throw new Error(`statement ${d.status?.state ?? "unknown"}: ${d.status?.error?.message ?? ""}`.trim());
  }
  const cols = (d.manifest?.schema?.columns ?? []).map((c) => c.name);
  return (d.result?.data_array ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/**
 * The token the catalogue is read with — the USER's, exchanged on-behalf-of for Azure Databricks,
 * so Unity Catalog decides what this user may read. A developer token (LENS_CATALOG_DEV_TOKEN) is
 * accepted only outside production: it is a broad identity, and the guardrail (docs/security.md)
 * rules those out for anything a user is served by.
 */
async function catalogToken(userAssertion?: string): Promise<string> {
  const dev = process.env.LENS_CATALOG_DEV_TOKEN ?? profile().token;
  if (dev && process.env.NODE_ENV !== "production") return dev;
  if (!userAssertion) throw new Error("no signed-in user to read the catalogue as");
  const { databricksTokenOnBehalfOf } = await import("@/lib/auth/entra");
  return databricksTokenOnBehalfOf(userAssertion);
}

// ------------------------------------------------------------------------------------------
// the contract
// ------------------------------------------------------------------------------------------

export async function listReports(
  opts: { module?: string; search?: string; userAssertion?: string },
): Promise<CatalogAnswer<CatalogReportRow>> {
  const cfg = databricksConfig();
  if (cfg) {
    try {
      const rows = await callFunction("lens_list_reports", { name: "p_module", value: opts.module ?? "" }, await catalogToken(opts.userAssertion));
      const mapped = rows.map((r) => ({
        report_id: r.report_id, name: r.ds_report, module: r.ds_module,
        pages: Number(r.nr_pages ?? 0), covers: r.tx_description, env: r.ds_env,
      }));
      return {
        source: `Databricks catalogue (${cfg.schema}.lens_report_catalog)`,
        rows: opts.search ? mapped.filter((r) => has(`${r.name} ${r.covers} ${r.module}`, opts.search!)) : mapped,
      };
    } catch (e) {
      return { source: `${file.source}; Databricks was configured but failed: ${String(e).slice(0, 160)}`, rows: file.listReports(opts.module, opts.search) };
    }
  }
  return { source: file.source, rows: file.listReports(opts.module, opts.search) };
}

export async function findReportPage(
  term: string,
  userAssertion?: string,
): Promise<CatalogAnswer<CatalogPageRow>> {
  const cfg = databricksConfig();
  if (cfg) {
    try {
      const token = await catalogToken(userAssertion);
      let rows = await callFunction("lens_find_report_page", { name: "p_term", value: term }, token);
      // The function matches the term as ONE phrase (LIKE), so "inventory stock levels" finds
      // nothing while each word would. On no hit, ask per significant word and rank pages by how
      // many words they matched — the same word-wise reading the file adapter gives.
      const words = term.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
      if (!rows.length && words.length > 1) {
        const hits = new Map<string, { row: Record<string, string>; n: number }>();
        for (const w of words.slice(0, 5)) {
          for (const r of await callFunction("lens_find_report_page", { name: "p_term", value: w.replace(/s$/, "") }, token)) {
            const k = `${r.report_id}:${r.page_name}`;
            hits.set(k, { row: r, n: (hits.get(k)?.n ?? 0) + 1 });
          }
        }
        rows = [...hits.values()].sort((a, b) => b.n - a.n).map((h) => h.row);
      }
      return {
        source: `Databricks catalogue (${cfg.schema}.lens_report_page)`,
        rows: rows.map((r) => ({
          report_id: r.report_id, report: r.ds_report, module: r.ds_module,
          page: r.page_name ?? "", page_title: r.ds_page, covers: r.tx_page_description,
        })),
      };
    } catch (e) {
      return { source: `${file.source}; Databricks was configured but failed: ${String(e).slice(0, 160)}`, rows: file.findReportPage(term) };
    }
  }
  return { source: file.source, rows: file.findReportPage(term) };
}

/**
 * A report the page may embed, by our key. Only what the catalogue lists can be opened: the embed
 * broker never takes a workspace/report id from the browser, so "open" cannot be steered at an
 * arbitrary item — and on the real road Power BI still checks the user can see it.
 */
export function lensReport(reportId: string): LensCatalogReport | undefined {
  return estate().find((r) => r.report_id === reportId);
}

export function lensReports(): LensCatalogReport[] {
  return estate();
}
