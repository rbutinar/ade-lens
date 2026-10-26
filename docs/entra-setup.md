# Entra and Power BI setup (BFF + OBO)

ade-lens reaches Power BI **as the signed-in user**. The browser signs the user into your app's
own API scope; the server exchanges that token On-Behalf-Of (OBO) for a Power BI token, so Power
BI applies the user's own permissions and row-level security to the report AND to every query the
agent runs. The client secret never leaves the server; downstream tokens are never stored.

Use a **dedicated** app registration for ade-lens, so identity, consent and audit stay separate
from anything else in your tenant.

## 1. The app registration (Entra → App registrations → New registration)

Note its **Application (client) ID** and **Directory (tenant) ID**. Both are non-secret.

1. **Expose an API** — set the Application ID URI to `api://<client-id>` and add the scope
   **`access_as_user`** (admins and users can consent). This is the audience the browser signs into.
2. **Authentication → Add a platform → Single-page application** — redirect URI
   `http://localhost:3000`, plus your deployed origin. The app must run on exactly that origin:
   on another port (Next.js moves to 3001 when 3000 is busy) sign-in fails on the redirect URI.
3. **Certificates & secrets → New client secret** — copy the value once into `.env.local` as
   `PBI_CLIENT_SECRET`. Never commit it.
4. **API permissions → Add → Power BI Service → Delegated**: `Report.Read.All`,
   `Dataset.Read.All`, then **Grant admin consent**.
5. *(Optional, the Databricks report catalogue)* **API permissions → Azure Databricks →
   Delegated → `user_impersonation`**, then grant consent.

In `.env.local`:

```
PBI_TENANT_ID=<tenant-id>
PBI_CLIENT_ID=<client-id>
PBI_CLIENT_SECRET=<secret>
NEXT_PUBLIC_LENS_AUTH=1
NEXT_PUBLIC_PBI_TENANT_ID=<tenant-id>
NEXT_PUBLIC_PBI_CLIENT_ID=<client-id>
NEXT_PUBLIC_LENS_API_SCOPE=api://<client-id>/access_as_user
```

## 2. Power BI side: tenant settings and workspace

Two different portals: the app registration lives in Entra (`entra.microsoft.com`); the tenant
settings live in the **Power BI / Fabric admin portal** (`app.powerbi.com/admin-portal/tenantSettings`)
and need a Fabric administrator.

| Setting | Group | Needed for |
| --- | --- | --- |
| **Embed content in apps** | Developer settings | Embedding a report in your own app with a token the app mints. |
| **Dataset Execute Queries REST API** | Integration settings | The agent's DAX queries (`executeQueries`, `lib/powerbi/embed.ts`). Easy to miss: the embed renders, the queries fail with 401/403. |

Nothing else is required on the OBO road. Service-principal settings are not: ade-lens does not
use an app identity to reach your data (see [security.md](security.md)).

### Workspace, capacity, model

- **The signed-in user must be a member of the workspace** (Viewer is enough), or see the report
  through an app or a share. A 401 from Power BI means the identity was refused — it looks the
  same as a deleted workspace, so check membership first.
- **401 ≠ 403.** 403 = the token is wrong. 401 = the identity is refused.
- **RLS lives in the semantic model.** ade-lens adds no filter of its own: what a user may see is
  what the model's roles let them see.

## 3. The reports

List the reports the page may embed in [`content/lens-estate.ts`](../content/lens-estate.ts):
report id, workspace id, pages with what each one covers. The browser only ever names these keys.

Where the ids are: open the report in `app.powerbi.com`. The URL reads
`/groups/<workspace-id>/reports/<report-id>/<page-id>` — the last segment is the page's section
id (often prefixed `ReportSection`), the `page` of a `pages` entry. Click through each page to read
its id. A `datasetId` is optional: when it is missing, ade-lens reads it from Power BI.

## Go live

In `.env.local`:

```
LENS_MOCK=0
NEXT_PUBLIC_LENS_AUTH=1
ANTHROPIC_API_KEY=<your key>
```

Restart `npm run dev`, open `http://localhost:3000/app/lens`, then click **Sign in to Power BI**.
Set `LENS_MOCK=1` to go back to the synthetic reports.
