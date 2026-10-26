"use client";

import { getApiToken } from "@/lib/auth/browser";
import type { LensAnswer, LensCall, LensEvent, LensState } from "@/lib/lens/contract";

/** Every Report Lens call carries the user's api-scoped token when there is one — the server
 *  exchanges it (OBO) and resolves the viewer from it; nothing else names the user. */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const t = await getApiToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || (d as { error?: string }).error) {
    throw new Error((d as { error?: string; hint?: string }).hint ?? (d as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return d as T;
}

export interface LensStatus {
  /** obo = as the signed-in user; sp = an app identity, when the deployment's plane has one. */
  road: "mock" | "obo" | "sp";
  agent: { kind: "mock" | "model" | "off"; detail: string };
  log: { recording: boolean; store: "memory" | "sqlserver"; backend: string };
  catalogue: "file" | "databricks";
  reports: Array<{ report_id: string; name: string; module: string }>;
}

export interface LogAck {
  recording: boolean;
  store: "memory" | "sqlserver";
  backend: string;
  viewer: string;
  viewer_verified: boolean;
  stored: number;
  duplicates: number;
  rejected: string[];
}

export interface ConversationRow {
  conversation_id: string;
  title: string;
  turns: number;
  last_report_id: string;
  last_report_name: string;
  last_page?: string;
  last_page_title?: string;
  last_at: number;
}

export interface ConversationFull extends Omit<ConversationRow, "turns"> {
  turns: Array<{ question: string; answer: string; trail: string[]; calls: LensCall[]; at: number }>;
}

export const lensApi = {
  status: () => call<LensStatus>("/api/lens"),
  embedToken: (reportId: string) =>
    call<{ token: string; embedUrl: string; reportId: string; mock?: boolean }>("/api/embed-token", {
      method: "POST",
      body: JSON.stringify({ reportId }),
    }),
  ask: (body: {
    question: string;
    history: Array<{ role: "user" | "assistant"; text: string }>;
    report_id: string;
    context: LensState;
    interactions: Array<{ label: string; detail?: string }>;
    conversation_id: string | null;
  }) => call<LensAnswer>("/api/lens/ask", { method: "POST", body: JSON.stringify(body) }),
  logEvents: (session_id: string, events: LensEvent[]) =>
    call<LogAck>("/api/lens/events", { method: "POST", body: JSON.stringify({ session_id, events }) }),
  conversations: () => call<{ conversations: ConversationRow[] }>("/api/lens/conversations").then((d) => d.conversations),
  conversation: (id: string) => call<ConversationFull>(`/api/lens/conversations?id=${encodeURIComponent(id)}`),
  deleteConversation: (id: string) =>
    call<{ deleted: boolean }>(`/api/lens/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
};
