/**
 * The Excel file Report Lens exports — built in the browser with exceljs, from
 * what the embed's visuals render. Scope: what the user SEES,
 * AGGREGATED as the visuals show it. Nothing here queries anything: it formats an ExportBundle.
 *
 *   Index        — report, when, who, the filters in force, one row per page linking to its sheet,
 *                  and every visual that could NOT be exported, with why. A visual missing from
 *                  the file must never read as a visual that was empty.
 *   one sheet per page — each visual as a real Excel table (filter, sort, totals by hand), under
 *                  its title and a line saying how many rows came and whether the export may be cut.
 *
 * Values arrive as Power BI formats them ("€40,514", "12.5%"); they are written back as numbers
 * with an Excel number format, so the sheet sums and sorts — a text "€40,514" does neither.
 */
import type { ExportBundle, ExportPage, ExportVisual } from "@/lib/lens/contract";

type Cell = string | number | null;
interface Parsed {
  value: Cell;
  numFmt?: string;
}

/** "€40,514" → 40514 (€#,##0) · "+12.5%" → 0.125 (0.0%) · "1,112,670" → 1112670. Anything else stays text. */
export function parseCell(v: Cell): Parsed {
  if (v === null) return { value: v };
  // Raw numbers: a thousands separator on whole numbers from 1,000 up, nothing else imposed.
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) >= 1000 ? { value: v, numFmt: "#,##0" } : { value: v };
  const t = v.trim();
  // A leading "+" is how Power BI shows a positive variance ("+2.7%"), measured live 2026-10-11.
  const m = t.match(/^([-+])?\s*([€$£])?\s*([-+])?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%)?$/);
  if (!m) return { value: v };
  const [, sign1, cur, sign2, int, dec, pct] = m;
  let n = Number(`${int.replace(/,/g, "")}${dec ?? ""}`);
  if (sign1 === "-" || sign2 === "-") n = -n;
  const places = dec ? dec.length - 1 : 0;
  const zeros = places ? `.${"0".repeat(places)}` : "";
  if (pct) return { value: n / 100, numFmt: `0${zeros}%` };
  if (cur) return { value: n, numFmt: `${cur}#,##0${zeros}` };
  return { value: n, numFmt: `#,##0${zeros}` };
}

/** Excel sheet names: 31 chars, none of []:*?/\ , unique in the workbook. */
function sheetName(title: string, taken: Set<string>): string {
  const base = (title.replace(/[[\]:*?/\\]/g, " ").trim() || "Page").slice(0, 31);
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  taken.add(name.toLowerCase());
  return name;
}

/** Excel table names: letters, digits, underscore; start with a letter; unique. */
function tableName(title: string, taken: Set<string>): string {
  const base = `T_${title.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 40)}`;
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`;
  taken.add(name.toLowerCase());
  return name;
}

/** Table column names must be unique and non-empty. */
function headers(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c, i) => {
    const h = c.trim() || `Column ${i + 1}`;
    const n = (seen.get(h.toLowerCase()) ?? 0) + 1;
    seen.set(h.toLowerCase(), n);
    return n === 1 ? h : `${h} (${n})`;
  });
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/**
 * What a visual exports beyond what a reader wants: a conditional-colour helper ("vs Plan Color",
 * values like #0F9D8A — measured live on canvas reports) is dropped and said so; an untitled
 * column of pictures is named "Image". The agent's read_screen uses the same rule (lib/lens/agent.ts).
 */
export function tidy<V extends { columns: string[]; rows: Cell[][] }>(v: V): { visual: V; dropped: string[] } {
  const keep: number[] = [];
  const dropped: string[] = [];
  v.columns.forEach((c, i) => {
    const vals = v.rows.map((r) => r[i]).filter((x) => x !== null && x !== "");
    if (vals.length && vals.every((x) => typeof x === "string" && HEX.test(x))) dropped.push(c || `column ${i + 1}`);
    else keep.push(i);
  });
  const columns = keep.map((i) => {
    const c = v.columns[i];
    if (c.trim()) return c;
    return v.rows.length && v.rows.every((r) => r[i] === "[image]" || r[i] === null) ? "Image" : "";
  });
  return { visual: { ...v, columns, rows: v.rows.map((r) => keep.map((i) => r[i] ?? null)) }, dropped };
}

const cutLine = (v: ExportVisual) =>
  v.rows.length >= v.rowCap
    ? `${v.rows.length} rows — the export stopped at its limit of ${v.rowCap}: there may be more on screen`
    : `${v.rows.length} row${v.rows.length === 1 ? "" : "s"}, as the visual shows them`;

export async function buildWorkbook(b: ExportBundle, meta: { viewer: string; exportedAt: Date }): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "ADE Lens · Report Lens";
  wb.created = meta.exportedAt;

  const taken = new Set<string>(["index"]);
  const tables = new Set<string>();
  const index = wb.addWorksheet("Index");
  const dropped: string[] = [];
  const pages = b.pages.map((p) => ({
    ...p,
    visuals: p.visuals.map((v) => {
      const t = tidy(v);
      for (const d of t.dropped) dropped.push(`${p.title} · ${v.title}: “${d}”`);
      return t.visual;
    }),
  }));
  const sheets = pages.map((p) => ({ page: p, name: sheetName(p.title, taken) }));

  // ---- one sheet per page ---------------------------------------------------------------------
  for (const { page, name } of sheets) writePage(wb.addWorksheet(name), page, b, tables);

  // ---- the index ------------------------------------------------------------------------------
  index.columns = [{ width: 34 }, { width: 70 }, { width: 14 }, { width: 16 }];
  const bold = { bold: true };
  index.addRow([b.report]).font = { bold: true, size: 16 };
  index.addRow([b.scope === "report" ? "Every page of the report" : "The page on screen"]);
  index.addRow([]);
  const facts: Array<[string, string]> = [
    ["Exported", meta.exportedAt.toLocaleString()],
    ["As", meta.viewer || "no identity (mock / not signed in)"],
    ["Values", "As each visual shows them — aggregated, under the filters on screen"],
    ["Report filters", b.reportFilters.join("; ") || "none"],
  ];
  for (const [k, v] of facts) {
    const r = index.addRow([k, v]);
    r.getCell(1).font = bold;
  }
  index.addRow([]);
  const head = index.addRow(["Page", "Filters on the page", "Visuals", "Not exported"]);
  head.font = bold;
  for (const { page, name } of sheets) {
    const r = index.addRow(["", page.filters.join("; ") || "—", page.visuals.length, page.unread.length]);
    r.getCell(1).value = { text: page.title, hyperlink: `#'${name.replace(/'/g, "''")}'!A1` };
    r.getCell(1).font = { color: { argb: "FF1F4E9E" }, underline: true };
  }
  const unread = b.pages.flatMap((p) => p.unread.map((u) => [p.title, u] as const));
  if (unread.length) {
    index.addRow([]);
    index.addRow(["Visuals that could not be exported"]).font = bold;
    for (const [p, u] of unread) index.addRow([p, u]);
  }
  const notes = [
    ...b.notes,
    ...(dropped.length ? [`Colour-helper columns left out (hex colour codes, not data): ${dropped.join("; ")}.`] : []),
  ];
  if (notes.length) {
    index.addRow([]);
    index.addRow(["How this file was made"]).font = bold;
    for (const n of notes) index.addRow(["", n]);
  }
  index.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function writePage(ws: import("exceljs").Worksheet, page: ExportPage, b: ExportBundle, tables: Set<string>) {
  ws.addRow([page.title]).font = { bold: true, size: 14 };
  ws.addRow([`${b.report} · filters on this page: ${page.filters.join("; ") || "none"}`]).font = { italic: true, color: { argb: "FF5B6576" } };
  let row = 4;
  const widths: number[] = [];
  for (const v of page.visuals) {
    if (!v.columns.length) continue;
    ws.getCell(row, 1).value = v.title || v.type;
    ws.getCell(row, 1).font = { bold: true, size: 12 };
    ws.getCell(row + 1, 1).value = `${v.type} · ${cutLine(v)}`;
    ws.getCell(row + 1, 1).font = { italic: true, color: { argb: "FF5B6576" } };
    const parsed = v.rows.map((r) => v.columns.map((_, i) => parseCell(r[i] ?? null)));
    const top = row + 2;
    ws.addTable({
      name: tableName(`${page.title}_${v.title || v.type}`, tables),
      ref: ws.getCell(top, 1).address,
      headerRow: true,
      style: { theme: "TableStyleLight9", showRowStripes: true },
      columns: headers(v.columns).map((name) => ({ name, filterButton: true })),
      // An empty visual still gets its header row: exceljs refuses a table with no rows.
      rows: parsed.length ? parsed.map((r) => r.map((c) => c.value)) : [v.columns.map(() => null)],
    });
    parsed.forEach((r, ri) =>
      r.forEach((c, ci) => {
        if (c.numFmt) ws.getCell(top + 1 + ri, ci + 1).numFmt = c.numFmt;
      }),
    );
    v.columns.forEach((c, i) => {
      const longest = Math.max(c.length, ...v.rows.slice(0, 200).map((r) => String(r[i] ?? "").length));
      widths[i] = Math.min(60, Math.max(widths[i] ?? 10, longest + 2));
    });
    row = top + Math.max(1, parsed.length) + 3;
  }
  if (!page.visuals.length) ws.getCell(4, 1).value = "No visual on this page could be exported — see the Index for why.";
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
}

/** Hand the file to the browser. */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const exportFilename = (report: string, scope: "page" | "report", page: string | undefined, at: Date) => {
  // Local time, as the user reads the clock — not UTC.
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  const what = scope === "page" && page ? ` - ${page}` : "";
  return `${report}${what} - ${stamp}.xlsx`.replace(/[\\/:*?"<>|]/g, " ");
};
