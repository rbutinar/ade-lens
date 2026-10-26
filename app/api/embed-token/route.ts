import { NextResponse } from "next/server";
import { lensReport } from "@/lib/lens/catalog";
import { plane } from "@/lib/lens/plane";
import { allowBinding, pbiRoad, powerBiToken, PbiAccessError } from "@/lib/powerbi/access";

const MOCK = process.env.LENS_MOCK !== "0";

/**
 * Token broker (the BFF seam). The browser never holds a Power BI secret; it
 * asks the server for a scoped embed token.
 *
 * - Mock (default): returns a MOCK token → the report renders a placeholder.
 * - Real (LENS_MOCK=0): reads the user's api-scoped bearer, does the OBO
 *   exchange for a Power BI token, and mints a per-user embed token (RLS applies
 *   under the user's identity). See docs/entra-setup.md.
 * - An app road, when the deployment's plane has one (lib/lens/plane.ts): the plane mints the
 *   token, for a binding it allows only (lib/powerbi/access.ts).
 */
export async function POST(req: Request) {
  const { reportId } = await req.json().catch(() => ({ reportId: undefined }));
  // The plane's own reports first (lib/lens/plane.ts), then the Report Lens catalogue. Either way
  // the browser names a KEY we own, never a workspace/report id — "open" cannot be steered at
  // arbitrary items. A plane with a closed set has already narrowed both.
  const extra = reportId ? plane.extraReport(reportId) : undefined;
  const lens = reportId && !extra ? lensReport(reportId) : undefined;
  const binding = extra?.binding ?? lens?.binding;
  if (!extra && !lens) {
    return NextResponse.json({ error: "unknown report" }, { status: 404 });
  }

  if (MOCK) {
    return NextResponse.json({
      token: "MOCK",
      tokenType: "Embed",
      embedUrl: binding
        ? `https://app.powerbi.com/reportEmbed?reportId=${binding.reportId}&groupId=${binding.workspaceId}`
        : "",
      reportId: binding?.reportId ?? reportId,
      expiresIn: 3600,
      mock: true,
    });
  }

  if (!binding) {
    return NextResponse.json(
      {
        error: "report not bound",
        hint: "This catalogue entry has no Power BI report behind it yet — it exists only as synthetic demo content (content/lens-demo.ts).",
      },
      { status: 404 },
    );
  }
  const report = { binding };

  if (!allowBinding(report.binding)) {
    return NextResponse.json({ error: "unknown report" }, { status: 404 });
  }
  try {
    const { generateEmbedToken } = await import("@/lib/powerbi/embed");
    const pbiToken = await powerBiToken(bearer(req));
    const embed = await generateEmbedToken(pbiToken, {
      workspaceId: report.binding.workspaceId,
      reportId: report.binding.reportId,
      datasetId: report.binding.datasetId,
    });
    return NextResponse.json({
      token: embed.token,
      tokenType: "Embed",
      embedUrl: embed.embedUrl,
      reportId: embed.reportId,
      expiration: embed.expiration,
      mock: false,
    });
  } catch (e) {
    if (e instanceof PbiAccessError) {
      return NextResponse.json(
        { error: e.message, hint: e.hint ?? embedFailureHint(e.message) },
        { status: e.status },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    if (pbiRoad() === "sp") {
      // A visitor of an app road gets no tenant-side diagnostics; we keep them in the logs.
      console.error(`[embed-token] ${message}`);
      return NextResponse.json({ error: "the report is not reachable right now" }, { status: 503 });
    }
    return NextResponse.json(
      { error: `embed-token failed: ${message}`, hint: embedFailureHint(message) },
      { status: 500 },
    );
  }
}

/**
 * Turn an engine refusal into the one thing that can actually be acted on. A new
 * identity opening a certified report fails at the ENGINE, not in our app, and the
 * honest answer names which side owes the fix — a Power BI licence / workspace
 * membership, never an app-side workaround (access is granted at the engine, per
 * docs/security.md).
 */
function embedFailureHint(message: string): string | undefined {
  if (/PowerBINotAuthorizedException/i.test(message)) {
    return "This identity is authenticated but is not a Power BI user in the tenant: it needs a Power BI licence (Pro/PPU, or a workspace on Fabric/Premium capacity) before any report can render.";
  }
  if (/TokenExpired/i.test(message)) {
    return "The signed-in session expired. Sign out and sign in again.";
  }
  if (/\(401\)/.test(message)) {
    return "Power BI rejected the signed-in identity. Check it has a Power BI licence and — if it is a guest from another tenant — that the tenant allows external guests in Power BI.";
  }
  if (/\(403\)/.test(message)) {
    return "The identity is a Power BI user but is not allowed on this item. Grant it access to the workspace holding the report (Viewer is enough).";
  }
  if (/\(404\)/.test(message)) {
    return "The report was not found for this identity — either the binding in content/catalog.config.ts is stale, or the identity cannot see the workspace at all.";
  }
  return undefined;
}

function bearer(req: Request): string | null {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
