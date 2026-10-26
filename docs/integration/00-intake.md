# 00 · Intake — describe your portal

Fill this in before (or while) reading level 0. Most of level 0's choices are made by these answers,
and several of them are not yours alone — the Power BI tenant admin and the data owners hold some.
"Don't know yet" is a valid answer: it tells us what to find out first.

Answer inline, under each question.

## A. Who the viewers are — this decides the identity road

1. **Who opens the reports?** Employees of the tenant that holds Power BI, external users (partners,
   customers), or both?
2. **How do they sign in to your portal?** Identity provider (Entra ID of the same tenant, Entra
   External ID / B2C, Entra B2B guests, another IdP), and the protocol (OIDC, SAML, …).
3. **How does your SERVER know who the user is?** The validated token or session it receives, and
   **the exact claim that identifies the user** (e.g. `oid`, `email`, a custom `partner_id`).
4. **How does a user map to the rows they may see?** One organisation per user? Several? Where does
   that mapping live today (the identity provider, a database, the data platform)?
5. **Roughly how many viewers**, and do they each have a Power BI licence (Pro / PPU) in the tenant?

## B. The reports and the data behind them

6. **Which reports** go into the portal first (names, workspace)? Who maintains them?
7. **Is RLS defined** in their semantic models? If yes: which roles, filtering which table/column,
   and does the rule use `USERPRINCIPALNAME()` / `USERNAME()` or a static value per role?
8. **Storage mode** of each model: Import, DirectQuery (to what — e.g. Databricks), or composite?
   If DirectQuery: whose identity reaches the source (single sign-on, or a fixed credential)?
9. **Capacity** of the workspaces: shared, Premium (P), Embedded (A/EM) or Fabric (F) — and which
   SKU? *(The tenant admin can read it in the admin portal → Capacity settings.)*

## C. Your portal's technical shape

10. **Frontend**: framework and version (or plain pages)? Does your portal itself run **inside an
    iframe** of another site?
11. **Backend**: language / runtime, and where it is hosted?
12. **Content Security Policy**: do you set one? Who owns it? (Level 0 needs `frame-src` for Power BI.)
13. **Secrets**: where does your backend keep secrets (a vault, platform secret store, env vars)?
    Who rotates them?
14. **App registration**: is there already an Entra app registration for this portal's Power BI
    access? Is it **shared** with any other application?

## D. What you want on screen

15. Should the viewer see Power BI's own **filter pane** and **page tabs**, or does your portal
    provide its own navigation?
16. Do you need to open a report **on a specific page** (deep links from elsewhere in the portal)?
17. **Interaction log** (level 2): do you need to know who looked at what? Where may such events be
    stored, and for how long? Any analytics tool already in the portal (GA4, App Insights, …)?
18. **Export to Excel** (level 3): wanted? Of what the viewer sees only, or more?

## What happens with your answers

- **A + B** decide the identity road in [level 0 §1](01-level-0-secure-embed.md#1-choose-the-identity-road)
  — the most consequential choice in the whole kit.
- **B.7** is a precondition: on the road most external portals take, a model without RLS shows
  every viewer everything.
- **C** decides how the broker and the embed are wired; **D** decides levels 1–3.
