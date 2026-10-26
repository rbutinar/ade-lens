import type { QueryResult } from "@/lib/adapters/types";

/**
 * Power BI REST calls made UNDER THE USER'S identity (the OBO token from
 * lib/auth/entra). Uses only fetch (no SDK), so it is safe on the server runtime.
 */

const BASE = "https://api.powerbi.com/v1.0/myorg";

export interface EmbedResult {
  token: string;
  embedUrl: string;
  reportId: string;
  expiration: string;
}

export interface ReportBinding {
  workspaceId: string;
  reportId: string;
  datasetId?: string;
}

/**
 * Mint a per-user embed token for a report. The user's OBO token authorizes the
 * call, so access + RLS are the user's own. Returns an Embed-type token.
 */
export async function generateEmbedToken(
  powerBiToken: string,
  binding: ReportBinding,
): Promise<EmbedResult> {
  const auth = { Authorization: `Bearer ${powerBiToken}` };

  const reportRes = await fetch(
    `${BASE}/groups/${binding.workspaceId}/reports/${binding.reportId}`,
    { headers: auth },
  );
  if (!reportRes.ok) {
    throw new Error(`report fetch failed ${await pbiFailure(reportRes)}`);
  }
  const report = (await reportRes.json()) as { embedUrl: string };

  const tokenRes = await fetch(
    `${BASE}/groups/${binding.workspaceId}/reports/${binding.reportId}/GenerateToken`,
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ accessLevel: "View" }),
    },
  );
  if (!tokenRes.ok) {
    throw new Error(`GenerateToken failed ${await pbiFailure(tokenRes)}`);
  }
  const tok = (await tokenRes.json()) as { token: string; expiration: string };

  return {
    token: tok.token,
    embedUrl: report.embedUrl,
    reportId: binding.reportId,
    expiration: tok.expiration,
  };
}

/** Run a DAX query via executeQueries under the user's OBO token. */
export async function executeDax(
  powerBiToken: string,
  datasetId: string,
  dax: string,
): Promise<QueryResult> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/executeQueries`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${powerBiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      queries: [{ query: dax }],
      serializerSettings: { includeNulls: true },
    }),
  });
  if (!res.ok) {
    const detail = extractPbiError(await res.text().catch(() => ""));
    return { error: `executeQueries failed (${res.status})${detail ? `: ${detail}` : ""}` };
  }

  const data = (await res.json()) as {
    results?: Array<{ tables?: Array<{ rows?: Array<Record<string, unknown>> }> }>;
  };
  const table = data.results?.[0]?.tables?.[0];
  if (!table) return { error: "executeQueries returned no table" };

  const sample = table.rows?.[0] ?? {};
  const rawCols = Object.keys(sample);
  const columns = rawCols.map(cleanColumnName);
  const rows = (table.rows ?? []).map((r) =>
    rawCols.map((c) => r[c] as string | number | null),
  );
  return { columns, rows };
}

/**
 * executeQueries returns column keys bracketed — `table[col]` for group-by columns,
 * `[Measure Name]` for named expressions. Reduce to the leaf name (`col` /
 * `Measure Name`) so Vega-Lite encodings can reference a clean field and real-mode
 * columns match the mock convention.
 */
function cleanColumnName(raw: string): string {
  const m = raw.match(/\[([^\]]*)\]\s*$/);
  return m ? m[1] : raw;
}

/**
 * Why a Power BI REST call failed, not just that it did. The status alone cannot
 * tell "this identity is not a Power BI user" from "no access to this workspace"
 * from "the token expired" — all three arrive as 401. Power BI puts the
 * discriminator in the `x-powerbi-error-info` header (e.g.
 * PowerBINotAuthorizedException) and a RequestId for support; the body carries the
 * human-readable reason. A bare `(401)` is unactionable — it was unclear whether a
 * NEW user failing to render a report was a lens bug or a licence/access gap.
 */
async function pbiFailure(res: Response): Promise<string> {
  const code = res.headers.get("x-powerbi-error-info") ?? "";
  const requestId =
    res.headers.get("requestid") ?? res.headers.get("x-ms-request-id") ?? "";
  const detail = extractPbiError(await res.text().catch(() => ""));
  const parts = [code, detail, requestId && `RequestId ${requestId}`].filter(Boolean);
  return `(${res.status})${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

/**
 * Pull the human-readable reason out of a Power BI REST error body so a failing
 * query reports WHY (e.g. an unknown measure/column or a DAX syntax error),
 * not just the HTTP status. Falls back to the raw (truncated) body.
 */
function extractPbiError(body: string): string {
  if (!body) return "";
  try {
    const j = JSON.parse(body) as {
      error?: {
        message?: string;
        "pbi.error"?: { details?: Array<{ detail?: { value?: string } }> };
      };
    };
    const details = (j.error?.["pbi.error"]?.details ?? [])
      .map((d) => d.detail?.value)
      .filter((v): v is string => Boolean(v))
      .join("; ");
    return details || j.error?.message || body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}
