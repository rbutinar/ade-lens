import { NextResponse } from "next/server";
import { lensReports } from "@/lib/lens/catalog";
import { storeInfo } from "@/lib/lens/store";
import { pbiRoad } from "@/lib/powerbi/access";
import { plane } from "@/lib/lens/plane";

const MOCK = process.env.LENS_MOCK !== "0";

// Read at request time: prerendered at build, the status froze the build's env and store state.
export const dynamic = "force-dynamic";

/**
 * Report Lens status, in one read: which road the page is on, whether the agent is a model or the
 * mock planner, where the log is kept, and the reports the page can embed. Each state is said, not
 * implied — "off" is an answer the page renders.
 */
export async function GET() {
  const store = await storeInfo();
  const agent = MOCK
    ? { kind: "mock", detail: "mock planner over synthetic models (LENS_MOCK is not 0)" }
    : process.env.ANTHROPIC_API_KEY
      ? { kind: "model", detail: process.env.LENS_AGENT_MODEL ?? "claude-opus-5" }
      : { kind: "off", detail: "LENS_MOCK=0 but ANTHROPIC_API_KEY is not set" };
  return NextResponse.json({
    road: MOCK ? "mock" : pbiRoad(),
    agent,
    log: { recording: store.ok, store: store.kind, backend: store.backend },
    // A plane may rule the Databricks catalogue out (lib/lens/catalog `databricksConfig`).
    catalogue: process.env.LENS_CATALOG_WAREHOUSE_ID && !MOCK && plane.databricksCatalogue ? "databricks" : "file",
    reports: lensReports().map((r) => ({ report_id: r.report_id, name: r.name, module: r.module })),
  });
}
