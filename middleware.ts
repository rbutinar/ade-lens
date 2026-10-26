import { NextResponse, type NextRequest } from "next/server";

/**
 * The door in front of /app/* and /api/* — a coarse shared secret, NOT a user system.
 *
 * Who sees which rows is decided by Power BI, as the signed-in user (OBO, docs/security.md). This
 * door only keeps a deployment from serving the app to anyone who finds its URL:
 *  - with LENS_GATE_SECRET set, the app opens once with `?k=<secret>`; the key is exchanged for an
 *    httpOnly cookie (a digest, not the secret) and dropped from the URL;
 *  - on Vercel the secret is MANDATORY: unset, every gated path answers 503 instead of the app
 *    (fail closed — a control that switches itself off when unconfigured is not a control);
 *  - elsewhere, unset = no door. Put the deployment behind your own sign-in (e.g. App Service
 *    authentication, a reverse proxy with SSO) or set the secret.
 *
 * The refusal says nothing about the mechanism: a door that explains its own lock to everyone who
 * knocks does the reconnaissance for them.
 */

const GATE_SECRET = process.env.LENS_GATE_SECRET ?? "";
const ON_VERCEL = process.env.VERCEL === "1";
const GATE_COOKIE = "lens_gate";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function digest(secret: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lens-gate:${secret}`));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function denied(request: NextRequest, status: number, reason: string) {
  console.warn(`[gate] ${status} ${request.nextUrl.pathname} — ${reason}`);
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "not_available" }, { status });
  }
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ade-lens</title></head>` +
      `<body style="font:16px system-ui;padding:2rem"><h1>ade-lens is not open here</h1>` +
      `<p><a href="/">Back to the start page</a></p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function middleware(request: NextRequest) {
  if (!GATE_SECRET) {
    return ON_VERCEL ? denied(request, 503, "LENS_GATE_SECRET is unset on this deployment") : NextResponse.next();
  }
  const expected = await digest(GATE_SECRET);
  if (safeEqual(request.cookies.get(GATE_COOKIE)?.value ?? "", expected)) return NextResponse.next();

  const key = request.nextUrl.searchParams.get("k") ?? "";
  if (!key || !safeEqual(key, GATE_SECRET)) return denied(request, 401, "no valid access key");
  const clean = request.nextUrl.clone();
  clean.searchParams.delete("k");
  const response = request.nextUrl.pathname.startsWith("/api/") ? NextResponse.next() : NextResponse.redirect(clean);
  response.cookies.set(GATE_COOKIE, expected, {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}

export const config = {
  matcher: ["/app/:path*", "/api/:path*"],
};
