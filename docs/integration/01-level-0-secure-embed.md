# 01 · Level 0 — the secure embed

**Goal:** a Power BI report renders inside a page of your portal, for the signed-in viewer, showing
only the rows that viewer may see — with no Power BI secret and no Power BI id the viewer can steer
in the browser, a clean switch between reports, and states that tell the truth when it does not
render.

Level 0 has two halves: a **token broker** on your server, and the **embed** in the browser.

```
 browser (your page)                your server (the broker)               Power BI
 ───────────────────                ────────────────────────               ────────
 "open report SALES_OVERVIEW" ──►   who is this viewer?  (your session)
                                    may they open SALES_OVERVIEW?
                                    SALES_OVERVIEW → workspace/report/dataset
                                    mint an embed token  ───────────────►  GenerateToken
                                    ◄────────────────────────────────────  token, expiry
 ◄── { token, embedUrl, reportId, expiration }
 powerbi-client embeds it  ───────────────────────────────────────────►    renders, applies RLS
```

---

## 1. Choose the identity road

Who presents the token to Power BI decides who Power BI thinks is looking — and therefore whose RLS
applies. The browser side is **identical** on every road: `powerbi-client` needs a valid token and
nothing else. So this is decided on governance, not capability.

| Road | Who Power BI sees | Viewer needs | Secret | Row security comes from | Status in ade-lens |
|---|---|---|---|---|---|
| **User-owns-data, server-side (OBO)** | the viewer | an identity **in the tenant** + Power BI access | client secret on your server | Power BI RLS, on the viewer's own identity | **VERIFIED** (ade-lens, live, 2026-10-11) |
| User-owns-data, browser-side (MSAL `spa`) | the viewer | same as above | none | same as above | DESCRIBED |
| **App-owns-data (service principal)** | **your application** | nothing in Power BI | client secret or certificate on your server | Power BI RLS, on the **effective identity your server asserts** | **DESCRIBED** — not yet run by us |

**Which one:**

- Viewers **outside** the tenant, or too many to license (partners, customers) →
  **app-owns-data**. This is the usual answer for an external portal.
- Viewers who are **all** tenant users with Power BI access → **OBO** (proven) or `spa`.

### What app-owns-data changes — read this before choosing it

On app-owns-data, Power BI trusts your application completely. The consequences are not optional:

1. **The broker becomes the most critical component of your system.** Whatever username and roles it
   puts in the token, Power BI enforces. A bug there is a data leak.
2. **The effective username is resolved on the server** from the identity your portal has
   validated (intake A.3) — never from a parameter, header or body the browser sends. A value the
   browser sends is a value anyone can set.
3. **A model with no RLS roles shows every viewer everything.** RLS in the model is a precondition
   (intake B.7). Check every model you embed.
4. **Never "one broad token + filters".** Embedding with full access and narrowing each viewer's
   slice with report or embed filters is presentation, not security. It is the pattern this kit
   exists to prevent.
5. **Power BI's audit names your application for every viewer.** The only per-person record is
   the one you keep — which is why level 2 stops being optional on this road.
6. **Use a dedicated app registration** for it. Adding application permissions to a registration
   that also serves delegated sign-in elsewhere widens what that registration can do for everyone
   using it.

---

## 2. The broker contract

One endpoint on your server. The shape below is what ade-lens uses (VERIFIED); names are yours to
change.

**Request** — the browser names a **key your portal owns**, never a workspace, report or dataset id:

```http
POST /api/embed-token
Authorization: <however your portal authenticates calls to its own backend>
Content-Type: application/json

{ "reportKey": "SALES_OVERVIEW" }
```

**Response** — success:

```json
{
  "token": "<embed token>",
  "tokenType": "Embed",
  "embedUrl": "https://app.powerbi.com/reportEmbed?reportId=…&groupId=…",
  "reportId": "<report id>",
  "expiration": "2026-10-12T14:05:00Z"
}
```

— failure: an HTTP status **plus a hint a person can act on** (see §6):

```json
{ "error": "GenerateToken failed (401): PowerBINotAuthorizedException · RequestId …",
  "hint": "This identity cannot see the workspace — grant access at Power BI." }
```

**Rules the broker enforces:**

| Rule | Why |
|---|---|
| Resolve `reportKey` against a server-side table `key → {workspaceId, reportId, datasetId}`; unknown key → 404 | So "open" cannot be pointed at arbitrary Power BI items (VERIFIED in ade-lens) |
| Check the viewer may open **that report** at all | Which *reports* a viewer gets is your app's decision; which *rows* is RLS's |
| Resolve the viewer's identity from your validated session, server-side | The browser never states who it is |
| Ask for `accessLevel: View` only | Nothing in this kit needs edit or create |
| Never return, log or store the Power BI access token or the secret | The embed token is the only thing that leaves |
| Read `X-PowerBI-Error-Info` and `RequestId` on every Power BI failure and pass them on | The status code alone does not say what went wrong (§6) |

---

## 3. Minting the token, per road

Every call below goes to `https://api.powerbi.com/v1.0/myorg`.

### 3a. OBO (user-owns-data, server-side) — VERIFIED

1. The browser signs the viewer in to **your own API scope** (`api://<client-id>/<scope>`) and
   sends that token to the broker.
2. The broker exchanges it **on behalf of** the viewer for a Power BI token: MSAL
   `acquireTokenOnBehalfOf`, scope `https://analysis.windows.net/powerbi/api/.default`,
   authenticating with the registration's client secret.
3. `GET /groups/{workspaceId}/reports/{reportId}` → `embedUrl`.
4. `POST /groups/{workspaceId}/reports/{reportId}/GenerateToken` with `{ "accessLevel": "View" }`
   → `token`, `expiration`. Power BI applies **the viewer's** RLS.

Registration: delegated Power BI permissions with admin consent, an exposed API scope, a client
secret kept server-side. Viewer: an identity in the tenant with access to the workspace.

### 3b. App-owns-data (service principal) — DESCRIBED

**Tenant and workspace prerequisites** (tenant admin):

- the service principal in a security group allowed by the tenant setting that lets service
  principals call the Power BI / Fabric APIs, and *Embed content in apps* enabled;
- the service principal as **Member** of each workspace it embeds from;
- the workspaces on a **capacity that permits embedding for your customers** (an F, A or EM SKU —
  intake B.9). Without one, service-principal embed tokens are meant for development only.

**Calls:**

1. Client-credentials token for the service principal: `POST
   https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`, `grant_type=client_credentials`,
   `scope=https://analysis.windows.net/powerbi/api/.default`. Cache it until shortly before expiry.
2. `GET /groups/{workspaceId}/reports/{reportId}` → `embedUrl`, `datasetId`.
3. `POST /GenerateToken` with the **effective identity** your server resolved:

```json
{
  "reports":  [ { "id": "<reportId>" } ],
  "datasets": [ { "id": "<datasetId>" } ],
  "identities": [
    {
      "username": "<resolved on the server — e.g. the viewer's organisation id>",
      "roles":    [ "<the model's RLS role>" ],
      "datasets": [ "<datasetId>" ]
    }
  ]
}
```

What `username` contains is whatever your model's RLS rule compares against
(`USERPRINCIPALNAME()` returns it). Design it with the model owner (intake A.4, B.7).

**Test this before anything else on this road** — it is exactly what we have not yet run:
two viewers belonging to two different organisations open the same report; each must see only
their own rows, on screen **and** in any total. Then remove the role from the token and confirm the
call is **refused**, not served unfiltered.

---

## 4. The embed, in the browser — VERIFIED

`powerbi-client` (npm) works in any framework; the snippet is plain TypeScript.

```ts
import * as pbi from "powerbi-client";

// One Service per embed, so switching reports never collides (§5).
const service = new pbi.service.Service(
  pbi.factories.hpmFactory, pbi.factories.wpmpFactory, pbi.factories.routerFactory);

const t = await fetch("/api/embed-token", { method: "POST", /* auth, */
  body: JSON.stringify({ reportKey }) }).then(r => r.json());

const report = service.embed(container, {
  type: "report",
  id: t.reportId,
  embedUrl: t.embedUrl,
  accessToken: t.token,
  tokenType: pbi.models.TokenType.Embed,        // both 3a and 3b return an Embed token
  pageName: pageSectionId,                       // optional: open straight on a page (§9)
  settings: {
    background: pbi.models.BackgroundType.Transparent,
    layoutType: pbi.models.LayoutType.Custom,
    customLayout: { displayOption: pbi.models.DisplayOption.FitToWidth },
    panes: { filters: { visible: false }, pageNavigation: { visible: false } }, // intake D.15
  },
});

report.on("loaded",   () => setStatus("loading"));   // the shell is up
report.on("rendered", () => setStatus("ready"));     // visuals drawn — fires on every repaint
report.on("error",    (e) => setStatus("failed", e.detail));
```

Notes:

- Hide Power BI's panes only if your portal provides navigation; levels 1–3 assume the page drives
  the report, and a visible filter pane makes it impossible to tell who changed what.
- Give the container the page's shape (a 16:9 canvas → an `aspect-ratio: 16 / 9` box) and fit to
  width; otherwise a designed page is letterboxed.
- Do **not** apply a theme of your own over a report that has one — it repaints the author's
  design (seen 2026-10-11: navigation buttons turned into blank boxes).

---

## 5. Switching reports — VERIFIED

When the viewer leaves a report or opens another in the same place, **tear the old one down**:

```ts
service.reset(container);     // then embed the next one with a fresh Service
container.innerHTML = "";
```

Without it the second embed fails with *"already has embedded component"*. In a component framework,
do this in the unmount/cleanup of the component that owns the container, and key that component on
`reportId + token` so a token for the next report never mounts into the previous one (that produced
duplicate *loaded* events in ade-lens).

---

## 6. States that tell the truth

The page shows one of three states, decided by the **page**, not guessed:

| State | When | What the viewer reads |
|---|---|---|
| `loading` | token requested, report not drawn yet | a loader — **no timeout under ~60 s**: we measured 3 s on an idle machine and 60 s+ under load (2026-10-11) |
| `ready` | first `rendered` | the report |
| `failed` | broker error or embed `error` | what happened **and who can fix it** |

**Reading a Power BI refusal** — MEASURED in ade-lens, 2026-09-22:

| Power BI answers | It means | Fixed by |
|---|---|---|
| **403** with `X-PowerBI-Error-Info: InvalidToken` | the token itself is bad (wrong audience, expired, malformed) | your broker |
| **401** (`PowerBINotAuthorizedException`) | the **identity** is refused for that workspace/report — *or* the item no longer exists; the two look identical | access at Power BI (workspace membership / the SP's membership); an admin-side read tells which |
| **404** on the report | stale binding in your key table, or the identity cannot see the workspace at all | your key table, or access |

Always log `X-PowerBI-Error-Info` and `RequestId`. And say it in the UI: *access is granted at Power
BI, not in this portal* — the fix is never an app-side workaround.

---

## 7. Token refresh — DESCRIBED

An embed token expires (`expiration` in the broker's response; about an hour). ade-lens does **not**
refresh it today, so a report left open long enough stops answering. In your portal:

```ts
// Schedule a refresh a few minutes before expiry; re-check when the tab becomes visible again.
const fresh = await fetch("/api/embed-token", { method: "POST", body: JSON.stringify({ reportKey }) })
  .then(r => r.json());
await report.setAccessToken(fresh.token);      // no reload, the viewer keeps their state
```

On OBO, the embed token cannot outlive the viewer's own session: if the silent token for your API
scope fails, send the viewer to sign in again rather than looping.

---

## 8. Hosting — DESCRIBED

- **CSP:** allow the embed's iframe, e.g. `frame-src https://app.powerbi.com;` (add what your
  tenant's `embedUrl` actually uses). Nothing in level 0 needs `connect-src` to Power BI from the
  browser — all REST calls are the broker's.
- **Your portal inside another iframe** (intake C.10): the SDK talks to its iframe by
  `postMessage`, which works across nesting; test it early anyway.
- **Secrets** (intake C.13): the client secret or certificate lives in your secret store, is read
  at runtime, and only its *presence* is ever reported by a health endpoint.

---

## 9. Known pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Second report: *"already has embedded component"* | old embed not torn down | §5 |
| Opening on a page flashes the landing page first (and logs a view of it) | navigated after load | `pageName` in the embed config |
| A sign-in as a new user still queries as the previous one (OBO / `spa`) | MSAL kept two accounts and the code took the first | set the active account to the one that just signed in; offer a real sign-out |
| `(401)` with no clue whether it is a licence, membership or a bug | only the status was kept | read `X-PowerBI-Error-Info` + `RequestId` (§6) |
| Report looks wrong: blank buttons, recoloured lines | a theme applied over the author's | don't apply one |
| Bands above and below the page | default layout in a taller box | container with the page's aspect ratio + FitToWidth |
| "Report did not load" during a slow start | timeout too short | §6 — tens of seconds are normal under load |

---

## Done when

- [ ] The browser never receives a workspace, dataset or report id it chose, nor any Power BI
      access token or secret — only the embed token for a key it was allowed.
- [ ] An unknown key → 404; a key the viewer may not open → refused by the broker.
- [ ] **Two viewers with different rights see different rows on the same report**, and a token
      minted with no role (app-owns-data) is refused, not served unfiltered.
- [ ] Switching between two reports in the same container ten times works, with one *loaded* per
      switch.
- [ ] A refused identity shows `failed` with a hint that names who fixes it, and the log carries
      `X-PowerBI-Error-Info` + `RequestId`.
- [ ] A report left open past its token's expiry keeps working (refresh, §7).
- [ ] The secret is in the secret store, not in code, config files or logs.

Next: [level 1 — the page and the report talk](02-level-1-page-report-contract.md).
