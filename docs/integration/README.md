# Integration kit — embedding Power BI reports in your portal, the ade-lens way

This kit is for a developer who wants, inside **their own portal**, what ade-lens does around an
embedded Power BI report: a secure embed, a page that knows what the report shows and can drive it,
an interaction log, and — later — an assistant on top. It is written to be applied in **any stack**:
the browser side is the public `powerbi-client` JavaScript SDK (any framework, or none), the server
side is a handful of Power BI REST calls plus rules (any language). TypeScript appears only as
illustration.

You do not need ade-lens's code to follow it, and it does not ship any. What it carries is the
shape, the rules, and the known pitfalls.

## Levels

Build them in order; each one is usable on its own and ends with a **"done when"** checklist you can
test.

| Level | What you build | Page |
|---|---|---|
| **—** | Describe your portal (one page to fill in) | [00-intake.md](00-intake.md) |
| **0** | **The secure embed** — a server-side token broker, the SDK embed, switching reports cleanly, honest loading/failure states, token refresh | [01-level-0-secure-embed.md](01-level-0-secure-embed.md) |
| **1** | **The page and the report talk** — read the report's live state out, drive pages and filters in, without reloading | [02-level-1-page-report-contract.md](02-level-1-page-report-contract.md) |
| **2** | **Observability** — a server-side interaction log, attributed by the server | [03-level-2-interaction-log.md](03-level-2-interaction-log.md) |
| **3** | **Extras** — Excel export of a page or a whole report, a catalogue that opens the right report on the right page | [04-level-3-extras.md](04-level-3-extras.md) |
| 4 | An assistant that reads and drives the report | out of scope here — [level 3 §C](04-level-3-extras.md#c-level-4-for-orientation--out-of-scope-here) says what it would add and why levels 1–3 are its foundation |

## How to read the labels

Every claim that matters carries one of two labels:

- **VERIFIED** — run by us in ade-lens against a real Power BI tenant, with the date. It worked as
  written *there*; your tenant may still differ.
- **DESCRIBED** — documented by Microsoft or reasoned from how the pieces work, but **not exercised
  by us**. Treat it as the plan, and test it first.

If something in your build contradicts a VERIFIED line, open an issue: it is a defect of the kit.

## The one rule that is not negotiable

Which rows a viewer may see is decided **by the Power BI engine, bound to an identity** — row-level
security (RLS) in the semantic model. Never by report filters, embed filters, or `WHERE` clauses
over a connection that can see everything. Filters are presentation: a removed filter, a bug, or a
curious user defeats them. Level 0 is built around this.

## Feedback

Every time something was missing to get a level working, that is a gap in this kit.
Open an issue; the page gets fixed rather than answered in chat.
