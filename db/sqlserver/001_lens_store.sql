/*
  Report Lens store on a SQL Server instance (LENS_STORE=sqlserver): saved chats and the
  server-side interaction log. One database per app; Windows authentication by default.

      sqlcmd -S localhost -E -C -i db/sqlserver/001_lens_store.sql

  Idempotent: re-running creates what is missing and touches nothing that exists.
  Times are epoch milliseconds (bigint), the unit the page and the API already speak.
  Synthetic data only — the demo runs on synthetic reports; labels are capped, no rendered rows.
*/
IF DB_ID(N'ade_lens') IS NULL CREATE DATABASE ade_lens;
GO
USE ade_lens;
GO
IF SCHEMA_ID(N'lens') IS NULL EXEC (N'CREATE SCHEMA lens');
GO

-- The interaction log. Idempotent per (session, event id): the page retries unacknowledged
-- batches, and a retry must not become a second click.
IF OBJECT_ID(N'lens.interaction_event') IS NULL
CREATE TABLE lens.interaction_event (
    session_id      nvarchar(80)  NOT NULL,
    event_id        nvarchar(80)  NOT NULL,
    ts              bigint        NOT NULL,
    actor           nvarchar(16)  NOT NULL,
    kind            nvarchar(40)  NOT NULL,
    label           nvarchar(200) NOT NULL,
    detail          nvarchar(500) NULL,
    report_id       nvarchar(80)  NULL,
    road            nvarchar(16)  NULL,
    -- resolved by the SERVER from the request, never read from the body
    viewer          nvarchar(256) NOT NULL,
    viewer_verified bit           NOT NULL,
    received_at     bigint        NOT NULL,
    CONSTRAINT PK_interaction_event PRIMARY KEY (session_id, event_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_interaction_event_viewer_ts')
CREATE INDEX IX_interaction_event_viewer_ts ON lens.interaction_event (viewer, ts);
GO

-- Saved chats. A conversation belongs to the viewer who started it.
IF OBJECT_ID(N'lens.conversation') IS NULL
CREATE TABLE lens.conversation (
    conversation_id  uniqueidentifier NOT NULL CONSTRAINT PK_conversation PRIMARY KEY,
    viewer           nvarchar(256)    NOT NULL,
    title            nvarchar(80)     NOT NULL,
    -- the report and page the user was on AFTER the last turn: what resuming opens
    last_report_id   nvarchar(80)     NOT NULL,
    last_report_name nvarchar(200)    NOT NULL,
    last_page        nvarchar(80)     NULL,
    last_page_title  nvarchar(200)    NULL,
    last_at          bigint           NOT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_conversation_viewer_last_at')
CREATE INDEX IX_conversation_viewer_last_at ON lens.conversation (viewer, last_at DESC);
GO

-- One row per question/answer. trail and calls are JSON (the trail lines, the tool calls with
-- their arguments and results) — read back whole, never queried inside.
IF OBJECT_ID(N'lens.conversation_turn') IS NULL
CREATE TABLE lens.conversation_turn (
    conversation_id uniqueidentifier NOT NULL
        CONSTRAINT FK_turn_conversation REFERENCES lens.conversation (conversation_id) ON DELETE CASCADE,
    turn_no         int              NOT NULL,
    question        nvarchar(2000)   NOT NULL,
    answer          nvarchar(max)    NOT NULL,
    trail           nvarchar(max)    NOT NULL CONSTRAINT CK_turn_trail_json CHECK (ISJSON(trail) = 1),
    calls           nvarchar(max)    NOT NULL CONSTRAINT CK_turn_calls_json CHECK (ISJSON(calls) = 1),
    at              bigint           NOT NULL,
    CONSTRAINT PK_conversation_turn PRIMARY KEY (conversation_id, turn_no)
);
GO
