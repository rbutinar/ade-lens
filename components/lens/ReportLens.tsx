"use client";

/**
 * Report Lens — one embedded report and an agent that sees it.
 *
 * The report, large, as a native object, with its pages as tabs the PAGE owns; beside it the
 * assistant, which knows unasked only WHERE the user is and states as fact only what a tool
 * returned. Two views over the same page:
 *   EXPERIENCE — what a user is given: the report, the assistant, one quiet line under each answer.
 *   TESTING    — what an evaluator needs: the interaction log under the report, what was recorded
 *                and as whom, and under each answer the full trail — every tool call and query.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  diffState,
  formatTs,
  makeEvent,
  type ExportScope,
  type LensAction,
  type LensCall,
  type LensEvent,
  type LensExporter,
  type LensState,
  type ReportControl,
} from "@/lib/lens/contract";
import { lensApi, type ConversationRow, type LensStatus } from "@/components/lens/api";
import { LensEmbed } from "@/components/lens/LensEmbed";
import { MockLensEmbed } from "@/components/lens/MockLensEmbed";
import { RecordingLine, useLensLog } from "@/components/lens/useLensLog";
import { Markdown } from "@/components/assistant/Markdown";
import { LENS_CATALOG } from "@/content/lens-demo";

type View = "experience" | "testing";
/** "Audit", not "Testing": what it shows is the record — the interaction log
 *  and, under each answer, every tool call and query — and that is what a reviewer audits. */
const VIEW_LABEL: Record<View, string> = { experience: "Experience", testing: "Audit" };
/** `forReport` is OUR key the token was minted for: a token still in state from the previous report
 *  must not mount the next one, or the log records a load nobody asked for. */
type Embed = { token: string; embedUrl: string; reportId: string; mock?: boolean; forReport: string };

let controlSeq = 0;
const ctl = (c: Omit<ReportControl, "seq">): ReportControl => ({ ...c, seq: ++controlSeq });

export function ReportLens() {
  const [status, setStatus] = useState<LensStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reportId, setReportId] = useState("");
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [control, setControl] = useState<ReportControl>({});
  const [state, setState] = useState<LensState | null>(null);
  const [view, setView] = useState<View>("experience");
  const log = useLensLog();
  const { record } = log;
  /** The embed's exporter (live or mock), once its report has loaded. */
  const exporter = useRef<LensExporter | null>(null);
  const [hasExporter, setHasExporter] = useState(false);
  const [exporting, setExporting] = useState<ExportScope | null>(null);
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);
  const onExporter = useCallback((x: LensExporter | null) => {
    exporter.current = x;
    setHasExporter(!!x);
  }, []);

  useEffect(() => {
    lensApi
      .status()
      .then((s) => {
        setStatus(s);
        setReportId((id) => id || s.reports[0]?.report_id || "");
      })
      .catch((e) => setStatusError(String(e instanceof Error ? e.message : e)));
  }, []);

  const report = useMemo(() => status?.reports.find((r) => r.report_id === reportId) ?? null, [status, reportId]);

  // ---- the log, stamped with report and road ------------------------------------------------
  const ctx = useRef({ reportId: "", road: "mock" as LensStatus["road"] });
  ctx.current = { reportId, road: status?.road ?? "mock" };
  const onEvent = useCallback(
    (e: Omit<LensEvent, "id" | "ts">) => record(makeEvent({ ...e, report_id: e.report_id ?? ctx.current.reportId, road: e.road ?? ctx.current.road })),
    [record],
  );

  // Events come from the CHANGE between two states, never from a repaint.
  const baseline = useRef<LensState | null>(null);
  /**
   * Changes the AGENT asked for that the report has not shown yet. The diff sees two states, never
   * who caused the change, so the "Filters in force" after an agent filter read "user". An agent action leaves its expected effect for 20 s; the first diffed event matching
   * its kind AND value is the agent's — a user click in the same seconds is not taken.
   */
  const expected = useRef<Array<{ kind: "filter" | "view"; match?: string; until: number }>>([]);
  // Opening a REPORT gets a longer window: a live embed took 36 s to land on its page (measured
  // 2026-10-11), past the 20 s that fits a filter or a page change on a report already loaded.
  const expectAgent = (kind: "filter" | "view", match?: string, ms = 20_000) =>
    expected.current.push({ kind, match, until: Date.now() + ms });
  const onState = useCallback(
    (next: LensState | null) => {
      // The baseline is NOT reset here: an unmount (or React's dev double-mount) followed by the
      // same state would otherwise log the same page view twice. It is reset when the report changes.
      if (!next) {
        setState(null);
        return;
      }
      const merged = { ...baseline.current, ...next };
      const now = Date.now();
      expected.current = expected.current.filter((x) => x.until > now);
      for (const e of diffState(baseline.current, merged)) {
        const i = expected.current.findIndex(
          (x) => x.kind === e.kind && (!x.match || `${e.label} ${e.detail ?? ""}`.includes(x.match)),
        );
        if (i >= 0) {
          e.actor = "agent";
          expected.current.splice(i, 1);
        }
        onEvent(e);
      }
      baseline.current = merged;
      setState(merged);
    },
    [onEvent],
  );

  // ---- the embed token, per report ------------------------------------------------------------
  useEffect(() => {
    if (!reportId) return;
    let live = true;
    setEmbed(null);
    setEmbedError(null);
    setState(null);
    baseline.current = null;
    lensApi
      .embedToken(reportId)
      .then((e) => live && setEmbed({ ...e, forReport: reportId }))
      .catch((e) => live && setEmbedError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, [reportId]);

  /**
   * Export what the user sees to Excel: the embed collects, lib/lens/excel builds,
   * the browser downloads. Logged with who asked for it — an export is an interaction worth keeping.
   */
  const ident = useRef({ name: "", viewer: "" });
  const runExport = useRef<(scope: ExportScope, by: "user" | "agent") => Promise<void>>(async () => {});
  runExport.current = async (scope, by) => {
    const x = exporter.current;
    if (!x) {
      setExportNote({ ok: false, text: "The report has not finished loading — nothing to export yet." });
      onEvent({ actor: "system", kind: "error", label: "Export not possible", detail: "report not loaded" });
      return;
    }
    setExporting(scope);
    setExportNote(null);
    try {
      const { buildWorkbook, download, exportFilename } = await import("@/lib/lens/excel");
      const at = new Date();
      const bundle = await x.collect(scope);
      bundle.report = ident.current.name || bundle.report || "Report";
      const blob = await buildWorkbook(bundle, { viewer: ident.current.viewer, exportedAt: at });
      download(blob, exportFilename(bundle.report, scope, bundle.pages[0]?.title, at));
      const visuals = bundle.pages.reduce((n, p) => n + p.visuals.length, 0);
      const unread = bundle.pages.reduce((n, p) => n + p.unread.length, 0);
      const label = `Exported to Excel · ${bundle.pages.length} page${bundle.pages.length === 1 ? "" : "s"}, ${visuals} visual${visuals === 1 ? "" : "s"}${unread ? `, ${unread} not exportable` : ""}`;
      onEvent({ actor: by, kind: "export", label, detail: bundle.notes.join(" · ").slice(0, 500) });
      setExportNote({ ok: true, text: `${label}.` });
    } catch (e) {
      const why = String(e instanceof Error ? e.message : e).slice(0, 300);
      onEvent({ actor: by, kind: "error", label: "Export failed", detail: why });
      setExportNote({ ok: false, text: `Export failed — ${why}` });
    } finally {
      setExporting(null);
    }
  };

  /**
   * Apply what the agent asked the REPORT to do, through the same control object the tabs use.
   * Each control is ONE request (not accumulated state): a filter does not carry the last page
   * along, so it cannot re-apply it as an agent `setPage`.
   */
  const applyActions = useCallback(
    (acts: LensAction[], by: "agent" | "user" = "agent") => {
      for (const a of acts) {
        if (a.type === "open_report") {
          onEvent({ actor: by, kind: "control", label: by === "agent" ? `Agent opened “${a.name}”` : `Reopened “${a.name}” with a saved chat`, detail: a.pageTitle ?? a.page });
          if (by === "agent") expectAgent("view", a.pageTitle, 90_000); // a resumed chat reopening it stays the user's
          setControl(ctl({ page: a.page, by }));
          setReportId(a.report_id);
          return; // anything after it belonged to the report being closed
        }
        if (a.type === "filter") {
          if (by === "agent") expectAgent("filter", a.values[0]);
          setControl(ctl({ filter: { table: a.table, column: a.column, values: a.values }, by }));
        } else if (a.type === "clear_filters") {
          if (by === "agent") expectAgent("filter");
          setControl(ctl({ filter: null, by }));
        } else if (a.type === "page") {
          if (by === "agent") expectAgent("view", a.displayName);
          setControl(ctl({ page: a.name, by }));
        } else if (a.type === "export") {
          void runExport.current(a.scope, by);
        }
      }
    },
    [onEvent],
  );

  const resume = useCallback(
    (c: { last_report_id: string; last_report_name: string; last_page?: string; last_page_title?: string }) => {
      // The chat's report AND page: "this" in its questions meant that page.
      if (c.last_report_id && c.last_report_id !== reportId) {
        applyActions(
          [{ type: "open_report", report_id: c.last_report_id, name: c.last_report_name, page: c.last_page, pageTitle: c.last_page_title }],
          "user",
        );
      } else if (c.last_page && c.last_page_title !== state?.activePage) {
        applyActions([{ type: "page", name: c.last_page, displayName: c.last_page_title ?? c.last_page }], "user");
      }
    },
    [reportId, applyActions, state?.activePage],
  );

  const pages = state?.pages ?? [];
  ident.current = { name: report?.name ?? "", viewer: log.ack?.viewer ?? "" };

  if (statusError) {
    return <p className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Report Lens is not available: {statusError}</p>;
  }

  return (
    // Full width, out of the shell's max-w-7xl: at a recording viewport (1840 px) the capped column
    // left a third of the screen empty and the report unreadable in a GIF.
    <div className="relative left-1/2 grid w-[calc(100vw-3rem)] -translate-x-1/2 gap-4 lg:grid-cols-[minmax(0,1fr)_440px]">
      <section className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">Report Lens</h1>
          <div className="flex flex-wrap gap-1.5">
            {(status?.reports ?? []).map((r) => (
              <button
                key={r.report_id}
                type="button"
                onClick={() => {
                  if (r.report_id === reportId) return;
                  // Logged, so the agent knows the USER moved: without it, its history said one
                  // report and the page another, and it "fixed" that by reopening the old one.
                  onEvent({ actor: "user", kind: "control", label: `Opened “${r.name}”`, report_id: r.report_id });
                  setControl(ctl({ by: "user" }));
                  setReportId(r.report_id);
                }}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${r.report_id === reportId ? "border-sky-600 bg-sky-600 text-white" : "border-gray-300 bg-white text-gray-700 hover:border-sky-400"}`}
              >
                {r.name}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${status?.road === "obo" || status?.road === "sp" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}
              title={
                status?.road === "obo"
                  ? "The report and the agent's queries run as you (server-side OBO). Power BI applies your row-level security."
                  : status?.road === "sp"
                    ? "A live Power BI report on shared sample data. The report and the agent's queries run with an app identity: every visitor sees the same rows."
                    : "Synthetic reports and data — no Power BI, no model."
              }
            >
              {status?.road === "obo" ? "live · as you" : status?.road === "sp" ? "live · shared data" : "mock"}
            </span>
            <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5 text-xs" role="group" aria-label="Export to Excel">
              {(["page", "report"] as ExportScope[]).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  disabled={!hasExporter || exporting !== null}
                  onClick={() => void runExport.current(sc, "user")}
                  title={sc === "page" ? "This page to Excel: what you see, aggregated as the visuals show it" : "Every page to Excel: one sheet per page, plus an index"}
                  className="rounded px-2.5 py-1 text-gray-600 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-40"
                >
                  {exporting === sc ? "Exporting…" : sc === "page" ? "⬇ Page to Excel" : "⬇ Report to Excel"}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5 text-xs" role="group" aria-label="View">
              {(["experience", "testing"] as View[]).map((v) => (
                <button key={v} type="button" onClick={() => setView(v)} className={`rounded px-2.5 py-1 ${view === v ? "bg-slate-800 text-white" : "text-gray-600"}`}>
                  {VIEW_LABEL[v]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {exportNote && (
          <p className={`mb-2 text-xs ${exportNote.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {exportNote.text}
            <button type="button" onClick={() => setExportNote(null)} className="ml-2 text-gray-400 hover:text-gray-600" aria-label="Dismiss">
              ×
            </button>
          </p>
        )}

        {pages.length > 1 && (
          <div className="mb-2 flex flex-wrap gap-1 border-b border-gray-200">
            {pages.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => setControl(ctl({ page: p.name, by: "user" }))}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${state?.activePage === p.displayName ? "border-sky-600 font-medium text-sky-700" : "border-transparent text-gray-500 hover:text-gray-800"}`}
              >
                {p.displayName}
              </button>
            ))}
          </div>
        )}

        {/* A live report page is a 16:9 canvas: the pane takes its shape, so the page fills it
            without bands above and below (seen live on canvas reports, 2026-10-11). */}
        <div
          className={`overflow-hidden rounded-lg border border-gray-200 bg-white ${
            status?.road === "obo" || status?.road === "sp" ? "aspect-video max-h-[calc(100vh-12rem)] w-full" : "h-[calc(100vh-15rem)] min-h-[560px]"
          }`}
        >
          {embedError ? (
            <div className="m-4 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              <p className="font-medium">This report did not render for you.</p>
              <p className="mt-1">{embedError}</p>
            </div>
          ) : !embed || embed.forReport !== reportId ? (
            <div className="h-full animate-pulse bg-gray-100" />
          ) : embed.mock || embed.token === "MOCK" ? (
            <MockLensEmbed key={reportId} reportId={reportId} control={control} onState={onState} onEvent={onEvent} onExporter={onExporter} />
          ) : (
            <LensEmbed key={reportId} embed={embed} control={control} onState={onState} onEvent={onEvent} onExporter={onExporter} />
          )}
        </div>

        {view === "testing" && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-gray-900">
              Interaction log · {log.events.length} event{log.events.length === 1 ? "" : "s"}
            </h2>
            <div className="mt-1">
              <RecordingLine {...log} />
            </div>
            <ol className="mt-3 max-h-72 space-y-1 overflow-auto font-mono text-[11px]">
              {[...log.events].reverse().map((e) => (
                <li key={e.id} className={`flex gap-2 ${e.kind === "error" ? "text-rose-700" : "text-gray-700"}`}>
                  <span className="text-gray-400">{formatTs(e.ts)}</span>
                  <span className={`w-12 shrink-0 font-semibold ${e.actor === "agent" ? "text-violet-700" : e.actor === "user" ? "text-sky-700" : "text-gray-500"}`}>{e.actor}</span>
                  <span>{e.label}</span>
                  {e.detail && <span className="truncate text-gray-500">{e.detail}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <aside className="h-[calc(100vh-10rem)] min-h-[620px] lg:sticky lg:top-4">
        <LensAgent
          status={status}
          reportId={reportId}
          reportName={report?.name ?? ""}
          state={state}
          events={log.events}
          onEvent={onEvent}
          view={view}
          onActions={applyActions}
          onResume={resume}
          embedStatus={
            embedError
              ? { embedStatus: "failed", embedError }
              : state?.activePage
                ? { embedStatus: "ready" }
                : { embedStatus: "loading" }
          }
        />
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// the agent panel
// ---------------------------------------------------------------------------------------------

interface Msg {
  role: "user" | "agent";
  text: string;
  trail?: string[];
  calls?: LensCall[];
  failed?: boolean;
}

/** Each one verified on its road: the "where" chip names a topic that lives in ANOTHER report there. */
const STARTERS: Record<"mock" | "obo" | "sp", string[]> = {
  mock: [
    "What am I looking at on this page?",
    "Which other reports cover what I'm looking at?",
    "Where can I see late orders by store? Open it there.",
    "Which measures does this model offer?",
  ],
  obo: [
    "What am I looking at on this page?",
    "Which other reports cover what I'm looking at?",
    "Which page shows this by month? Open it there.",
    "Which measures does this model offer, and which tables matter most?",
  ],
  // An app road (a plane with shared sample data): a factual question first, then the moves.
  sp: [
    "Total Revenue by country: which one leads?",
    "What am I looking at on this page?",
    "Which page shows this by month? Open it there.",
    "Which other reports cover what I'm looking at?",
  ],
};

function LensAgent({
  status,
  reportId,
  reportName,
  state,
  events,
  onEvent,
  view,
  onActions,
  onResume,
  embedStatus,
}: {
  status: LensStatus | null;
  reportId: string;
  reportName: string;
  state: LensState | null;
  events: LensEvent[];
  onEvent: (e: Omit<LensEvent, "id" | "ts">) => void;
  view: View;
  onActions: (a: LensAction[]) => void;
  onResume: (c: { last_report_id: string; last_report_name: string; last_page?: string; last_page_title?: string }) => void;
  embedStatus: Pick<LensState, "embedStatus" | "embedError">;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [conv, setConv] = useState<string | null>(null);
  const [threads, setThreads] = useState<ConversationRow[]>([]);
  const [history, setHistory] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);

  const refreshThreads = useCallback(() => {
    lensApi.conversations().then(setThreads).catch(() => {});
  }, []);
  useEffect(() => refreshThreads(), [refreshThreads]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [msgs, thinking]);

  const ready = status?.agent.kind === "mock" || status?.agent.kind === "model";
  const starters = [...STARTERS[status?.road ?? "mock"], ...(LENS_CATALOG.find((r) => r.report_id === reportId)?.suggestions ?? [])];
  const sees = [
    reportName || "no report",
    state?.activePage ? `page “${state.activePage}”` : null,
    state?.filters?.length ? `${state.filters.length} filter${state.filters.length === 1 ? "" : "s"}: ${state.filters.join("; ")}` : "no filters",
    state?.selection?.length ? `selected ${state.selection.join("; ")}` : null,
    state?.visibleData?.length ? `${state.visibleData.length} visual(s) readable` : null,
  ].filter(Boolean) as string[];

  const send = (question: string) => {
    if (!ready || thinking || !reportId) return;
    // An earlier answer goes back WITH the calls behind it. Text alone made the model disown its own
    // figures — "I quoted 39 before actually querying the model" — when the DAX had run (measured
    // live 2026-10-11): the rule "never state a figure you did not get from a tool" met a history
    // in which no tool appeared.
    const hist = msgs
      .filter((m) => !m.failed)
      .map((m) =>
        m.role === "user"
          ? { role: "user" as const, text: m.text }
          : {
              role: "assistant" as const,
              text:
                (m.calls?.length
                  ? `[tool calls behind this answer: ${m.calls
                      .map((c) => `${c.tool}(${JSON.stringify(c.arguments).slice(0, 200)}) → ${JSON.stringify(c.result).slice(0, 240)}`)
                      .join(" ; ")}]\n\n`
                  : "") + m.text,
            },
      );
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setThinking(true);
    onEvent({ actor: "user", kind: "ask", label: question.slice(0, 200) });
    // What the USER did to the report — not the Q&A (already in history), not system noise.
    const interactions = events
      .filter((e) => e.actor === "user" && e.kind !== "ask")
      .slice(-12)
      .map((e) => ({ label: e.label, detail: e.detail }));
    lensApi
      .ask({ question, history: hist, report_id: reportId, context: { ...(state ?? {}), ...embedStatus }, interactions, conversation_id: conv })
      .then((r) => {
        setConv(r.conversationId ?? conv);
        refreshThreads();
        setMsgs((m) => [...m, { role: "agent", text: r.text, trail: r.trail, calls: r.calls }]);
        if (r.saveError) {
          setMsgs((m) => [...m, { role: "agent", failed: true, text: `This answer was not saved to the chat history: ${r.saveError}` }]);
          onEvent({ actor: "system", kind: "error", label: "Chat turn not saved", detail: r.saveError });
        }
        for (const c of r.calls.filter((x) => x.tool === "run_dax")) {
          onEvent({ actor: "agent", kind: "query", label: "DAX query as the user", detail: String((c.arguments as { query?: string }).query ?? "").slice(0, 500) });
        }
        onEvent({ actor: "agent", kind: "answer", label: `Answered · ${r.calls.length} tool call(s)`, detail: r.text.slice(0, 500) });
        if (r.actions.length) onActions(r.actions);
      })
      .catch((e) => {
        setMsgs((m) => [...m, { role: "agent", failed: true, text: `The agent could not answer: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` }]);
        onEvent({ actor: "system", kind: "error", label: "Agent call failed", detail: String(e).slice(0, 300) });
      })
      .finally(() => setThinking(false));
  };

  const openThread = async (t: ConversationRow) => {
    if (thinking) return;
    try {
      const c = await lensApi.conversation(t.conversation_id);
      setMsgs(c.turns.flatMap((x) => [{ role: "user" as const, text: x.question }, { role: "agent" as const, text: x.answer, trail: x.trail, calls: x.calls }]));
      setConv(c.conversation_id);
      setHistory(false);
      // Resuming a chat brings back the report it was about — "this" in its questions meant THAT one.
      onResume(c);
    } catch {
      /* deleted under us */
    }
  };

  const fresh = () => {
    setMsgs([]);
    setConv(null);
    setHistory(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="flex items-start justify-between gap-2 border-b border-gray-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">✨ Report Assistant</h2>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-500">Sees: {sees.join(" · ")}</p>
          {view === "testing" && status && (
            <p className="mt-0.5 text-[11px] text-gray-500">
              Agent: {status.agent.kind} — {status.agent.detail} · catalogue: {status.catalogue}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button type="button" title="Saved chats" onClick={() => { setHistory((v) => !v); refreshThreads(); }} className={`rounded px-1.5 py-1 text-sm ${history ? "bg-slate-200" : "hover:bg-slate-100"}`}>
            🕘
          </button>
          <button type="button" title="New conversation" onClick={fresh} className="rounded px-1.5 py-1 text-sm hover:bg-slate-100">
            ↻
          </button>
        </div>
      </div>

      {history ? (
        <div className="flex-1 overflow-auto p-3">
          <div className="mb-2 flex items-center justify-between">
            <strong className="text-sm text-gray-800">Saved chats</strong>
            <button type="button" onClick={fresh} className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-slate-50">
              + New chat
            </button>
          </div>
          {threads.length === 0 && <p className="text-xs text-gray-500">No saved chats yet. Ask something and it is kept here.</p>}
          <ul className="space-y-1">
            {threads.map((t) => (
              <li key={t.conversation_id} className={`flex items-center gap-1 rounded ${t.conversation_id === conv ? "bg-sky-50" : ""}`}>
                <button type="button" disabled={thinking} onClick={() => void openThread(t)} className="min-w-0 flex-1 px-2 py-1.5 text-left hover:bg-slate-50">
                  <span className="block truncate text-sm text-gray-800">{t.title || "(empty)"}</span>
                  <span className="block text-[11px] text-gray-500">
                    {t.last_report_name || "no report"}
                    {t.last_page_title ? ` › ${t.last_page_title}` : ""} · {new Date(t.last_at).toLocaleString()} · {t.turns} turn{t.turns === 1 ? "" : "s"}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Delete chat"
                  disabled={thinking}
                  onClick={async () => {
                    await lensApi.deleteConversation(t.conversation_id);
                    if (conv === t.conversation_id) fresh();
                    refreshThreads();
                  }}
                  className="px-2 text-gray-400 hover:text-rose-600"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div ref={scroll} className="flex-1 space-y-3 overflow-auto p-3 text-sm">
          <div className="rounded-lg bg-slate-50 p-3 text-gray-700">
            {ready
              ? "Ask about this report. Figures come from the visuals or from its model, queried as you — every call is in the trail. I can also filter it, change page, or open the report that covers what you need."
              : `The assistant is not available: ${status?.agent.detail ?? "…"}`}
            {ready && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {starters.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-sky-200 bg-white px-2.5 py-1 text-left text-xs text-sky-800 hover:bg-sky-50">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-8 rounded-lg bg-sky-600 px-3 py-2 text-white">
                {m.text}
              </div>
            ) : (
              <div key={i} className="mr-4">
                {!m.failed && (
                  <span
                    className="mb-1 inline-block rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                    title="A model (or, in mock, a template) wrote the sentence. Every figure is the return value of a tool call — the rows on screen, or a query against the report's model run as you."
                  >
                    ✨ {status?.agent.kind === "mock" ? "Mock planner" : "Model"}, grounded in the report
                  </span>
                )}
                <div className={`rounded-lg border px-3 py-2 ${m.failed ? "border-rose-200 bg-rose-50 text-rose-800" : "border-gray-200 bg-white text-gray-800"}`}>
                  <Markdown>{m.text}</Markdown>
                </div>
                {view === "experience" && !m.failed && (
                  <p className="mt-1 text-[10px] text-gray-400">
                    {m.calls?.length ?? 0} tool call{m.calls?.length === 1 ? "" : "s"} · grounded
                  </p>
                )}
                {view === "testing" && !!m.trail?.length && (
                  <details open className="mt-1 rounded border border-gray-200 bg-slate-50 p-2 text-[11px] text-gray-700">
                    <summary className="cursor-pointer font-medium">{m.calls?.length ?? 0} tool call{m.calls?.length === 1 ? "" : "s"} · provenance</summary>
                    <ul className="mt-1 list-disc pl-4">
                      {m.trail.map((t, j) => (
                        <li key={j}>{t}</li>
                      ))}
                    </ul>
                    {m.calls?.map((c, j) => (
                      <div key={j} className="mt-2">
                        <div className="font-mono font-semibold text-slate-800">
                          {c.tool}({c.tool === "run_dax" ? "" : Object.keys(c.arguments ?? {}).length ? JSON.stringify(c.arguments) : ""})
                        </div>
                        {c.tool === "run_dax" && <pre className="mt-0.5 whitespace-pre-wrap rounded bg-slate-800 p-1.5 text-[10px] text-slate-100">{String((c.arguments as { query?: string }).query ?? "")}</pre>}
                        <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-1.5 text-[10px]">{JSON.stringify(c.result, null, 1)}</pre>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ),
          )}
          {thinking && <p className="text-xs text-gray-500">✨ Reading the report…</p>}
        </div>
      )}

      <div className="flex gap-2 border-t border-gray-200 p-3">
        <textarea
          rows={1}
          value={draft}
          disabled={!ready}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const q = draft.trim();
              if (q) {
                setDraft("");
                send(q);
              }
            }
          }}
          placeholder="Ask about this report…"
          className="flex-1 resize-none rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-sky-500 focus:outline-none"
        />
        <button
          type="button"
          disabled={thinking || !ready}
          onClick={() => {
            const q = draft.trim();
            if (q) {
              setDraft("");
              send(q);
            }
          }}
          className="rounded-md bg-sky-600 px-3 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
