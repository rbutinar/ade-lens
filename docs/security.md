# ade-lens — security guardrail (non-negotiable)

**Principle:** row-level isolation is enforced at the **engine / data plane, bound to identity** —
NEVER by application code or report filters over a broadly-scoped connection.

## The pattern we BLOCK

A technical account — a Power BI embed token **or** a Databricks service principal — with **broad
access to all rows**, where each user's "slice" is produced by **filters**: report/embed filters
(Power BI) or `WHERE` clauses in application code (Databricks).

Why it is not security:

- Filters are presentation/convenience, **not a boundary** — the connection can already see everything.
- Two things defeat it trivially:
  1. **the agent**, which writes its own queries (NL → DAX/SQL) — one unconstrained query reads every
     user's data;
  2. any **bug / injection / removed filter**.
- Net: a data breach waiting for a curious user or a malformed prompt.

This is the pattern real designs drift toward, because it is the easiest to build. **It is blocked.**

## The patterns we ALLOW (enforcement below whatever writes the query)

### Power BI
RLS defined in the semantic model, applied by the engine, bound to identity:
- **User-owns-data (OBO):** the real user identity → the engine applies *their* RLS. (ade-lens default.)
- **App-owns-data:** a service principal + an **effective identity/role asserted server-side** at
  `GenerateToken` and on `executeQueries` (`impersonatedUserName`) → the engine applies RLS for that
  identity. Fine for external users.

> A service principal is acceptable **only** with effective identity + RLS — never a broad token + filters.

### Databricks (higher stakes — arbitrary SQL, no UI constraint)
- **Unity Catalog row filters / column masks / dynamic views**, keyed to identity or group
  (`current_user()`, `is_account_group_member()`, or a server-validated user mapping) → the lakehouse
  returns only permitted rows regardless of the query or who runs it.
- The **agent queries the same UC-governed tables/views** → automatically row-filtered.
- Anti-pattern (blocked): one SP with `SELECT` on full tables + app-injected `WHERE customer = …`. With an
  NL→SQL agent on top, that is full-lakehouse exposure.

## Rule of thumb

Enforcement must live at a layer **below** whatever writes queries — the application, and **especially
the agent**: the Power BI engine (RLS) or the lakehouse/DB (Unity Catalog / Postgres RLS). If the only
thing standing between a user and everyone else's data is application code or a filter, it is not secure.

## App identities

The open core reaches Power BI as the signed-in user only (OBO). A deployment that adds an app
identity (a service principal) must do it under a scoped exception it writes down itself, never as
the default road, and never on data that differs by viewer.
