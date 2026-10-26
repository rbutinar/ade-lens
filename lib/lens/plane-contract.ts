import type { LensCatalogReport } from "@/content/lens-demo";
import type { PbiBinding } from "@/lib/powerbi/access";
import type { Usage } from "@/lib/lens/usage";

/**
 * The plane Report Lens runs on: what a deployment adds AROUND the core, behind one interface.
 *
 * The core (lib/lens, lib/powerbi, the /api/lens routes, /api/embed-token) never imports a plane
 * itself: it asks `plane` from lib/lens/plane.ts, the one composition point. A deployment that
 * adds nothing uses `selfHostPlane` below — the user's own identity on every call, nothing
 * restricted beyond what the engine itself enforces, nothing metered.
 */

/** "obo": the user's identity, exchanged on-behalf-of. "sp": an app identity (a plane's own). */
export type PbiRoad = "obo" | "sp";

/** One question's admission and metering. */
export interface QuestionMeter {
  /** Set when the question must not run: the route answers with it instead. */
  refused?: { status?: number; text?: string; reason: string };
  /** Called with every model call's usage. */
  onUsage(model: string, usage: Usage | undefined): void;
  /** Called once the question has run, whatever the outcome. */
  settle(): Promise<void>;
}

export interface LensPlane {
  name: string;
  /** Which road Power BI is reached on. */
  road(): PbiRoad;
  /** A Power BI token for the app road; only called when road() is "sp". */
  appToken(): Promise<string>;
  /** The reports this deployment may embed, in order; null = the whole configured estate. */
  estate(): LensCatalogReport[] | null;
  /** Second wall on an app road: may this binding be reached at all? */
  allowBinding(b: PbiBinding | undefined | null): boolean;
  /** Whether the Databricks report catalogue may be read (when configured). */
  databricksCatalogue: boolean;
  /** The principal the server verified for this request, if the plane has its own sign-in. */
  principal(req: Request): string | null;
  /** Admission and metering of one question to the agent. */
  question(req: Request): Promise<QuestionMeter>;
  /** A report outside the Report Lens estate the embed broker may also open (by our key). */
  extraReport(reportId: string): { binding?: { workspaceId: string; reportId: string; datasetId?: string } } | undefined;
}

const UNMETERED = { onUsage() {}, async settle() {} };

/**
 * Self-host: the user's identity only (docs/security.md), no extras. On the live road a question
 * without a VERIFIED signed-in user (lib/auth/verify.ts) is refused before the model runs — the
 * agent answers AS the user, and an anonymous or forged caller must not spend the model key.
 */
export const selfHostPlane: LensPlane = {
  name: "self-host",
  road: () => "obo",
  appToken: async () => {
    throw new Error("this deployment has no app road: Power BI is reached as the user (OBO)");
  },
  estate: () => null,
  allowBinding: () => true,
  databricksCatalogue: true,
  principal: () => null,
  question: async (req) => {
    if (process.env.LENS_MOCK !== "0") return UNMETERED;
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    const { verifyEntraToken } = await import("@/lib/auth/verify");
    if (!m || !(await verifyEntraToken(m[1]))) {
      return { refused: { status: 401, reason: "sign in first: the agent answers as you" }, ...UNMETERED };
    }
    return UNMETERED;
  },
  extraReport: () => undefined,
};
