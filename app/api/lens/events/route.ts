import { NextResponse } from "next/server";
import type { LensEvent } from "@/lib/lens/contract";
import { lensStore, refusesViewer, viewerOf } from "@/lib/lens/store";

/**
 * The interaction log's server sink. The page posts batches and retries what was not acknowledged;
 * the store is idempotent per (session, event id). The viewer is the server's to say — a `viewer`
 * in the body is ignored, because a value the browser sends is a label anyone can set.
 *
 * A store that cannot be reached answers 503 — the page then says "not recording" and keeps the
 * batch for the retry, instead of being told it was kept.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { session_id?: string; events?: LensEvent[] };
  if (!body.session_id || !Array.isArray(body.events)) {
    return NextResponse.json({ error: "session_id and events are required" }, { status: 400 });
  }
  const viewer = await viewerOf(req);
  if (refusesViewer(viewer)) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  try {
    const store = await lensStore();
    const res = await store.recordEvents(String(body.session_id).slice(0, 80), viewer, body.events);
    return NextResponse.json({
      recording: true,
      store: store.kind,
      backend: store.describe,
      viewer: viewer.id,
      viewer_verified: viewer.verified,
      ...res,
    });
  } catch (e) {
    return unavailable(e);
  }
}

export async function GET(req: Request) {
  const session = new URL(req.url).searchParams.get("session_id") ?? undefined;
  const viewer = await viewerOf(req);
  try {
    const store = await lensStore();
    const events = refusesViewer(viewer) ? [] : await store.listEvents(viewer, session);
    return NextResponse.json({ store: store.kind, backend: store.describe, events });
  } catch (e) {
    return unavailable(e);
  }
}

/** Deletes for real: a selection label can still name a customer. */
export async function DELETE(req: Request) {
  const viewer = await viewerOf(req);
  if (refusesViewer(viewer)) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  try {
    return NextResponse.json({ deleted: await (await lensStore()).deleteEvents(viewer) });
  } catch (e) {
    return unavailable(e);
  }
}

function unavailable(e: unknown) {
  return NextResponse.json(
    { error: `log store unavailable — ${String(e instanceof Error ? e.message : e).slice(0, 300)}` },
    { status: 503 },
  );
}
