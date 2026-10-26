"use client";

/**
 * A synthetic report in place of the Power BI embed, for mock mode.
 *
 * Same props and same behaviour contract as `LensEmbed`: it takes the control object (page,
 * filter, by whom), applies it, logs whether it was accepted, and publishes the state the agent
 * reads — pages, active page, filters, selection and the rows the visuals render — computed by
 * the mock engine over content/lens-demo.ts. Labelled MOCK on screen at all times: a simulation
 * must never pass for a working embed in a screenshot.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { resolvePage, type LensEvent, type LensExporter, type LensState, type ReportControl } from "@/lib/lens/contract";
import { evaluate, mockModel, type Filter } from "@/lib/lens/mock-engine";
import { LENS_CATALOG } from "@/content/lens-demo";

// Read from the content directly, not lib/lens/catalog: that module is server-side (Databricks, OBO).
const lensReport = (id: string) => LENS_CATALOG.find((r) => r.report_id === id);

interface Props {
  reportId: string;
  control: ReportControl;
  onState: (s: LensState | null) => void;
  onEvent: (e: Omit<LensEvent, "id" | "ts">) => void;
  onExporter?: (x: LensExporter | null) => void;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function MockLensEmbed({ reportId, control, onState, onEvent, onExporter }: Props) {
  const report = lensReport(reportId);
  const model = mockModel(reportId);
  const pages = useMemo(() => (report?.pages ?? []).map((p) => ({ name: p.page, displayName: p.title })), [report]);
  const [page, setPage] = useState(() => resolvePage(pages, control.page)?.name ?? pages[0]?.name);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const applied = useRef("");

  // Once per mount, even under React's dev double-invocation of effects (refs survive it).
  const announced = useRef(false);
  useEffect(() => {
    if (!announced.current) {
      announced.current = true;
      onEvent({ actor: "system", kind: "load", label: "Report loaded (mock)" });
    }
    return () => onState(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the control, applied as the real embed would, with the same log lines -----------------
  useEffect(() => {
    const key = JSON.stringify(control);
    if (key === applied.current) return;
    applied.current = key;
    const by = control.by ?? "user";
    if (control.page) {
      const hit = resolvePage(pages, control.page);
      if (!hit) onEvent({ actor: by, kind: "error", label: "page not found in this report", detail: control.page });
      else {
        setPage(hit.name);
        setSelection([]);
        onEvent({ actor: by, kind: "control", label: "setPage accepted — no reload", detail: hit.displayName });
      }
    }
    if (control.filter !== undefined && model) {
      if (control.filter?.values.length) {
        const ok = control.filter.table === model.table && control.filter.column in model.dims;
        if (!ok) {
          onEvent({ actor: by, kind: "error", label: "filter call refused", detail: `${control.filter.table}[${control.filter.column}] is not in the model` });
        } else {
          setFilter({ column: control.filter.column, values: control.filter.values });
          onEvent({ actor: by, kind: "control", label: "updateFilters accepted", detail: `${model.table}[${control.filter.column}] In ${control.filter.values.join(", ")}` });
        }
      } else {
        setFilter(null);
        onEvent({ actor: by, kind: "control", label: "filters removed" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control]);

  const spec = report?.pages.find((p) => p.page === page);
  const visuals = useMemo(() => {
    if (!model || !spec?.visuals) return [];
    return spec.visuals.map((v) => ({ ...v, rows: evaluate(model, v.measure, v.dim, filter ? [filter] : []) }));
  }, [model, spec, filter]);

  // ---- the exporter: the same synthetic visuals the screen draws, for one page or all ----------
  useEffect(() => {
    if (!model || !report) return;
    onExporter?.({
      collect: async (scope) => {
        const shown = scope === "page" ? report.pages.filter((p) => p.page === page) : report.pages;
        const filters = filter ? [`${model.table}[${filter.column}] In ${filter.values.join(", ")}`] : [];
        return {
          report: report.name,
          scope,
          reportFilters: filters,
          notes: ["MOCK report — synthetic data computed in the browser, not exported from Power BI."],
          pages: shown.map((p) => ({
            title: p.title,
            filters: [],
            unread: [],
            visuals: (p.visuals ?? []).map((v) => ({
              title: v.title,
              type: "bar (mock)",
              columns: [v.dim, v.measure],
              rows: evaluate(model, v.measure, v.dim, filter ? [filter] : []).map((r) => [String(r[v.dim]), Number(r[v.measure])]),
              rowCap: 30000,
            })),
          })),
        };
      },
    });
    return () => onExporter?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, report, page, filter]);

  // ---- publish what is on screen ----------------------------------------------------------------
  useEffect(() => {
    if (!model) return;
    onState({
      activePage: spec?.title,
      pages,
      filters: filter ? [`${model.table}[${filter.column}] In ${filter.values.join(", ")}`] : [],
      selection,
      visibleData: visuals.map((v) => ({
        title: v.title,
        columns: [v.dim, v.measure],
        rows: v.rows.slice(0, 100).map((r) => [String(r[v.dim]), Number(r[v.measure])]),
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec?.title, filter, selection, visuals]);

  if (!report || !model) {
    return <div className="grid h-full place-items-center text-sm text-gray-500">No synthetic model for this report.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 bg-slate-50 px-4 py-2 text-xs text-gray-500">
        <span>
          {report.name} · {spec?.title}
          {filter && <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-sky-700">{filter.column}: {filter.values.join(", ")}</span>}
        </span>
        <span className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-700">MOCK report · synthetic data</span>
      </div>
      <div className="grid flex-1 gap-4 overflow-auto p-4 md:grid-cols-2">
        {visuals.map((v) => {
          const max = Math.max(1, ...v.rows.map((r) => Number(r[v.measure])));
          return (
            <div key={v.title} className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="mb-3 text-sm font-semibold text-gray-800">{v.title}</p>
              <ul className="space-y-1.5">
                {v.rows.map((r) => {
                  const label = String(r[v.dim]);
                  const sel = `${v.dim} = ${label}`;
                  const on = selection.includes(sel);
                  return (
                    <li key={label}>
                      <button
                        type="button"
                        onClick={() => setSelection(on ? [] : [sel])}
                        className={`group flex w-full items-center gap-2 text-left text-xs ${on ? "font-semibold" : ""}`}
                      >
                        <span className="w-36 shrink-0 truncate text-gray-600">{label}</span>
                        <span className="relative h-4 flex-1 rounded bg-slate-100">
                          <span
                            className={`absolute inset-y-0 left-0 rounded ${on ? "bg-sky-600" : "bg-sky-400 group-hover:bg-sky-500"}`}
                            style={{ width: `${(Number(r[v.measure]) / max) * 100}%` }}
                          />
                        </span>
                        <span className="w-20 shrink-0 text-right tabular-nums text-gray-700">{fmt(Number(r[v.measure]))}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
