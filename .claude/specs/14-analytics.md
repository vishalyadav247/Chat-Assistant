# 14 — Analytics

> Reporting on conversations, resolutions, satisfaction, funnel, and questions.
> Sources: design `analytics.html` + NOTES.md; events from 03/05/10/12/16; shares aggregation with 13.

## Purpose

`/app/analytics`: read-only reporting page. Data source = `analytics_event` + conversation/message rows, aggregated per shop and range.

## UI (per design)

- **Overview card**: same 5 KPIs + ranges as dashboard (shared component, spec 13).
- **Total conversations over time**: smoothed line chart, **Human vs AI agent** series legend, own range dropdown (Last 7 days / 30 days / 3 months). Series: conversations bucketed by day (12m → month), split by whether a human participated (mode ever = human).
- **How conversations resolved**: donut, center "N% resolved"; segments Resolved by AI / Resolved by human / Unresolved. (Resolved-by = who resolved or last actor before auto-resolve.)
- **Customer satisfaction**: avg score (1 decimal), "from N responses", 5→1★ histogram bars with counts (survey results, 16).
- **Recommendation funnel**: Recommendations shown (100%) → Added to cart (%) → Purchased (%) — events recommended / atc / purchase-attributed.
- **Response performance**: Avg first response (s, ▼ faster is good), Avg resolution time, Answered on first try (% conversations with no fallback before first resolution), Handed to human (count, ▲ styled negative).
- **Top questions**: top 5 question clusters (embedding-clustered or normalized text v1) + "N asks" + relative bars.
- **Export CSV** (Plus gate): conversations export + analytics export as async job → download. (Design gap: no button drawn on page — add one in header, gated.)

## Aggregation

- Nightly rollup job (pg-boss cron) into a `MetricsDaily` table (shopId, date, counters) + on-demand compute for today; ranges read rollups (fast) — avoids scanning events per page view.
- Chart data endpoints return series JSON; UI renders with a lightweight chart lib compatible with Polaris (or hand-rolled SVG like design).

## Business rules

- Shop-scoped; ranges in shop timezone; compare = previous equal period.
- Test-AI conversations (08) excluded everywhere.
- CSAT only from completed surveys; funnel purchase attribution = cart-attribute method (12) until orders scope lands.

## Plan gating

Exports (analytics CSV + conversation exports): Plus. "Unanswered-questions analytics" (Basic+ per plan copy) = the top-questions/unresolved views — Free sees teaser lock.

## Acceptance criteria

1. Each widget matches seeded event fixtures (deterministic test data → exact numbers).
2. Human/AI split correct when a conversation transitions modes; donut sums 100%.
3. First-response/resolution averages computed from message timestamps correctly.
4. Rollup job idempotent (re-run same day → same numbers); today included live.
5. Exports produce correct CSVs, Plus-gated server-side; Free lock on unanswered-questions view.

## Out of scope / gaps

Custom date ranges, cohorting, per-campaign drilldowns (12 shows its own), true order attribution (PCD).

## Build deltas (v1 implementation notes)

- **isTest exclusion source**: `AnalyticsEvent` rows carry no isTest flag (pipeline events fire for Test-AI turns too), so rollup counters that map to events are derived from `Message` rows joined to non-test conversations instead — `curatedServed` ← sourceLayer `curated`, `recommendationsShown` ← `recommendation|buy|buy_browse`, `fellBack` ← `clarify|rag_fallback`, `handovers` ← distinct conversations with a `handover` message. Only `atc` reads `added_to_cart` events (never recorded by Test AI). Mapping mirrors exactly where each event fires in the pipeline.
- **Human/AI split**: "mode ever human" approximated as `Conversation.handover = true` (v1); resolved-by = `status=resolved` split on the same flag.
- **Ranges**: chart/widget range set is 7d / 30d / 3m with daily buckets (design's `#lcRangeMenu`); spec's "12m → month" bucketing deferred with the 12m range. Overview card reuses spec 13's `DashboardOverview` + `dashboardMetrics` (7d/30d/12m) unchanged. Donut/funnel/performance follow the chart's range dropdown.
- **Rollup freshness**: nightly pg-boss cron `analytics-rollup` (`37 2 * * *`, re-rolls yesterday + today per shop); reads lazily backfill missing days in-window and always recompute today live. Counters JSON additionally stores `firstResponseCount`/`resolutionCount` so multi-day averages merge weighted.
- **Answered on first try**: v1 = conversation has zero fallback turns (not "before first resolution").
- **Funnel "Purchased"**: renders "—" (attribution deferred, spec gap already noted). **Top questions**: normalized-text grouping over the 500 most recent shopper messages (cheapest correct v1; embedding clustering later).
- **Exports**: synchronous action → client-side Blob download (contacts pattern), not an async job — row cap 5000 conversations. Gate `requirePlan(plan, "exports")` server-side inside the export functions (open enforcement passes today); unanswered mini-card gates on `unanswered_analytics`.
- **CSAT**: computed from `Conversation.rating` (all-time, isTest excluded), not from `survey_submitted` events.
- Verified by `scripts/test-analytics.ts` (deterministic 3-day fixture, run green 2026-08-06).
