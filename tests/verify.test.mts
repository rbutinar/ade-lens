// lib/auth/verify.ts against tokens signed here, with a stand-in for the tenant's key endpoint.
// Run: npm test (node --test, Node 22.18+ for TypeScript type stripping).
import { generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import { test, before } from "node:test";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "66666666-7777-8888-9999-000000000000";
process.env.PBI_TENANT_ID = TENANT;
process.env.PBI_CLIENT_ID = CLIENT;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };

let fetches = 0;
globalThis.fetch = (async (url: string | URL) => {
  fetches++;
  assert.ok(String(url).includes(`/${TENANT}/discovery/v2.0/keys`), `unexpected url ${url}`);
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
}) as typeof fetch;

type Verify = (token: string) => Promise<unknown>;
let verifyEntraToken: Verify;
before(async () => {
  ({ verifyEntraToken } = (await import("../lib/auth/verify.ts")) as { verifyEntraToken: Verify });
});

const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const good = {
  aud: `api://${CLIENT}`,
  iss: `https://sts.windows.net/${TENANT}/`,
  exp: now + 600,
  nbf: now - 10,
  preferred_username: "anna@contoso.example",
};
function tok(payload: object, header: object = { alg: "RS256", kid: "k1" }, key = privateKey) {
  const h = enc(header);
  const p = enc(payload);
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}
const accepts = async (t: string) => Boolean(await verifyEntraToken(t));

test("accepts a v1 token for this app", async () => assert.equal(await accepts(tok(good)), true));

test("accepts a v2 token (audience = client id)", async () =>
  assert.equal(await accepts(tok({ ...good, aud: CLIENT, iss: `https://login.microsoftonline.com/${TENANT}/v2.0` })), true));

test("refuses unsigned claims", async () =>
  assert.equal(await accepts(`${enc({ alg: "RS256", kid: "k1" })}.${enc(good)}.AAAA`), false));

test("refuses a token signed by another key", async () => assert.equal(await accepts(tok(good, undefined, other)), false));

test("refuses alg none", async () => assert.equal(await accepts(`${enc({ alg: "none", kid: "k1" })}.${enc(good)}.`), false));

test("refuses a tampered payload", async () => {
  const [h, , s] = tok(good).split(".");
  assert.equal(await accepts(`${h}.${enc({ ...good, preferred_username: "boss@contoso.example" })}.${s}`), false);
});

test("refuses another audience", async () => assert.equal(await accepts(tok({ ...good, aud: "api://someone-else" })), false));

test("refuses another tenant's issuer", async () =>
  assert.equal(await accepts(tok({ ...good, iss: "https://sts.windows.net/aaaaaaaa-0000-0000-0000-000000000000/" })), false));

test("refuses an expired token", async () => assert.equal(await accepts(tok({ ...good, exp: now - 3600 })), false));

test("refuses a token not yet valid", async () => assert.equal(await accepts(tok({ ...good, nbf: now + 3600 })), false));

test("refuses an unknown key id, after one fresh read of the keys", async () => {
  const before = fetches;
  assert.equal(await accepts(tok(good, { alg: "RS256", kid: "nope" })), false);
  assert.equal(fetches - before, 1);
});

test("refuses garbage", async () => assert.equal(await accepts("not.a.jwt"), false));
