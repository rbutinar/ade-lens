import type { SourceKind } from "@/lib/page-context";

/**
 * The ONE contract every source speaks — a parametrized
 * tool-loop, where each backend (DAX / SQL / engine) returns the same shape.
 * Add a source = implement this; the agent loop and the API never change.
 */
export interface QueryColumns {
  columns: string[];
  rows: Array<Array<string | number | null>>;
}
export interface QueryError {
  error: string;
}
export type QueryResult = QueryColumns | QueryError;

export function isError(r: QueryResult): r is QueryError {
  return (r as QueryError).error !== undefined;
}

/** Query dialect a source expects, so guards/prompts can specialize. */
export type Dialect = "dax" | "sql" | "qlik";

export interface SourceAdapter {
  kind: SourceKind;
  dialect: Dialect;
  /**
   * Execute a READ-ONLY query. The auth token is passed per-call and NEVER
   * stored server-side — it is relayed transiently to the data plane, which
   * enforces the user's own visibility (RLS / Unity Catalog).
   */
  execute(
    query: string,
    binding?: Record<string, string>,
    token?: string,
  ): Promise<QueryResult>;
}
