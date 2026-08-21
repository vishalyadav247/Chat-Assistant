# 15 — Billing, Plans & Usage

> Shopify Billing API subscriptions, the plan matrix that gates every feature, and the conversation meter.
> Sources: design `plan-usage.html` + NOTES.md (tiers, FAQ = policy rules); design gating found across all pages; Shopify Billing API (managed via shopify-dev-mcp docs at build time).

## Plan matrix (single source of truth — `app/lib/billing/plans.server.ts`)

| | Free | Basic | Pro (Most popular) | Plus |
|---|---|---|---|---|
| Monthly | $0 | $19.99 | $49.99 | $99.99 |
| Yearly (per-mo, −18%) | $0 | $16.39 ($196.68/yr) | $40.99 ($491.88/yr) | $81.99 ($983.88/yr) |
| Trial | none | 7-day | 7-day | 7-day |
| AI conversations / mo | 75 | 200 | 500 | 1,000 |
| Overage | — (AI stops) | $0.4/conv | $0.4/conv | $0.4/conv |
| Products synced | 200 | 500 | 1,000 | 5,000 |
| Curated answers | 5 | 20 | 50 | 100 |
| Manual Q&As | 10 | 20 | 20 | 50 |
| Policy pages | 5 | 10 | 10 | 20 |
| Website crawl | 1 page | +linked (10) | +linked (10) | full site (20) |
| CSV import (50 rows) + file upload (5) | — | — | — | ✅ |
| Remove branding | — | ✅ | ✅ | ✅ |
| Unanswered-questions analytics | — | ✅ | ✅ | ✅ |
| Discount real-time sync | — | — | ✅ | ✅ |
| Premium proactive templates | — | — | ✅ | ✅ |
| Inbox cart view | — | — | ✅ | ✅ |
| Multi-language + auto-detect | ✅ | ✅ | ✅ | ✅ | (not gated — every plan)
| Analytics/conversation exports | — | — | — | ✅ |

(Design hard-codes Plus quotas in AI-agent meters and says "Downgrade to X" on every CTA — both are design bugs; UI must derive from this matrix and label Upgrade/Downgrade/Current correctly.)

**No literal plan numbers in UI copy (QA D10).** Everything above is a *default* the
operator can change from `/platform/plans`, so the UI must recompute, never quote:
- the yearly discount is `Math.round((1 - yearlyTotal / (priceMonthly × 12)) × 100)`
  (`yearlySavingsPercent` / `savingsBadgeLabel` in `app/components/PlanCards.tsx`) —
  the toggle badge and the yearly terms line both read it, so "18%" is derived, not typed;
- the overage rate in the FAQ comes from `overageRate(plan)` via the loader
  (`PlanFaq` prop `overagePerConversation`; `null` ⇒ "AI pauses at the cap" copy);
- the "(50 rows)" CSV figure is **not** modelled as a quota dimension
  (`QUOTA_DIMENSIONS` has no csv-rows key), so the Plus bullet says
  "CSV import + PDF upload (N files)" using `quotas.file_uploads` rather than
  stating a row limit the code does not enforce.

## Billing integration (Shopify Billing API)

- `appSubscriptionCreate` (GraphQL) with RecurringPricing (30-day interval; yearly = ANNUAL interval) + **UsagePricing** line (capped amount for overage, terms "$0.4 per extra AI conversation") for Basic+.
- Trial 7 days via trialDays; Free = no subscription object ("Free forever").
- Confirmation URL redirect flow from embedded app (top-level redirect via App Bridge); return URL → verify active → store plan + planStatus on Shop.
- Plan change: create new subscription (Shopify auto-cancels/prorates — FAQ #6: immediate, prorated by Shopify).
- Cancel/uninstall: `app_subscriptions/update` webhook + uninstall → planStatus updated; FAQ #5: data retained, premium features pause.
- Discount codes (built 2026-08-21): operator-managed **promo codes** at `/platform/promo-codes` (`PromoCode` table — percent or fixed USD, optional duration in billing cycles, plan/interval restriction, max redemptions, expiry, active flag; codes handed to merchants out of band by mail/chat). Merchant applies a code on Plan & Usage → `validate_code` action (server-side, shop-scoped; one redemption per shop per code) → cards preview the discounted price → `subscribe` re-validates against the chosen plan+interval and passes `discount: { value: { percentage: 0–1 | amount }, durationLimitInIntervals }` on the recurring line of `appSubscriptionCreate`, so **Shopify applies it** (approval page, invoices, proration). `PromoRedemption` row is `pending` at create and flipped to `redeemed` by `completeBillingReturn` once the subscription is ACTIVE. A fixed discount ≥ the interval price is refused (no $0 subscriptions). Codes with redemptions can be deactivated, not deleted. Lib: `app/lib/billing/promo-codes.server.ts`.
- Dev stores: test charges (`test: true` in dev).

## Usage metering (FAQ rules are the contract)

- **1 AI conversation = one shopper session regardless of message count; new session after 30 min inactivity.** Meter ticks on first AI-handled message of a session (curated/blocked count too — AI handled; human-only convos don't tick).
- `PlanUsage` row per shop per period (resets on the 1st — FAQ #3, no rollover).
- Over cap: Basic+ → keep replying, record overage, report via `appUsageRecordCreate` ($0.4 each, respecting capped amount; near-cap → notify merchant). Free → AI stops: widget falls back to contact/leave-message mode (05), admin banner + upgrade prompt.
- Meter + "You're at N% of the {plan} allowance" surfaced on Plan & Usage page and dashboard.

## Gate enforcement

`requirePlan(shopId, feature)` helper — server-side check on every gated mutation/config read; UI reads the same matrix for locks/meters. Gates listed above; quota creates (curated, sources, products cap) enforced at write time.

## Plan & Usage page (`/app/plan-usage`, per design)

Usage card (meter, resets-on-1st copy); Your-plan card (name + status badge incl. "No active subscription"); Monthly|Yearly toggle (Save 18%) rewriting prices/terms; 4 plan cards (feature bullets from matrix, trial copy, overage note, CTA Current/Upgrade/Downgrade); discount code card; **Done-for-you card** ("Progryss builds your curated-answer library…" → contact link); FAQ accordion (6 items, verbatim policy copy from design).

## Business rules

- Never trust client for plan; Shop.plan refreshed from subscription webhook + on billing return.
- Downgrade with over-quota data: keep data, block new creates, banner explains (consistent with FAQ #5 "features pause").
- All charges through Shopify Billing (App Store requirement — no external payment).

## Acceptance criteria

1. Each tier subscribe flow completes on dev store (test charges), incl. yearly + trial; plan lands on Shop; UI badges correct (Current/Upgrade/Downgrade).
2. Meter: scripted sessions tick correctly (30-min boundary tested); reset job on the 1st; no rollover.
3. Free at cap → AI stops, widget fallback, banner; Basic at cap → usage records created at $0.4.
4. Every gate in the matrix enforced server-side (test per feature: branding, exports, templates, auto-detect, quotas, discounts sync, cart view).
5. Plan change prorates via Shopify (observed in test); cancel pauses premium features but keeps data.
6. Downgrade with 30 curated answers on Basic (cap 20): existing kept, creates blocked.

## Out of scope

Regional pricing, per-seat pricing, custom enterprise plans, coupon management UI beyond a code field.
