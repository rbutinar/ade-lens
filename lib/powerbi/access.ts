import { plane } from "@/lib/lens/plane";
import type { PbiRoad } from "@/lib/lens/plane-contract";

export type { PbiRoad };

/**
 * THE one road to a Power BI token. Every Power BI call of the app goes through here:
 * /api/embed-token, /api/lens/ask and the model access of lib/lens/model.ts.
 *
 *  - OBO (default, user-owns-data): the browser's api-scoped bearer is exchanged On-Behalf-Of for
 *    a Power BI token AS THE USER, so the engine applies the user's RLS (docs/security.md).
 *  - An app road ("sp"), only when the deployment's plane has one (lib/lens/plane.ts): the plane
 *    mints the token and bounds what it may reach (`allowBinding`). The browser's bearer is ignored.
 */

export function pbiRoad(): PbiRoad {
  return plane.road();
}

export class PbiAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * A Power BI access token for this request. `assertion` is the browser's bearer (OBO road); the app
 * road does not read it. Throws PbiAccessError with an HTTP status the route can return as is.
 */
export async function powerBiToken(assertion?: string | null): Promise<string> {
  if (pbiRoad() === "sp") {
    try {
      return await plane.appToken();
    } catch (e) {
      // The detail goes to our logs only: a visitor of an app road needs no tenant-side diagnostics.
      console.error(`[pbi] app token failed: ${e instanceof Error ? e.message : e}`);
      throw new PbiAccessError("the report's model is not reachable right now", 503);
    }
  }
  if (!assertion) {
    throw new PbiAccessError(
      "missing user token",
      401,
      "You are not signed in. A report is fetched as YOU (OBO), so there is nothing to render until you sign in to Power BI.",
    );
  }
  try {
    const { powerBiTokenOnBehalfOf } = await import("@/lib/auth/entra");
    return await powerBiTokenOnBehalfOf(assertion);
  } catch (e) {
    throw new PbiAccessError(`OBO failed: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}

export interface PbiBinding {
  workspaceId?: string;
  reportId?: string;
  datasetId?: string;
}

/**
 * May this binding be reached? On the OBO road always: the user's own identity is the boundary.
 * On an app road the plane decides — its second wall, so a bug that lets a client name a dataset
 * still reaches nothing outside what the plane allows.
 */
export function allowBinding(b: PbiBinding | undefined | null): boolean {
  if (pbiRoad() !== "sp") return true;
  return plane.allowBinding(b);
}
