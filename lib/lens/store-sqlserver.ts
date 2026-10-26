/**
 * The SQL Server backend of the Report Lens store — `LENS_STORE=sqlserver`.
 *
 * Local instance, database `ade_lens`, schema `lens` (db/sqlserver/001_lens_store.sql), Windows
 * authentication through ODBC Driver 18 via `msnodesqlv8`, so no password exists to be leaked. Override with
 * `LENS_SQLSERVER_CONNECTION` (an ODBC connection string) for another instance or database.
 *
 * Server-only: imported lazily by lib/lens/store.ts, never by a client component.
 */
import sql from "mssql/msnodesqlv8";
import type { LensEvent } from "@/lib/lens/contract";
import {
  cappedTurn,
  toStored,
  type Conversation,
  type ConversationRow,
  type LensStore,
  type StoredEvent,
  type Turn,
} from "@/lib/lens/store";

const DEFAULT_CONNECTION =
  "Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=ade_lens;Trusted_Connection=yes;TrustServerCertificate=yes;";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the store points, without anything secret in it (Windows auth: there is none). */
function where(conn: string): string {
  const pick = (k: string) => conn.match(new RegExp(`${k}=([^;]+)`, "i"))?.[1] ?? "?";
  return `${pick("Server")}/${pick("Database")}`;
}

const nul = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export async function sqlServerStore(): Promise<LensStore> {
  const conn = process.env.LENS_SQLSERVER_CONNECTION || DEFAULT_CONNECTION;
  // msnodesqlv8 takes a whole ODBC connection string; the typings only know server/user/password.
  const pool = await new sql.ConnectionPool({ connectionString: conn } as unknown as sql.config).connect();
  // Fail at the first request, loudly, if the schema was never created — not at the first write.
  await pool.request().query("SELECT TOP 0 1 FROM lens.interaction_event; SELECT TOP 0 1 FROM lens.conversation_turn;");

  return {
    kind: "sqlserver",
    describe: `SQL Server ${where(conn)}, schema lens — kept across restarts`,

    async recordEvents(sessionId, viewer, batch: LensEvent[]) {
      let stored = 0;
      let duplicates = 0;
      const rejected: string[] = [];
      for (const e of batch.slice(0, 100)) {
        const row = toStored(e, sessionId, viewer);
        if (typeof row === "string") {
          rejected.push(row);
          continue;
        }
        try {
          const r = await pool
            .request()
            .input("session_id", sql.NVarChar(80), row.session_id)
            .input("event_id", sql.NVarChar(80), row.id)
            .input("ts", sql.BigInt, row.ts)
            .input("actor", sql.NVarChar(16), row.actor)
            .input("kind", sql.NVarChar(40), row.kind)
            .input("label", sql.NVarChar(200), row.label)
            .input("detail", sql.NVarChar(500), row.detail ?? null)
            .input("report_id", sql.NVarChar(80), row.report_id ?? null)
            .input("road", sql.NVarChar(16), row.road ?? null)
            .input("viewer", sql.NVarChar(256), row.viewer)
            .input("viewer_verified", sql.Bit, row.viewer_verified)
            .input("received_at", sql.BigInt, row.received_at)
            .query(`
              INSERT INTO lens.interaction_event
                (session_id, event_id, ts, actor, kind, label, detail, report_id, road, viewer, viewer_verified, received_at)
              SELECT @session_id, @event_id, @ts, @actor, @kind, @label, @detail, @report_id, @road, @viewer, @viewer_verified, @received_at
              WHERE NOT EXISTS (SELECT 1 FROM lens.interaction_event WITH (UPDLOCK, HOLDLOCK)
                                WHERE session_id = @session_id AND event_id = @event_id)`);
          if (r.rowsAffected[0] === 1) stored++;
          else duplicates++;
        } catch (err) {
          // Two retries racing past the NOT EXISTS: the primary key decides, and it is a duplicate.
          if ((err as { number?: number }).number === 2627) duplicates++;
          else throw err;
        }
      }
      return { stored, duplicates, rejected };
    },

    async listEvents(viewer, sessionId) {
      const r = await pool
        .request()
        .input("viewer", sql.NVarChar(256), viewer.id)
        .input("session_id", sql.NVarChar(80), sessionId ?? null)
        .query(`
          SELECT session_id, event_id, ts, actor, kind, label, detail, report_id, road, viewer, viewer_verified, received_at
          FROM lens.interaction_event
          WHERE viewer = @viewer AND (@session_id IS NULL OR session_id = @session_id)
          ORDER BY ts`);
      return r.recordset.map(
        (x): StoredEvent => ({
          id: x.event_id,
          ts: Number(x.ts),
          actor: x.actor,
          kind: x.kind,
          label: x.label,
          detail: nul(x.detail),
          report_id: nul(x.report_id),
          road: nul(x.road),
          session_id: x.session_id,
          viewer: x.viewer,
          viewer_verified: Boolean(x.viewer_verified),
          received_at: Number(x.received_at),
        }),
      );
    },

    async deleteEvents(viewer) {
      const r = await pool
        .request()
        .input("viewer", sql.NVarChar(256), viewer.id)
        .query("DELETE FROM lens.interaction_event WHERE viewer = @viewer");
      return r.rowsAffected[0] ?? 0;
    },

    async appendTurn(viewer, conversationId, turn: Turn, report) {
      const t = cappedTurn(turn);
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        // A conversation belongs to who started it: an id from another viewer starts a new one.
        let id: string | null = null;
        if (conversationId && UUID.test(conversationId)) {
          const found = await new sql.Request(tx)
            .input("id", sql.UniqueIdentifier, conversationId)
            .input("viewer", sql.NVarChar(256), viewer.id)
            .query("SELECT 1 AS ok FROM lens.conversation WITH (UPDLOCK) WHERE conversation_id = @id AND viewer = @viewer");
          if (found.recordset.length) id = conversationId.toLowerCase();
        }
        if (!id) {
          id = crypto.randomUUID();
          await new sql.Request(tx)
            .input("id", sql.UniqueIdentifier, id)
            .input("viewer", sql.NVarChar(256), viewer.id)
            .input("title", sql.NVarChar(80), t.question.slice(0, 80))
            .input("rid", sql.NVarChar(80), report.id)
            .input("rname", sql.NVarChar(200), report.name)
            .input("at", sql.BigInt, t.at)
            .query(`INSERT INTO lens.conversation (conversation_id, viewer, title, last_report_id, last_report_name, last_at)
                    VALUES (@id, @viewer, @title, @rid, @rname, @at)`);
        }
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, id)
          .input("question", sql.NVarChar(2000), t.question)
          .input("answer", sql.NVarChar(sql.MAX), t.answer)
          .input("trail", sql.NVarChar(sql.MAX), JSON.stringify(t.trail ?? []))
          .input("calls", sql.NVarChar(sql.MAX), JSON.stringify(t.calls ?? []))
          .input("at", sql.BigInt, t.at)
          .input("rid", sql.NVarChar(80), report.id)
          .input("rname", sql.NVarChar(200), report.name)
          .input("page", sql.NVarChar(80), report.page ?? null)
          .input("ptitle", sql.NVarChar(200), report.pageTitle ?? null)
          .query(`
            INSERT INTO lens.conversation_turn (conversation_id, turn_no, question, answer, trail, calls, at)
            SELECT @id, ISNULL(MAX(turn_no), 0) + 1, @question, @answer, @trail, @calls, @at
            FROM lens.conversation_turn WITH (UPDLOCK, HOLDLOCK) WHERE conversation_id = @id;
            UPDATE lens.conversation
               SET last_report_id = @rid, last_report_name = @rname, last_page = @page, last_page_title = @ptitle, last_at = @at
             WHERE conversation_id = @id;`);
        await tx.commit();
        return { conversation_id: id };
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        throw err;
      }
    },

    async listConversations(viewer) {
      const r = await pool
        .request()
        .input("viewer", sql.NVarChar(256), viewer.id)
        .query(`
          SELECT LOWER(CONVERT(nvarchar(36), c.conversation_id)) AS conversation_id, c.title, c.last_report_id,
                 c.last_report_name, c.last_page, c.last_page_title, c.last_at,
                 (SELECT COUNT(*) FROM lens.conversation_turn t WHERE t.conversation_id = c.conversation_id) AS turns
          FROM lens.conversation c
          WHERE c.viewer = @viewer
          ORDER BY c.last_at DESC`);
      return r.recordset.map(
        (x): ConversationRow => ({
          conversation_id: x.conversation_id,
          title: x.title,
          last_report_id: x.last_report_id,
          last_report_name: x.last_report_name,
          last_page: nul(x.last_page),
          last_page_title: nul(x.last_page_title),
          last_at: Number(x.last_at),
          turns: Number(x.turns),
        }),
      );
    },

    async getConversation(viewer, id) {
      if (!UUID.test(id)) return undefined;
      const r = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .input("viewer", sql.NVarChar(256), viewer.id)
        .query(`
          SELECT LOWER(CONVERT(nvarchar(36), conversation_id)) AS conversation_id, viewer, title, last_report_id,
                 last_report_name, last_page, last_page_title, last_at
          FROM lens.conversation WHERE conversation_id = @id AND viewer = @viewer;
          SELECT question, answer, trail, calls, at FROM lens.conversation_turn
          WHERE conversation_id = @id ORDER BY turn_no;`);
      const sets = r.recordsets as unknown as Array<Array<Record<string, unknown>>>;
      const c = sets[0]?.[0];
      if (!c) return undefined;
      const conv: Conversation = {
        conversation_id: String(c.conversation_id),
        viewer: String(c.viewer),
        title: String(c.title),
        last_report_id: String(c.last_report_id),
        last_report_name: String(c.last_report_name),
        last_page: nul(c.last_page as string | null),
        last_page_title: nul(c.last_page_title as string | null),
        last_at: Number(c.last_at),
        turns: (sets[1] ?? []).map((t) => ({
          question: String(t.question),
          answer: String(t.answer),
          trail: JSON.parse(String(t.trail)),
          calls: JSON.parse(String(t.calls)),
          at: Number(t.at),
        })),
      };
      return conv;
    },

    async deleteConversation(viewer, id) {
      if (!UUID.test(id)) return false;
      // The turns go with it (ON DELETE CASCADE): delete deletes.
      const r = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .input("viewer", sql.NVarChar(256), viewer.id)
        .query("DELETE FROM lens.conversation WHERE conversation_id = @id AND viewer = @viewer");
      return (r.rowsAffected[0] ?? 0) > 0;
    },
  };
}
