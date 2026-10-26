"use client";

import type { AccountInfo, PublicClientApplication as PCA } from "@azure/msal-browser";

/**
 * Browser sign-in for the BFF + OBO flow. The user signs into OUR api scope; the
 * resulting token is attached (Authorization: Bearer) to /api/* calls, and the
 * server exchanges it on-behalf-of for a Power BI token. No Power BI token ever
 * lives in the browser.
 *
 * Fully opt-in: with NEXT_PUBLIC_LENS_AUTH != "1" every function is a no-op and
 * the app stays on the mock path.
 */

const ENABLED = process.env.NEXT_PUBLIC_LENS_AUTH === "1";
const API_SCOPE = process.env.NEXT_PUBLIC_LENS_API_SCOPE ?? "";
const CLIENT_ID = process.env.NEXT_PUBLIC_PBI_CLIENT_ID ?? "";
const TENANT_ID = process.env.NEXT_PUBLIC_PBI_TENANT_ID ?? "";

let pcaPromise: Promise<PCA> | null = null;

async function getPca(): Promise<PCA | null> {
  if (!ENABLED || typeof window === "undefined") return null;
  if (!pcaPromise) {
    pcaPromise = (async () => {
      const { PublicClientApplication } = await import("@azure/msal-browser");
      const pca = new PublicClientApplication({
        auth: {
          clientId: CLIENT_ID,
          authority: `https://login.microsoftonline.com/${TENANT_ID}`,
          redirectUri: window.location.origin,
        },
        cache: { cacheLocation: "sessionStorage" },
      });
      await pca.initialize();
      // Rehydrate the active account after a reload: every call below resolves the
      // identity through getActiveAccount(), and MSAL does not set it for us.
      if (!pca.getActiveAccount()) {
        const [first] = pca.getAllAccounts();
        if (first) pca.setActiveAccount(first);
      }
      return pca;
    })();
  }
  return pcaPromise;
}

export function authEnabled(): boolean {
  return ENABLED;
}

/** Interactive sign-in. Returns the signed-in username, or null if disabled. */
export async function signIn(): Promise<string | null> {
  const pca = await getPca();
  if (!pca) return null;
  const res = await pca.loginPopup({ scopes: [API_SCOPE] });
  // Pin the account that just signed in. Without this, a SECOND sign-in leaves two
  // accounts in the cache and every later call took getAllAccounts()[0] — i.e. the
  // one signed in FIRST, so a new user could silently query as the previous one.
  // Under OBO the identity decides which rows the engine returns, so the wrong
  // account is a wrong answer, not an inconvenience.
  if (res.account) pca.setActiveAccount(res.account);
  return res.account?.username ?? null;
}

/** The identity every /api/* call is made as (see signIn). */
function activeAccount(pca: PCA): AccountInfo | null {
  return pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
}

/**
 * Silent api-scoped token for attaching to /api/* calls. Returns null when auth
 * is disabled or the user has not signed in yet (never forces a popup here, so
 * page-load fetches degrade gracefully to the server's mock/401 handling).
 */
export async function getApiToken(): Promise<string | null> {
  const pca = await getPca();
  if (!pca) return null;
  const account = activeAccount(pca);
  if (!account) return null;
  try {
    const res = await pca.acquireTokenSilent({ scopes: [API_SCOPE], account });
    return res.accessToken;
  } catch {
    return null;
  }
}

/** Current signed-in username (best-effort, post-init), or null. */
export async function currentUser(): Promise<string | null> {
  const pca = await getPca();
  return (pca && activeAccount(pca)?.username) ?? null;
}

/**
 * Interactive sign-OUT. Ends the session at the identity provider, not just locally:
 * clearing only the local cache would let the next sign-in silently re-select the same
 * account, so switching identity (e.g. from one tenant to another) would be
 * impossible. That is the whole point of having this — the OBO identity decides which
 * rows the engine returns, so being unable to leave it is a real limitation, not a
 * cosmetic one.
 *
 * No-op when auth is disabled or nobody is signed in. `mainWindowRedirectUri` is
 * deliberately omitted so the user stays on the page they were reading.
 */
export async function signOut(): Promise<void> {
  const pca = await getPca();
  if (!pca) return;
  const account = activeAccount(pca);
  if (!account) return;
  pca.setActiveAccount(null);
  await pca.logoutPopup({
    account,
    postLogoutRedirectUri: window.location.origin,
  });
}
