"use client";

/**
 * The interaction log's client half: keep the on-screen list, queue what the server has not
 * acknowledged, drain it in batches, and say honestly what the server did with it.
 *
 * Re-sent until acknowledged — the server is idempotent per (session, event id), so a retry can
 * never become a second click. The viewer is never sent: the server asserts it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LensEvent } from "@/lib/lens/contract";
import { lensApi, type LogAck } from "@/components/lens/api";

export function useLensLog() {
  const pending = useRef<LensEvent[]>([]);
  /** One per page load: groups a sitting's events without the browser claiming an identity. */
  const [sessionId] = useState(() => crypto.randomUUID());
  const [events, setEvents] = useState<LensEvent[]>([]);
  const [ack, setAck] = useState<LogAck | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stored, setStored] = useState(0);

  const record = useCallback((e: LensEvent) => {
    pending.current.push(e);
    setEvents((prev) => [...prev.slice(-199), e]);
  }, []);

  useEffect(() => {
    let busy = false;
    const tick = async () => {
      if (busy || !pending.current.length) return;
      busy = true;
      const batch = pending.current.slice(0, 100);
      try {
        const res = await lensApi.logEvents(sessionId, batch);
        pending.current = pending.current.slice(batch.length);
        setAck(res);
        setFailure(null);
        setStored((n) => n + res.stored);
      } catch (e) {
        setFailure(`not acknowledged, will retry — ${String(e).slice(0, 160)}`);
      } finally {
        busy = false;
      }
    };
    const h = window.setInterval(() => void tick(), 1500);
    return () => window.clearInterval(h);
  }, [sessionId]);

  return { events, record, ack, failure, stored, sessionId };
}

/** Whether what is on screen is also on the server, where, and attributed to whom. */
export function RecordingLine({ ack, failure, stored, sessionId }: ReturnType<typeof useLensLog>) {
  if (failure) return <p className="text-xs text-rose-700">Not recording — {failure}</p>;
  if (!ack) return <p className="text-xs text-gray-500">Waiting for the first acknowledgement…</p>;
  // Short on screen, full on hover: for most readers a session id and "claims read, not
  // verified" are noise. The full truth is the tooltip.
  const detail = `store: ${ack.backend}${ack.viewer && !ack.viewer_verified ? " · identity read from the token's claims, not verified" : ""}`;
  return (
    <p className="text-xs text-gray-600" title={detail}>
      Recorded on the server: <strong>{stored}</strong> event{stored === 1 ? "" : "s"} · as{" "}
      <strong>{ack.viewer || "no identity (mock / not signed in)"}</strong> ·{" "}
      {ack.store === "sqlserver" ? "stored in SQL Server" : "stored in memory for this demo"} · session{" "}
      <code className="font-mono">{sessionId.slice(0, 8)}</code>
      {ack.rejected.length > 0 && <span className="text-rose-700"> · {ack.rejected.length} rejected</span>}
    </p>
  );
}
