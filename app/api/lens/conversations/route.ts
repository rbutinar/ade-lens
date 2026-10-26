import { NextResponse } from "next/server";
import { lensStore, refusesViewer, viewerOf } from "@/lib/lens/store";

/** Saved Report Lens chats — the viewer's own only. `?id=` reads one, WITH its trail. */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  const viewer = await viewerOf(req);
  if (refusesViewer(viewer)) return id ? NextResponse.json({ error: "not found" }, { status: 404 }) : NextResponse.json({ conversations: [] });
  try {
    const store = await lensStore();
    if (!id) return NextResponse.json({ conversations: await store.listConversations(viewer) });
    const c = await store.getConversation(viewer, id);
    return c ? NextResponse.json(c) : NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return unavailable(e);
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const viewer = await viewerOf(req);
  if (refusesViewer(viewer)) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  try {
    return NextResponse.json({ deleted: await (await lensStore()).deleteConversation(viewer, id) });
  } catch (e) {
    return unavailable(e);
  }
}

function unavailable(e: unknown) {
  return NextResponse.json(
    { error: `chat store unavailable — ${String(e instanceof Error ? e.message : e).slice(0, 300)}` },
    { status: 503 },
  );
}
