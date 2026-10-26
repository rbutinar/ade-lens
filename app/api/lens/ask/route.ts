import { NextResponse } from "next/server";
import type { LensState } from "@/lib/lens/contract";
import { answerWithModel, type AskInput } from "@/lib/lens/agent";
import { answerMock } from "@/lib/lens/mock-agent";
import { lensReport } from "@/lib/lens/catalog";
import { datasetOf, mockAccess, realAccess, type ModelAccess } from "@/lib/lens/model";
import { lensStore, viewerOf } from "@/lib/lens/store";
import { allowBinding, pbiRoad, powerBiToken } from "@/lib/powerbi/access";
import { plane } from "@/lib/lens/plane";

const MOCK = process.env.LENS_MOCK !== "0";

/**
 * One question to the Report Lens agent. The page sends where the user is (report, page, filters,
 * selection, what they did); the model is reached as the user, for this request only — the OBO
 * token is never stored or logged. The turn is recorded under the viewer the SERVER resolves.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    question?: string;
    history?: AskInput["history"];
    report_id?: string;
    context?: LensState;
    interactions?: AskInput["interactions"];
    conversation_id?: string | null;
  };
  const question = (body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });
  const report = body.report_id ? lensReport(body.report_id) : undefined;
  if (!report) return NextResponse.json({ error: "unknown report" }, { status: 404 });

  // The plane admits the question BEFORE anything runs (lib/lens/plane.ts): a cap is an answer the
  // panel shows, not an error; a missing sign-in is.
  const meter = await plane.question(req);
  if (meter.refused) {
    const r = meter.refused;
    if (r.status) return NextResponse.json({ error: r.reason }, { status: r.status });
    return NextResponse.json({ text: r.text ?? r.reason, actions: [], calls: [], trail: [], capped: r.reason });
  }

  const assertion = bearer(req) ?? undefined;
  let access: ModelAccess | null = null;
  let modelWhy: string | undefined;
  if (MOCK) {
    access = mockAccess(report.report_id);
    if (!access) modelWhy = "this report has no synthetic model";
  } else if (!report.binding) {
    modelWhy = "the catalogue entry has no Power BI report behind it";
  } else if (!allowBinding(report.binding)) {
    modelWhy = "this report is outside what this deployment may open";
  } else if (!assertion && pbiRoad() === "obo") {
    modelWhy = "you are not signed in, so the model cannot be queried as you";
  } else {
    try {
      const token = await powerBiToken(assertion);
      const datasetId = report.binding.datasetId ?? (await datasetOf(report.binding, token));
      // The dataset Power BI names for the report must itself be allowed (an app road's second wall).
      if (!allowBinding({ ...report.binding, datasetId })) throw new Error("dataset outside what this deployment may open");
      access = realAccess(datasetId, token, pbiRoad());
    } catch (e) {
      modelWhy = `the model could not be reached: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
    }
  }

  const input: AskInput = {
    question,
    history: (body.history ?? []).slice(-8),
    reportId: report.report_id,
    context: body.context ?? {},
    interactions: (body.interactions ?? []).slice(-12),
    access,
    modelWhy,
    userAssertion: assertion,
    onUsage: (model, usage) => meter.onUsage(model, usage),
  };

  try {
    let answer;
    if (MOCK) answer = await answerMock(input, report.name);
    else if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "LENS_MOCK=0 but ANTHROPIC_API_KEY is not set" }, { status: 503 });
    } else {
      try {
        answer = await answerWithModel(input, report.name);
      } finally {
        await meter.settle();
      }
    }

    // Record the turn against the report the user is on AFTER it: a turn that opened a report
    // recorded against the one it left made resume open the wrong one.
    const opened = answer.actions.find((a) => a.type === "open_report");
    // …and on the page it is on after the turn: one the turn opened or moved to, else the one in view.
    const moved = [...answer.actions].reverse().find((a) => a.type === "page");
    const inView = (body.context?.pages ?? []).find((p) => p.displayName === body.context?.activePage);
    const after =
      opened && opened.type === "open_report"
        ? { id: opened.report_id, name: opened.name, page: opened.page, pageTitle: opened.pageTitle }
        : moved && moved.type === "page"
          ? { id: report.report_id, name: report.name, page: moved.name, pageTitle: moved.displayName }
          : { id: report.report_id, name: report.name, page: inView?.name, pageTitle: inView?.displayName };
    // The answer is the user's whether or not it could be saved: a store that fails costs the
    // chat its memory, never the reply — and the page is told, so it does not look saved.
    try {
      const conv = await (await lensStore()).appendTurn(
        await viewerOf(req),
        body.conversation_id ?? null,
        { question, answer: answer.text, trail: answer.trail, calls: answer.calls, at: Date.now() },
        after,
      );
      return NextResponse.json({ ...answer, conversationId: conv.conversation_id });
    } catch (e) {
      return NextResponse.json({ ...answer, saveError: String(e instanceof Error ? e.message : e).slice(0, 300) });
    }
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e).slice(0, 400) }, { status: 500 });
  }
}

function bearer(req: Request): string | null {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
