# 05 — Storefront Chat Widget

> The shopper-facing product: theme app extension + app proxy + streamed chat.
> Sources: design `chatbox.html` live-preview widget (authoritative UI/flows) + NOTES.md; `PRODUCTION-BUILD-SPEC.md` §4; foundation transport (01).

## Purpose

A self-contained chat widget injected via theme app extension: launcher → home/chat/order-tracking screens, streaming AI replies with product cards, pre-chat forms, contact methods — fully driven by the shop's `WidgetSettings` (06) and availability (16).

## Scope

In: widget UI + state machine, settings fetch, session handling, streaming client, product cards + add-to-cart, order-tracking UI, pre-chat forms, FAQs display, contact methods, satisfaction survey display, branding.
Out: settings admin UI (06), pipeline (03), inbox/human replies transport (10 extends the same channel), campaigns triggering the widget (12).

## Architecture

- `extensions/chat-widget/`: app-embed block (liquid) + vanilla JS/CSS bundle (no framework — size + theme-safety; no external CDNs). Shadow DOM (or namespaced classes) to isolate from theme CSS.
- Boot: fetch `/apps/chatconvert/widget-config` (app proxy, cached 5 min) → settings JSON (widget settings + availability status + featured FAQs + starters + branding). Renders nothing if app disabled/uninstalled (proxy 404 → silent).
- Session: `sessionId` UUID in localStorage; `conversationId` returned by first message; `{{customer_name}}` resolved from logged-in customer (liquid `customer.first_name`) else "there".
- Chat transport: POST `/apps/chatconvert/chat` `{sessionId, conversationId?, message, pageContext}` → SSE frames (token/cards/message/done) via fetch-stream reader. Reconnect/resume: on drop, re-POST with `resume: true` is NOT supported v1 — show retry affordance.
- Human-mode messages (10): widget polls `/apps/chatconvert/messages?since=` every 5s while conversation `mode=human` (upgrade to SSE subscription later).

## Screens & flows (parity with chatbox.html preview — the design's most valuable artifact)

### Launcher
Style: icon / label / icon+label ("Chat with us"); icon chat/help/custom-upload; position bottom-right/bottom-left/top-right/top-left; brand color solid or gradient (`--cw1/--cw2`). Click toggles panel; X minimizes to launcher.

### Home screen
- Header: logo, chatbox name, description, online-status line from availability (16): "We are online" / "We're away · Back {{schedule}}" / break / holiday variants.
- Blocks (each toggled by settings; all off → empty state "Enable a feature to see it here."):
  - **Contact us**: status + "Chat now" button + contact-method icon chips (WhatsApp wa.me link, tel:, mailto:)
  - **Order tracking**: "Track your orders" row → tracking screen
  - **FAQs**: "Search for help" + featured questions (from 07); tap → answer view; search filters featured set (server search of published FAQs)
- Footer "Powered by ChatConvert" unless removed (Basic+ gate).

### Chat screen
- Back arrow → home (hidden when chat-focus-mode on and livechat enabled: opens directly to chat).
- Welcome bubble (welcomeMessage, offline variant if configured + currently offline).
- Conversation starter chips (when enabled): tap → sends the question; answers may be canned (starter answerHtml) without pipeline call.
- Input → streamed reply bubbles; typing indicator while first token pending.
- **Product cards**: image, title, price (shop currency), View → product page; **Add to cart** → `/cart/add.js` (theme AJAX API) with variant id; on success honor "open cart drawer after add to cart" setting (16): minimize chat + trigger theme drawer, else stay + confirm in-chat.
- Pre-chat form (per settings: guest/anonymous/both; "show form after X messages"): fields Email (required) + optional Name/Phone; marketing opt-in checkbox → contact.marketingOptIn (11); disclaimer consent text when enabled. Submissions create/update `Contact` and attach to conversation.
- Handover states (10): system messages ("Handed over to a human agent."), "a team member will reply" mode, contact-method fallback, leave-a-message form per handover config (08).
- Satisfaction survey (16): star/emoji prompt per trigger rules; result → conversation rating.

### Order tracking screen
Tabs **Order number | Tracking number**; order-number mode asks Email/Phone radio + value; Track → v1: link out per settings (16): default = carrier page / custom tracking URL template; order-status-via-API is deferred (read_orders/PCD). Placeholders per design (`e.g. 1001`, `e.g. AA12345`).

## Business rules

- Widget never calls the LLM; only app-proxy endpoints. No API keys in assets.
- All proxy endpoints authenticate via `authenticate.public.appProxy`; shop resolved from proxy params — never from client input.
- Respect availability: offline + no livechat → AI still replies (per settings copy "The AI assistant still replies while offline").
- Accessibility: keyboard focus trap in panel, aria-live on message list, prefers-reduced-motion.
- Performance (app review): script deferred, <30KB gz initial, no layout shift; nothing loads until consent-safe (no tracking cookies; sessionId is functional storage).
- i18n: all widget strings come from settings/server (translation-ready); currency formatted per shop.

## Implementation deltas (2026-08-06 build)

- Add-to-cart: cards carry a numeric `variantId` (first available variant from the catalog mirror); one-click `/cart/add.js` when present, product-page fallback otherwise or on AJAX rejection. Cart-drawer handoff = progressive enhancement (`cart:refresh` event + `<cart-drawer>` open), `/cart` navigation fallback.
- FAQ search filters the featured set client-side v1 (server-side FAQ search lands with 07).
- Storefront analytics via `proxy.event` beacon (allow-listed types); widget_opened + added_to_cart emitted v1.
- Order tracking (2026-08-14, merchant request): **order-number tab does an instant in-widget lookup, no login** — `POST /apps/chatconvert/order-track` (`proxy.order-track.tsx`, `read_orders`) matches the number (alnum suffix match, prefix-tolerant) and verifies the shopper's email/phone against the order before returning a minimal status payload (name/status/total/items/fulfillments+tracking, never the order's own PII); renderer `orderStatusCard` renders it per `ordertracking.png`. **Forms are gated by the tracking mode (16):** default → order-number form only (no tabs); custom → both tabs, Tracking number → Track opens the merchant's custom URL (scheme-normalized, `{number}` placeholder else appended) in a new tab via a real anchor click; integration → both tabs, Tracking number → `POST /order-track {trackingNumber}` renders the provider's live shipment card. The admin Chatbox preview mirrors the same gating. Production needs protected-customer-data approval in the Partner Dashboard. **Known limit:** `read_orders` only exposes the last 60 days of orders — older orders return "not found"; request `read_all_orders` (Partner Dashboard → API access → Access requests) before launch if full-history lookup is wanted.
- No Shadow DOM — strict `.cw-` namespace + reset (theme-asset simplicity).
- Handover/leave-message widget UI lands with 10; campaign triggers with 12; direct-domain streaming is a seam (`window.__ccDirectStream`).

## Plan gating

- Remove "Powered by ChatConvert": Basic+.
- Conversation caps: when shop's monthly meter exhausted and overage disabled (Free) → widget shows contact/leave-message mode instead of AI (spec 15 rules).

## Dependencies

01 (proxy/SSE), 03 (pipeline), 06 (settings shape), 16 (availability/survey/tracking), 10 (human mode), 15 (gates).

## Acceptance criteria

1. Widget renders on dev-store storefront via app embed; all launcher variants + brand colors apply from saved settings.
2. Home blocks reflect toggles live (settings change → next config fetch), empty state correct.
3. Full chat round-trip streams token-by-token; product cards clickable; add-to-cart adds and honors drawer setting.
4. Pre-chat form modes (guest/anonymous/both + after-X-messages) gate correctly; contact created with opt-in flag.
5. Order tracking screen matches design; custom tracking URL used when configured.
6. Uninstalled/disabled app → storefront shows nothing and no console errors.
7. Lighthouse: no CLS from widget; script async/deferred.

## Out of scope / gaps

Live order status via API; multi-channel (WhatsApp/Messenger ingestion — contacts design hints); widget theming beyond tokens; A/B testing.
