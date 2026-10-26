# 03 · Level 2 — observability: the interaction log

**Goal:** a durable, server-side record of **who looked at what, and what they did** — report opened,
page viewed, filter in force, data point selected, control accepted or refused, embed failed —
attributed **by the server**, never by the browser.

Prerequisite: level 1 (the log records changes of level 1's state and the results of its controls).

**On app-owns-data this level is not optional.** Power BI's own audit names *your application* for
every viewer (level 0 §1); this log is then the only per-person record that exists.

```
 page                                   your server                         your store
 ────                                   ───────────                         ──────────
 state diff / control result / error
   → event { id, ts, actor, kind, label, detail?, report, road }
   → queue ── batch every ~1.5 s ──►   POST /api/events
                                       viewer = from the validated session
                                       cap, validate, de-duplicate  ─────►  insert (idempotent)
           ◄── { stored, duplicates, rejected, viewer, store } ──
   drop acknowledged events; keep the rest and retry
```

---

## 1. One vocabulary, many sinks

| `kind` | When |
|---|---|
| `load` | the embed loaded |
| `view` | a report page became active |
| `filter` | the filters in force changed (label carries the new set, or "cleared") |
| `select` | a data-point selection changed |
| `control` | something asked the report for a page/filter — with *accepted* or *refused* |
| `error` | an embed or control error |
| `export` | what the viewer sees went to a file (level 3) |
| `ask` · `answer` · `query` | reserved for the assistant (level 4) |

| `actor` | Meaning |
|---|---|
| `user` | the viewer clicked, in the report or in your page |
| `system` | your page did it (a deep link, a restore, the embed itself) |
| `agent` | an assistant asked (level 4) |

The same events feed every sink — your store, an analytics tool, an on-screen list. Do not invent a
second vocabulary for analytics (decided in ade-lens, 2026-07-28).

## 2. The event

```ts
interface ReportEvent {
  id: string;          // unique per page load, e.g. `evt-${Date.now()}-${n}` — the idempotency key
  ts: number;          // epoch ms, client clock
  actor: "user" | "system" | "agent";
  kind: string;        // §1
  label: string;       // short, human: "Viewing page “Sales by Region”"
  detail?: string;     // the filter set, the refusal reason, …
  report?: string;     // your report KEY (level 0), not Power BI ids
  road?: string;       // which identity road the embed was on, e.g. "obo" | "app" | "mock"
}
```

**No viewer field.** Who did it is the server's to say (§4). A viewer the browser sends is a label
anyone can set.

## 3. Producing events in the page — VERIFIED

- **Log changes, not states.** Keep the last published level-1 state; on each new one, emit only
  what differs: a new active page → `view`; a different filter set → `filter` ("Filters in force" /
  "Filters cleared"); a new non-empty selection → `select`. An identical re-sync emits nothing.
  (`rendered` fires on every repaint; a log of states fills with duplicates in seconds and stops
  being read.)
- **Controls log their outcome** (level 1 §5): "setPage accepted — no reload", "updateFilters
  refused: …".
- **Reset the baseline when the report changes**, or the first state of the next report diffs
  against the last state of the previous one.
- **Attribution when something other than the viewer drives the report.** A change your page (or an
  assistant) caused arrives through the same report events as a click. ade-lens registers the
  *expected effect* when it issues a control — kind + value, valid for 20 s (90 s for opening a
  report: a live embed once took 36 s) — and stamps the first matching diffed event with that actor;
  anything else stays `user`. Without it, every programmatic filter is logged as the viewer's.

## 4. Sending them — VERIFIED

- **Session id**: a random UUID per page load. It groups a sitting's events; it is **not** an
  identity and claims nothing.
- **Queue and batch**: push every event to a pending queue; every ~1.5 s send up to 100.
- **Re-send until acknowledged**: remove from the queue only what the server acknowledged. The
  server is idempotent per (session id, event id), so a retry can never become a second click.
- **Say what happened** — one line on the page, short on screen, details on hover:
  *"Recorded on the server: 12 events · as anna@contoso.example · session 3f2a9c1e"*, or
  *"Not recording — not acknowledged, will retry"*. A log that silently fails is worse than none:
  people believe it.

## 5. The server sink

```http
POST /api/events
Authorization: <your portal's session>
{ "session_id": "3f2a9c1e-…", "events": [ ReportEvent, … ] }
```

```json
{ "recording": true, "store": "sql", "viewer": "anna@contoso.example", "viewer_verified": true,
  "stored": 11, "duplicates": 1, "rejected": [] }
```

Rules:

| Rule | Why |
|---|---|
| `viewer` = the identity from **your validated session**; any `viewer` in the body ignored | the browser never attributes |
| Validate the identity, don't just decode it | ade-lens today **decodes** the bearer's claims without validating the signature, and says `viewer_verified: false` in every response. Your portal already validates its session — use that, and store `viewer_verified` truthfully |
| Idempotent on `(session_id, event id)`: a known pair counts as `duplicates`, not a new row | retries (§4) |
| Cap: `label` 200, `detail` 500 chars; at most 100 events per batch | a log is not a data store |
| Reject an event without `id`, `kind` or `actor`, and say so in `rejected` | malformed ≠ silently dropped |
| Store unreachable → **503**, never a fallback to memory or a fake 200 | the page then says "not recording" and keeps the batch |
| `GET` lists the caller's own events; `DELETE` deletes the caller's events **for real** | a selection label can name a customer |
| Server time beside client time (`received_at`) | client clocks drift |

A minimal table (adapt types to your database):

```sql
CREATE TABLE report_event (
  session_id      VARCHAR(80)  NOT NULL,
  event_id        VARCHAR(80)  NOT NULL,
  ts              BIGINT       NOT NULL,      -- client epoch ms
  received_at     TIMESTAMP    NOT NULL,      -- server time
  viewer          VARCHAR(256) NOT NULL,      -- from the validated session ('' if none)
  viewer_verified BOOLEAN      NOT NULL,
  actor           VARCHAR(16)  NOT NULL,
  kind            VARCHAR(16)  NOT NULL,
  label           VARCHAR(200) NOT NULL,
  detail          VARCHAR(500),
  report_key      VARCHAR(80),
  road            VARCHAR(16),
  PRIMARY KEY (session_id, event_id)
);
CREATE INDEX ix_report_event_viewer ON report_event (viewer, ts);
```

ade-lens runs this on SQL Server and in memory behind one store interface (VERIFIED 2026-10-11:
duplicates counted, malformed rejected, events read back after a restart, delete removing them).

## 6. Privacy — decide before go-live

- **Labels only, never rendered rows.** The log records "Filters in force: Customer In ACME", not
  the figures on screen.
- Labels **can still name a customer or a person** — through a filter value or a selection. Decide
  a **retention period** and who may read the log; make `DELETE` real.
- External viewers: the log is personal data about them. Your portal's privacy notice should cover
  it.

## 7. An analytics sink (optional) — DESCRIBED, not built

The same events can go to GA4 (gtag in the browser, or the Measurement Protocol from the server)
or Application Insights, giving a real funnel — report opened → page viewed → filter applied —
rather than page views. For external viewers: consent first (Consent Mode v2), **no PII** in any
dimension, a pseudonymous viewer id, filter values categorised or omitted. It is a second sink of
the same events, never a replacement for §5: analytics tools sample, and they are not an audit.

---

## Done when

- [ ] Opening a report, changing page, filtering, selecting a point each produce **exactly one**
      event, with the right `actor`; an idle report produces none.
- [ ] A filter applied by your page (not a click) is logged with your page's actor, not `user`.
- [ ] The viewer on every stored row comes from the server session; sending a `viewer` in the body
      changes nothing.
- [ ] Re-sending the same batch stores nothing new (`duplicates` = batch size).
- [ ] With the store down: 503, the page says "not recording", and the events arrive once it is back.
- [ ] `DELETE` leaves no row for that viewer.
- [ ] Retention and readers of the log are decided and written down.

Next: [level 3 — extras](04-level-3-extras.md).
