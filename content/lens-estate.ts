import type { LensCatalogReport } from "@/content/lens-demo";

/**
 * The LIVE estate — the Power BI reports this deployment embeds (LENS_MOCK=0), keyed by the Power
 * BI report id. The browser only ever names one of these keys: the embed broker never takes a
 * workspace or report id from the page, so "open" cannot be steered at an arbitrary item, and
 * Power BI still checks that the signed-in user can see the report.
 *
 * Page ids are the report's section ids (the `pageName` of a Power BI page; where to read them
 * in the report's URL: docs/entra-setup.md §3). `covers` is the text
 * the agent's `find_report_page` matches; write what the page answers, in your users' words.
 * A missing `datasetId` is read from Power BI at ask time.
 *
 * If a Databricks report catalogue is configured (LENS_CATALOG_*), a catalogue hit opens here
 * unchanged — keep both on the same report ids.
 *
 * Example:
 *
 *   {
 *     report_id: "<power-bi-report-id>",
 *     name: "Sales",
 *     module: "Sales",
 *     description: "Revenue against plan by month, region and product.",
 *     env: "demo",
 *     binding: { workspaceId: "<workspace-id>", reportId: "<power-bi-report-id>" },
 *     pages: [{ page: "<section-id>", title: "Overview", covers: "Revenue against plan, month by month" }],
 *   },
 */
export const LIVE_CATALOG: LensCatalogReport[] = [];
