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

### Campaign editor (design: `.claude/resources/proactive_chat/*.png`)

Six of the ten templates have a reference screenshot; the other four
(Cart booster, View cart, Abandoned cart reminder, Collection boost) were
designed to the same pattern. **One screen serves all ten** — what it renders is
declared per template in `lib/campaigns/templates.ts`, not branched in the view.

Layout: back chevron + "New proactive chat" → **Activate proactive chat** card
(icon + switch) → two columns. Left: General, Trigger, Conditions (collapsible),
then Message and Appearance. Right (sticky): **Message Preview** + a read-only
summary card (name + status badge, Type / Trigger / Conditions / Message).

| Card | Contents |
|---|---|
| General | Name ("visible only to you") |
| Trigger | Template's one-line summary; **Page to show** when the template offers a choice (`scopeMode`: all/specific pages · all/specific product pages · all/specific collection pages — "specific" reveals a URL fragment field or a browse-picker); cart **min/max value** on cart templates; **Send message after** (`timingMode`: dwell-seconds ¦ scroll-% radios, dwell only, or exit intent) |
| Conditions | Audience (all/visitors/customers) · Display time (all/business hours) · Device (all/desktop/mobile) · Display duration (always/custom date window) · Countries (all/selected) — identical on every template |
| Message | Tab strip per `messageKinds`. **Text** (Quick question → starter chips ¦ Custom message → rich text), **Product Recommendation** (rich text + best sellers/new arrivals/similar(Pro+)/complementary/custom + button labels), **Discount** (rich text, trigger button text, discount-code picker, usage instruction, optional **Collect lead**: introduction, Email(fixed)/Name/Phone, marketing double opt-in, success message), **Smart Product Page** floater (floater message with `{{ option }}`, subtitle, CTA text — all with counters). **Product Quiz renders as a DISABLED `Pro +` tab** exactly as in the reference; there is no quiz runtime and the save path refuses the kind. |
| Appearance | Background color (10 presets + custom), text color, and — for templates with buttons — button background and label color. **Per campaign**, not inherited from the chatbox theme. |

Settings shape: `{ trigger, conditions, message, appearance }`
(`campaignSettingsSchema`). Blobs written before the rebuild are lifted by
`migrateCampaignSettings()` on read — idempotent, keeps the merchant's copy.

**Message Preview parity is by construction**: the admin injects the real
`widget-renderer.js` + `chat-widget.css` and renders through
`campaignBubble` — the same builder the storefront calls. Same JSON in, same
DOM out.

## Storefront runtime (extends widget 05)

- Widget config includes active campaigns (priority-ordered, plan-gated server-side).
- `ccEvalCampaign` (pure, unit-tested in a node vm) answers page scope + every
  Condition + the cart window. Timing is armed separately: dwell timer, scroll
  listener, or exit intent. One campaign per page view; dismiss/show is
  frequency-capped per session.
- Page context reaches the shell from liquid: `data-product-id`,
  `data-collection-id`, `data-country`, `data-logged-in`.
- `remove_items` fires on an actual removal — the cart line count is compared
  against the previous page view (per tab), so no theme hooks are needed.
- **Recommendation resolution is split.** Page-independent sources (best
  sellers, new arrivals, custom) are resolved into the 5-minute cached widget
  config server-side. Contextual sources (similar, complementary) and the Smart
  Product Page's variant chips resolve per page view through
  `proxy.campaign-products` — a shared cache cannot carry per-product data.
  Below Pro, `similar` degrades to best sellers rather than rendering empty.
- Newsletter leads post to `proxy.campaign-lead`: same contact-merge rules as
  pre-chat (never downgrades a customer), double opt-in withholds
  `marketingOptIn` until confirmed, and the submission counts as the click.
- Events → analytics_event: campaign_view, campaign_click (CTR), campaign_lead,
  campaign_atc, campaign_order. The reference bubbles hand off to chat rather
  than adding to cart inline, so hand-off stamps the cart attribute
  `chatconvert_campaign` and the in-chat add emits `campaign_atc` — revenue
  attribution survives the design change.

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
5. Smart Product Page floater shows the anchor product's variant chips and
   opens the chat seeded with the selected one (in-chat add-to-cart from there).

## Out of scope / gaps

Full editor parity with mature apps (audiences, scheduling windows, A/B tests); order-webhook revenue attribution (needs orders scope — flagged PCD); email/off-site channels.
