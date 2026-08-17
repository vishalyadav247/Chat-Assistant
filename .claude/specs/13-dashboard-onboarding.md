# 13 — Dashboard & Onboarding

> The app home: greeting, KPIs, setup checklist, live conversation feed.
> Sources: design `dashboard.html` + NOTES.md; metrics from analytics events (14 shares aggregation); checklist state from feature specs.

## Purpose

`/app` (index route): first screen after install — time-of-day greeting, headline KPIs, 6-step onboarding checklist with real completion detection, live conversations feed.

## UI (per design)

### Hero
"Good {morning/afternoon/evening}, {shop name} 👋"; dynamic subline (waiting-question count + assisted revenue this month); pulsing "Assistant online" pill (AI active state from 07 master switch). Actions: **Answer N questions** (→ unresolved queue 07), **Sync catalog** (→ enqueue sync 02), **Preview widget** (→ storefront URL with widget open).

### Overview card
Range dropdown Last 7 days / 30 days / 12 months; compare-to label (previous equal period); Updated + Reload. KPIs (count-up animation):
- Total conversations (▲% vs compare)
- **Live conversations** (open convos with activity <5 min — polled every ~5s)
- Assisted revenue (shop currency: orders attributed to chat via cart attribute / ATC attribution v1)
- Total sales share contributed by app (assisted revenue ÷ shop total sales for period — needs shop sales; v1 if orders scope absent: show assisted revenue growth instead, flag as deferred)
- Resolution rate (resolved ÷ total, footer "Resolved: X · Total: Y")

### Setup checklist
Progress ring N/6; rows with To do/Done pills + deep links; completion detection:
1. **Embed app to your theme** → settings?tab=general; done = app embed enabled in published theme (Admin API themes/asset check or app-embed status API)
2. **Customize your chatbox widget** → /app/chatbox; done = WidgetSettings saved ≥1
3. **Sync your product & store data** → ai-agent training; done = ≥1 successful catalog sync
4. **Set up AI instructions** → ai-agent instructions; done = persona role+style saved
5. **Publish your first five curated answers** → curated-answers; done = published count ≥5
6. **Launch a proactive chat campaign** → proactive-chat; done = ≥1 active campaign
Checklist collapses/celebrates at 6/6.

### Live conversations feed
Latest active conversations: avatar initials, question preview, tag Live ("AI is typing…", "shopper replied Xs ago", "AI shared N products") or Waiting for agent ("handover Xs ago"); click → inbox thread. Poll with the live KPI.

## Business rules

- All metrics shop-scoped, computed from analytics_event + conversation rows; compare = previous equal-length period.
- Polling endpoints lightweight (counts only); no N+1.
- Greeting uses shop timezone (16 settings; fallback shop.iana_timezone).

## Acceptance criteria

1. Checklist steps flip to Done from real state changes (each verified); ring accurate; deep links land on the right tabs.
2. KPIs match seeded/known event data across all three ranges; deltas vs compare correct.
3. Live count + feed update within poll interval while a storefront chat is active.
4. Sync catalog button enqueues job with toast; Preview widget opens storefront.
5. Hero waiting-count equals unresolved queue size.

## Out of scope / gaps

Sales-share KPI pending orders-data decision (PCD); "Compare to" custom ranges; feed websockets.
