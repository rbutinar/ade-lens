import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * Validate a bearer the browser sent: an Entra access token for THIS app's API scope.
 *
 * Signature (RS256, against the tenant's published keys), audience (this app), issuer (this
 * tenant, v1 or v2 endpoint) and lifetime. Only a token that passes all four names a viewer: the
 * saved chats and the interaction log are keyed by that name, so a decoded-but-unverified claim
 * would let anyone read another user's chats by writing their name into a token.
 *
 * Server-only (node:crypto). Needs PBI_TENANT_ID and PBI_CLIENT_ID; without them nothing verifies.
 */

export interface EntraClaims {
  aud?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  oid?: string;
  tid?: string;
  upn?: string;
  preferred_username?: string;
}

const SKEW_S = 60;
const KEYS_TTL_MS = 6 * 60 * 60 * 1000;

type Jwk = JsonWebKey & { kid?: string };
let jwks: { tenant: string; at: number; keys: Jwk[] } | null = null;

async function tenantKeys(tenant: string, refresh: boolean): Promise<Jwk[]> {
  if (!refresh && jwks && jwks.tenant === tenant && Date.now() - jwks.at < KEYS_TTL_MS) return jwks.keys;
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`, { cache: "no-store" });
  if (!res.ok) throw new Error(`signing keys unavailable (${res.status})`);
  const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
  jwks = { tenant, at: Date.now(), keys };
  return keys;
}

const b64url = (s: string) => Buffer.from(s, "base64url");

/** The token's claims if it is valid for this app and tenant, else null. Never throws. */
export async function verifyEntraToken(token: string): Promise<EntraClaims | null> {
  const tenant = process.env.PBI_TENANT_ID;
  const clientId = process.env.PBI_CLIENT_ID;
  if (!tenant || !clientId) return null;
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const header = JSON.parse(b64url(h).toString("utf8")) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) return null;

    let jwk = (await tenantKeys(tenant, false)).find((k) => k.kid === header.kid);
    // Keys rotate: an unknown kid gets one fresh read before it is refused.
    if (!jwk) jwk = (await tenantKeys(tenant, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
    if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64url(s))) return null;

    const claims = JSON.parse(b64url(p).toString("utf8")) as EntraClaims;
    const now = Date.now() / 1000;
    if (claims.aud !== clientId && claims.aud !== `api://${clientId}`) return null;
    const issuers = [`https://login.microsoftonline.com/${tenant}/v2.0`, `https://sts.windows.net/${tenant}/`];
    if (!claims.iss || !issuers.includes(claims.iss)) return null;
    if (typeof claims.exp !== "number" || claims.exp < now - SKEW_S) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + SKEW_S) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Test seam: forget the cached keys. */
export function resetKeyCache(): void {
  jwks = null;
}
