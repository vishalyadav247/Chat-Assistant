# 16 — Settings

> Store info, theme/embed, inbox behavior, team, chat availability, satisfaction survey, order tracking, privacy controls.
> Sources: design `settings.html` + NOTES.md (3 tabs + 2 sub-views, hash deep links); privacy tab pairs with spec 17.

## Purpose

`/app/settings` with `?tab=` routing (was hash; changed 2026-08-17 for URL-param consistency with the AI-agent pages): **General**, **Chatbox**, **Privacy & Data Requests**; sub-views **Chat availability** (?tab=availability) and **Satisfaction survey** (?tab=survey) deep-linked from chatbox settings (06).

## Data model

`Settings`-scope fields on Shop or a `ShopSettings` JSON row: storeInfo {name, logoUrl}, theme {mode: auto|dawn|refresh|craft|custom}, inbox {autoResolve: bool, after: int, unit: minute|hour|day}, availability {…below}, survey {…below}, orderTracking {mode: default|custom, customUrl}, cartDrawer: bool, retentionDays (17).

## Tab: General

- **Store information**: name field, logo upload (avatar initials fallback) — "shown in conversations" (widget store-branding avatar, 06).
- **Theme**: storefront theme select Auto-detect (recommended)/Dawn/Refresh/Craft/Custom — informs cart-drawer integration hints; **"App is embedded to your theme"** status badge On/Off + Turn on/off button → deep link to theme editor app-embed activation (`https://{shop}/admin/themes/current/editor?context=apps&activateAppId={uuid}/chat-widget`); status detected via Admin API (main theme settings_data check) — feeds onboarding step 1 (13).
- **Inbox**: Automatic resolution toggle + "Auto resolve after N {Minute/Hour/Day}" (default 60 min) → consumed by 10.
- **Team member**: Invite member button **disabled** (v1 single-user; tooltip "coming soon"), search/sort, table Name|Email|Member since|Role|Status — shows owner row (Admin/Active).

## Tab: Chatbox

- **Chat availability** → Manage (sub-view below)
- **Satisfaction survey** → Manage (sub-view below)
- **Open cart drawer after add to cart** toggle (ON default) → widget behavior (05).
- **Order tracking**: radios Default tracking (widget shows the order-number form only — in-widget status card, no tracking-number tab) / Custom tracking + URL field (e.g. `www.delhivery.com/track-v2/package/`, supports a `{number}` placeholder) shown only when custom / **Integrate with tracking app** (delta 2026-08-14, per Chatty's `ordertracking3.png`): provider list (17Track live; TrackingMore/Track123 "Coming soon") + API key + Connect. Connect validates the key via 17Track `/getquota` BEFORE persisting (`connect-tracking` intent, `seventeen-track.server.ts`); Disconnect clears it. The key is server-only — widget config strips it, and the regular chatbox Save never touches it (SaveBar slice excludes apiKey). Integration mode → widget tracking-number tab shows real-time shipment status in-chat via `proxy.order-track`, and order lookups are enriched with the provider's live status.

## Sub-view: Chat availability

- **Working hours**: radio "24 hours / 7 days" or Custom → 7 day rows (checkbox + from/to time inputs; unchecked disables inputs; default Mon–Fri 9–5).
- **Show online status**: radios During working hours / …or when any agent online / Only when an agent is online during working hours ("AI still replies while offline").
- **Break time** toggle + ranges + "Add break time"; **Holiday** toggle + name + date range + "Add holiday".
- **Status messages** with `{{schedule}}` merge: Online ("We are online"), Offline ("We're away · Back {{schedule}}"), Break ("On break · Back at {{schedule}}"), Holiday ("Off today · Back at {{schedule}}").
- **Time zone** select (full IANA list, not just design's 4).
- Cancel/Save.
- Consumers: widget status line (05), handover aiWhileWaiting=outside_hours (08/10), online-status display logic ("agent online" = admin session active in inbox v1).

## Sub-view: Satisfaction survey

- **Format** cards: Star rating / Emoji scale (😞🙁😐🙂😍 → 1–5).
- **Content**: intro ("How was your experience?"), thank-you message.
- **Trigger time** (any criterion met): checkbox on-resolve; checkbox keyword-triggered → chip input (Enter add, ✕ remove; seeds "Thank you, Thanks, Got it, That helps, Perfect").
- Consumers: widget prompt (05), rating stored on conversation (10), CSAT analytics (14). Once per conversation.

## Tab: Privacy & Data Requests (UI here; workflows in 17)

- **Customer data requests**: explainer (Shopify sends requests; ChatConvert compiles chat data for that email; **30-day SLA**), request list (date, customer, status, Download export) + empty state.
- **Data retention**: "Keep transcripts for" select Forever/90/60/30/7 days + Save; deletion runs daily; independent of Shopify webhooks.
- **How redaction works** info card (customers/redact deletes that customer's conversations; shop/redact ~48h after uninstall purges all; only stored customer info = optional email).

## Implementation deltas (2026-08-06 build)

- Timezone persists on `Shop.timezone` (not in the ShopSettings JSON); `getShopConfig` reads it from Shop.
- Embed deep link uses `?context=apps` without `activateAppId` (extension uuid unavailable pre-deploy); real embed detection deferred to 13.
- Sub-view Save/Cancel coexists with the contextual save bar (same fetcher/dirty state).
- Owner row shows "Active"; sort omitted (single member v1).

## Business rules

- All saves validated (zod) + shop-scoped; availability times stored in shop timezone.
- `{{schedule}}` resolves to next opening time from working hours/breaks/holidays.
- Embed status cached (5 min) — theme asset checks are slow.

## Acceptance criteria

1. All tabs/sub-views round-trip; `?tab=` deep links (availability, survey, general, chatbox, privacy) land correctly from 06's links.
2. Embed badge reflects real theme state; Turn on deep-links to theme editor; onboarding step 1 flips when enabled.
3. Availability: custom hours + break + holiday produce correct widget status strings incl. resolved {{schedule}}; timezone honored.
4. Survey triggers: resolve-trigger and keyword-trigger each fire once; rating lands in analytics.
5. Auto-resolve setting drives inbox behavior (10 test).
6. Custom tracking URL appears in widget tracking screen.
7. Retention select persists; daily job honors it (verified in 17).

## Out of scope / gaps

Team invites (disabled), "Widget Appearance" leftover tab (dead CSS in design — not built), per-agent online presence beyond admin-session heuristic.
