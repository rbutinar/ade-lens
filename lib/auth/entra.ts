import type { ConfidentialClientApplication } from "@azure/msal-node";

/**
 * Server-side Entra confidential client for the BFF + On-Behalf-Of (OBO) flow.
 *
 * The browser signs the user into OUR api scope; the server exchanges that
 * assertion for a Power BI token AS THE USER, so Power BI applies the user's own
 * RLS. The client secret never leaves the server; downstream tokens are never
 * persisted. This is the hardened alternative to relaying a browser token.
 */

const POWERBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";

let cca: ConfidentialClientApplication | null = null;

async function client(): Promise<ConfidentialClientApplication> {
  if (cca) return cca;
  const { ConfidentialClientApplication } = await import("@azure/msal-node");
  const tenantId = required("PBI_TENANT_ID");
  cca = new ConfidentialClientApplication({
    auth: {
      clientId: required("PBI_CLIENT_ID"),
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret: required("PBI_CLIENT_SECRET"),
    },
  });
  return cca;
}

/** Exchange the user's assertion for a Power BI access token (OBO). */
export async function powerBiTokenOnBehalfOf(userAssertion: string): Promise<string> {
  const app = await client();
  const res = await app.acquireTokenOnBehalfOf({
    oboAssertion: userAssertion,
    scopes: [POWERBI_SCOPE],
  });
  if (!res?.accessToken) throw new Error("OBO exchange returned no access token");
  return res.accessToken;
}

/** Azure Databricks' first-party resource id — the audience of a token Unity Catalog accepts. */
const DATABRICKS_SCOPE = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default";

/**
 * Exchange the user's assertion for an Azure Databricks token (OBO), so Unity Catalog applies the
 * user's own grants. Used by the Report Lens catalogue (lib/lens/catalog.ts); needs the
 * registration to carry the delegated `user_impersonation` permission on Azure Databricks.
 */
export async function databricksTokenOnBehalfOf(userAssertion: string): Promise<string> {
  const app = await client();
  const res = await app.acquireTokenOnBehalfOf({
    oboAssertion: userAssertion,
    scopes: [DATABRICKS_SCOPE],
  });
  if (!res?.accessToken) throw new Error("OBO exchange returned no Databricks token");
  return res.accessToken;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
