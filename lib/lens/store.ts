/**
 * Report Lens persistence — saved chats and the server-side interaction log.
 *
 * ONE SEAM, two backends today, picked by `LENS_STORE`:
 *  - `memory` (default) — per server process, lost on restart. Zero-config: the mock road and a
 *    fresh clone stay green with nothing installed.
 *  - `sqlserver` — a SQL Server instance, database `ade_lens`, schema `lens` (DDL in
 *    db/sqlserver/001_lens_store.sql), Windows authentication through ODBC Driver 18. A hosted
 *    database is a third backend behind the same seam, not built yet.
 *
 * A configured backend that fails FAILS: there is no fall-back to memory, because a log that
 * looked persisted and was not would be the silent-success shape this page is built against.
 * Every response says which store answered (`store` / `backend`).
 *
 * Rules kept whatever the backend:
 *  - the VIEWER is resolved by the server, never read from the body;
 *  - idempotent per (session, event id): the page retries unacknowledged batches, and a retry must
 *    not become a second click;
 *  - labels only, capped — no rendered rows;
 *  - delete deletes.
 */
import type { LensCall, LensEvent } from "@/lib/lens/contract";
import { plane } from "@/lib/lens/plane";

export interface StoredEvent extends LensEvent {
  session_id: string;
  viewer: string;
  viewer_verified: boolean;
  received_at: number;
}

export interface Turn {
  question: string;
  answer: string;
  trail: string[];
  calls: LensCall[];
  at: number;
}

export interface Conversation {
  conversation_id: string;
  viewer: string;
  title: string;
  turns: Turn[];
  /** The report the user was on AFTER the last turn — what resuming opens (defect #6). */
  last_report_id: string;
  last_report_name: string;
  /** …and the PAGE it ended on (section id + title), so resuming lands where the chat left off. */
  last_page?: string;
  last_page_title?: string;
  last_at: number;
}

export type ConversationRow = Omit<Conversation, "turns" | "viewer"> & { turns: number };

export interface ReportAfter {
  id: string;
  name: string;
  page?: string;
  pageTitle?: string;
}

export interface Viewer {
  /** "" when nothing asserts an identity (mock / local), and shown empty. */
  id: string;
  /**
   * Whether the identity was VERIFIED: the plane's own principal, or an Entra token whose
   * signature, audience, issuer and lifetime were checked (lib/auth/verify.ts). A token that does
   * not verify names nobody.
   */
  verified: boolean;
}

export interface RecordResult {
  stored: number;
  duplicates: number;
  rejected: string[];
}

/** What every backend does. Async throughout: a database answers later, memory answers now. */
export interface LensStore {
  kind: StoreKind;
  /** One line for the tooltip and the status route: where, and what it means. */
  describe: string;
  recordEvents(sessionId: string, viewer: Viewer, batch: LensEvent[]): Promise<RecordResult>;
  listEvents(viewer: Viewer, sessionId?: string): Promise<StoredEvent[]>;
  deleteEvents(viewer: Viewer): Promise<number>;
  appendTurn(viewer: Viewer, conversationId: string | null, turn: Turn, report: ReportAfter): Promise<{ conversation_id: string }>;
  listConversations(viewer: Viewer): Promise<ConversationRow[]>;
  getConversation(viewer: Viewer, id: string): Promise<Conversation | undefined>;
  deleteConversation(viewer: Viewer, id: string): Promise<boolean>;
}

export type StoreKind = "memory" | "sqlserver";

/** Who the request is from, as far as the server can tell. Never from the body. */
export async function viewerOf(req: Request): Promise<Viewer> {
  // A plane with its own sign-in (lib/lens/plane.ts): the principal it verified.
  const principal = plane.principal(req);
  if (principal) return { id: principal, verified: true };
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { id: "", verified: false };
  const { verifyEntraToken } = await import("@/lib/auth/verify");
  const claims = await verifyEntraToken(m[1]);
  if (!claims) return { id: "", verified: false };
  return { id: String(claims.preferred_username ?? claims.upn ?? claims.oid ?? ""), verified: true };
}

/**
 * On the live road the store answers a VERIFIED viewer only: chats and the log hold what a user
 * saw under their own RLS, so an anonymous or forged caller gets nothing back and writes nothing.
 * The mock road keeps working with no identity at all.
 */
export function refusesViewer(v: Viewer): boolean {
  return process.env.LENS_MOCK === "0" && !v.verified;
}

export const cap = (s: unknown, n: number) => String(s ?? "").slice(0, n);

/** The capped, attributed row every backend stores — or why the event was refused. */
export function toStored(e: LensEvent, sessionId: string, viewer: Viewer): StoredEvent | string {
  if (!e?.id || !e.kind || !e.actor) return "event without id/kind/actor";
  return {
    id: cap(e.id, 80),
    ts: Number(e.ts) || Date.now(),
    actor: e.actor,
    kind: e.kind,
    label: cap(e.label, 200),
    detail: e.detail ? cap(e.detail, 500) : undefined,
    report_id: e.report_id ? cap(e.report_id, 80) : undefined,
    road: e.road,
    session_id: sessionId,
    viewer: viewer.id,
    viewer_verified: viewer.verified,
    received_at: Date.now(),
  };
}

/** The turn as stored: question and answer capped, the same on every backend. */
export const cappedTurn = (t: Turn): Turn => ({ ...t, question: cap(t.question, 2000), answer: cap(t.answer, 8000) });

// ------------------------------------------------------------------------------------------
// the in-memory backend — survives hot reloads in dev by hanging off globalThis
// ------------------------------------------------------------------------------------------

interface Mem {
  events: Map<string, StoredEvent>;
  conversations: Map<string, Conversation>;
}
const g = globalThis as unknown as { __lensStore?: Mem; __lensSql?: Promise<LensStore> };
const mem: Mem = (g.__lensStore ??= { events: new Map(), conversations: new Map() });

const memoryStore: LensStore = {
  kind: "memory",
  describe: "memory (this server process only — lost on restart; set LENS_STORE=sqlserver to keep it)",

  async recordEvents(sessionId, viewer, batch) {
    let stored = 0;
    let duplicates = 0;
    const rejected: string[] = [];
    for (const e of batch.slice(0, 100)) {
      const row = toStored(e, sessionId, viewer);
      if (typeof row === "string") {
        rejected.push(row);
        continue;
      }
      const key = `${sessionId}:${row.id}`;
      if (mem.events.has(key)) {
        duplicates++;
        continue;
      }
      mem.events.set(key, row);
      stored++;
    }
    return { stored, duplicates, rejected };
  },

  async listEvents(viewer, sessionId) {
    return [...mem.events.values()]
      .filter((e) => e.viewer === viewer.id && (!sessionId || e.session_id === sessionId))
      .sort((a, b) => a.ts - b.ts);
  },

  async deleteEvents(viewer) {
    let n = 0;
    for (const [k, e] of mem.events) {
      if (e.viewer === viewer.id) {
        mem.events.delete(k);
        n++;
      }
    }
    return n;
  },

  async appendTurn(viewer, conversationId, turn, report) {
    const existing = conversationId ? mem.conversations.get(conversationId) : undefined;
    // A conversation belongs to who started it: an id from another viewer starts a new one.
    const conv: Conversation =
      existing && existing.viewer === viewer.id
        ? existing
        : {
            conversation_id: crypto.randomUUID(),
            viewer: viewer.id,
            title: cap(turn.question, 80),
            turns: [],
            last_report_id: report.id,
            last_report_name: report.name,
            last_at: turn.at,
          };
    conv.turns.push(cappedTurn(turn));
    conv.last_report_id = report.id;
    conv.last_report_name = report.name;
    conv.last_page = report.page;
    conv.last_page_title = report.pageTitle;
    conv.last_at = turn.at;
    mem.conversations.set(conv.conversation_id, conv);
    return { conversation_id: conv.conversation_id };
  },

  async listConversations(viewer) {
    return [...mem.conversations.values()]
      .filter((c) => c.viewer === viewer.id)
      .sort((a, b) => b.last_at - a.last_at)
      .map(({ turns, viewer: _v, ...rest }) => ({ ...rest, turns: turns.length }));
  },

  async getConversation(viewer, id) {
    const c = mem.conversations.get(id);
    return c && c.viewer === viewer.id ? c : undefined;
  },

  async deleteConversation(viewer, id) {
    const c = mem.conversations.get(id);
    if (!c || c.viewer !== viewer.id) return false;
    return mem.conversations.delete(id);
  },
};

// ------------------------------------------------------------------------------------------
// the seam
// ------------------------------------------------------------------------------------------

export const STORE_KIND: StoreKind = process.env.LENS_STORE === "sqlserver" ? "sqlserver" : "memory";

/**
 * The configured store. SQL Server is imported only when chosen: its driver is a native Windows
 * module (an optional dependency), and a road that does not use it must not need it.
 */
export function lensStore(): Promise<LensStore> {
  if (STORE_KIND === "memory") return Promise.resolve(memoryStore);
  // A failed first connection is not cached: the next request tries again.
  g.__lensSql ??= import("@/lib/lens/store-sqlserver").then((m) => m.sqlServerStore()).catch((e) => {
    g.__lensSql = undefined;
    throw e;
  });
  return g.__lensSql;
}

/** The store's one-line description, for the status route — never throws. */
export async function storeInfo(): Promise<{ kind: StoreKind; backend: string; ok: boolean }> {
  try {
    const s = await lensStore();
    return { kind: s.kind, backend: s.describe, ok: true };
  } catch (e) {
    return { kind: STORE_KIND, backend: `${STORE_KIND} — NOT reachable: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`, ok: false };
  }
}
