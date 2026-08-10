# 12 — Proactive Chat Campaigns

> Triggered widget messages that engage shoppers before they ask.
> Sources: design `proactive-chat.html` + NOTES.md (template catalog, gating); Campaign model from 01. **Known design gap: no campaign editor screen — this spec defines a minimal one.**

## Purpose

Admin page `/app/proactive-chat`: campaign dashboard + template picker; storefront runtime that shows proactive widget messages by trigger conditions, measured by views/CTR/ATC/revenue.

## UI (per design)

### Dashboard view
- Header copy + **Create proactive chat** → template picker.
- Overview card: range chip (Last 7 days), compare label, Updated + Reload; KPIs: **View** (▲%), **CTR** (2-decimal %, ▲pts), **Revenue** (shop currency, "— no orders yet" empty), **Order** count.
- Campaign table: sub-tabs All/Active/Inactive; search; columns **Priority (drag + number)** | Name | Type icon | View | CTR (value + inline bar) | ATCs | Revenue | Status dot | Updated at | kebab (edit/duplicate/delete). `–` for null metrics. Pagination.
- Priority = evaluation order when multiple campaigns match a page (lower number wins; one campaign shown per page view).

### Template picker (10 templates)
| Category | Template | Gating |
|---|---|---|
| Engage | Welcome visitors | free |
| Grow list | Subscribe newsletter | free |
| Upsell | Product recommendation | free |
| Convert | Cart booster | 👑 premium |
| Convert | View cart | 👑 premium |
| Recover | Abandoned cart reminder | 👑 premium |
| Upsell | Collection boost | 👑 premium |
| Reassure | Remove items from cart | free |
| Guide | Search page | free |
| Assist | Smart Product Page (variant picker + in-chat ATC) | ✦ NEW |

Premium cards: crown badge + disabled Create + upgrade link (tier per matrix 15 — premium templates Pro+).

### Campaign editor (design gap — minimal v1)
Create from template → editor: Name; **Trigger** (template-specific defaults): page match (home/product/collection/search/cart URL rules), delay seconds, exit-intent (abandoned-cart), cart state (items ≥ N / value ≥ X — cart templates), once-per-session frequency; **Message**: text (merge tags {{customer_name}}, {{cart_total}}), optional product/collection picker (reuse browse modals 08), CTA label + action (open chat / apply code / link); **Discount code** field (cart booster); Status. Save → dashboard.

## Storefront runtime (extends widget 05)

- Widget config includes active campaigns (priority-ordered, plan-gated server-side).
- Client evaluates triggers (page type via liquid template context, cart via `/cart.js`, delay/exit-intent) → renders proactive bubble/floater above launcher; dismiss = frequency-capped per session.
- Smart Product Page: floater on product pages with variant picker + in-chat add-to-cart.
- Events → analytics_event: campaign_view, campaign_click (CTR), campaign_atc, campaign_order (order attribution: cart token → order webhook later; v1 revenue = ATC-attributed checkout via cart attributes `chatconvert_campaign`).

## Business rules

- One campaign shown per page view (highest priority match); session frequency cap.
- Premium templates blocked server-side below tier (config API filters them).
- Metrics aggregated nightly + on-demand; ranges 7d/30d/12m.
- Onboarding step "Launch a proactive chat campaign" (13) completes on first active campaign.

## Acceptance criteria

1. Template picker matches catalog incl. gating (premium disabled below Pro, functional at Pro+).
2. Create→editor→save→dashboard row; priority drag reorders evaluation; status toggle works.
3. Storefront: welcome campaign shows on home after delay, once per session; cart-value trigger fires when threshold met; dismiss respected.
4. View/click/ATC events recorded; CTR math matches; revenue attributes via cart attribute.
5. Smart Product Page floater adds correct variant to cart.

## Out of scope / gaps

Full editor parity with mature apps (audiences, scheduling windows, A/B tests); order-webhook revenue attribution (needs orders scope — flagged PCD); email/off-site channels.
