# 15 — Billing, Plans & Usage

> Shopify Billing API subscriptions, the plan matrix that gates every feature, and the conversation meter.
> Sources: design `plan-usage.html` + NOTES.md (tiers, FAQ = policy rules); design gating found across all pages; Shopify Billing API (managed via shopify-dev-mcp docs at build time).

## Plan matrix (single source of truth — `app/lib/billing/plans.server.ts`)

| | Free | Basic | Pro (Most popular) | Plus |
|---|---|---|---|---|
| Monthly | $0 | $19.99 | $49.99 | $99.99 |
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
operator can change from `/admin/plans`, so the UI must recompute, never quote:
- the overage rate in the FAQ comes from `overageRate(plan)` via the loader
  (`PlanFaq` prop `overagePerConversation`; `null` ⇒ "AI pauses at the cap" copy);
- the "(50 rows)" CSV figure is **not** modelled as a quota dimension
  (`QUOTA_DIMENSIONS` has no csv-rows key), so the Plus bullet says
  "CSV import + PDF upload (N files)" using `quotas.file_uploads` rather than
  stating a row limit the code does not enforce.

## Billing integration (Shopify Billing API)

- `appSubscriptionCreate` (GraphQL) with RecurringPricing (30-day interval — the only interval) + **UsagePricing** line (capped amount for overage, terms "$0.4 per extra AI conversation") for Basic+.
- Trial 7 days via trialDays; Free = no subscription object ("Free forever").
- Confirmation URL redirect flow from embedded app (top-level redirect via App Bridge); return URL → verify active → store plan + planStatus on Shop.
- Plan change: create new subscription (Shopify auto-cancels/prorates — FAQ #6: immediate, prorated by Shopify).
- Cancel/uninstall: `app_subscriptions/update` webhook + uninstall → planStatus updated; FAQ #5: data retained, premium features pause.
- Discount codes (built 2026-08-21): operator-managed **promo codes** at `/admin/promo-codes` (`PromoCode` table — percent or fixed USD, optional duration in billing cycles, plan/interval restriction, max redemptions, expiry, active flag; codes handed to merchants out of band by mail/chat). Merchant applies a code on Plan & Usage → `validate_code` action (server-side, shop-scoped; one redemption per shop per code) → cards preview the discounted price → `subscribe` re-validates against the chosen plan+interval and passes `discount: { value: { percentage: 0–1 | amount }, durationLimitInIntervals }` on the recurring line of `appSubscriptionCreate`, so **Shopify applies it** (approval page, invoices, proration). `PromoRedemption` row is `pending` at create and flipped to `redeemed` by `completeBillingReturn` once the subscription is ACTIVE. A fixed discount ≥ the interval price is refused (no $0 subscriptions). Codes with redemptions can be deactivated, not deleted. Lib: `app/lib/billing/promo-codes.server.ts`.
- Dev stores: test charges (`test: true` in dev).

## Usage metering (FAQ rules are the contract)

- **1 AI conversation = one shopper session regardless of message count; new session after 30 min inactivity.** Meter ticks on first AI-handled message of a session (curated/blocked count too — AI handled; human-only convos don't tick).
- `PlanUsage` row per shop per period (resets on the 1st — FAQ #3, no rollover).
- Over cap: Basic+ → keep replying, record overage, report via `appUsageRecordCreate` ($0.4 each, respecting capped amount). Free → AI stops: widget falls back to contact/leave-message mode (05), admin banner + upgrade prompt.
- Meter + "You're at N% of the {plan} allowance" surfaced on Plan & Usage page and dashboard.

### Where the rate lives, and who is told (2026-09-03)

The rate is editable at `/admin/plans` for the PAID tiers only. Free has no
field, and `applyConfig()` ignores a stored rate for `free` even if one is
hand-crafted into the row — the single enforcement point, since every reader
goes through the live matrix. Reason: a $0.50 rate was once set on FREE, a plan
that can never be billed because charging needs a Shopify usage line and a Free
shop has no subscription, and the plan card then advertised a charge the app
would never make. The card prints the overage line ONLY on a plan that has a rate — the same
predicate as `overageBillable()`. Overage is disclosed only where it is true: the Shopify approval page
(`usageTermsFor`, part of the usage line the merchant approves) and the Plan &
Usage FAQ, which asks `overageBillable()` first.

### Getting paid — the 2026-09-03 hardening

The happy path above was correct but leaked money at both ends. Four rules now
close it (`scripts/qa/overage.test.ts`, 47 checks):

1. **Two counters, never one.** `PlanUsage.overageCount` is what was served past
   the allowance; `overageReported` is what Shopify has accepted a charge for.
   The difference is work done and not yet paid for, and it is the only thing
   the billing code cares about. Before this a failed `appUsageRecordCreate` was
   logged and forgotten — the conversation had been served and could never be
   billed again.
2. **Tick time submits, the hourly job retries.** `submitOverageRecords()` bills
   exactly what is owed and increments `overageReported` by what Shopify
   accepted; the `overage-reconcile` job (`27 * * * *`) runs the same call for
   every shop still owing. Re-running bills nothing, so it is safe to retry
   forever. Neither path can throw into the chat request.
3. **The approved ceiling stops free work.** `cappedAmount` is the merchant's own
   limit for a 30-day Shopify billing cycle, and past it the mutation simply
   fails ("Failed to create usage charge"). `usage-cap.server.ts` reads
   `balanceUsed`/`cappedAmount` from the subscription (cached 60s) and
   `aiAllowed()` refuses a billable conversation with no headroom — the AI stops
   exactly where the money stops. It FAILS SAFE: if Shopify is unreachable the
   answer is "there is headroom", and the reconcile job bills what was served.
   Note the two clocks — our quota resets on the 1st, the ceiling resets on the
   subscription's own cycle. `balanceUsed` is read from Shopify precisely so the
   app never has to guess which is which.
4. **Raising the ceiling needs the merchant.** `appSubscriptionLineItemUpdate`
   returns a confirmation URL they must approve (steps $100 → $250 → $500 →
   $1000). Plan & Usage offers it in the "AI replies are paused" banner, with a
   top-level redirect out of the iframe, exactly like subscribing.

Merchant-facing states on Plan & Usage, in the order they can happen: **≥80% of
the allowance** (warning, says what happens next), **past the allowance**
(warning with the count, the rate and the spend so far), **ceiling reached**
(critical + "Raise limit to $X"). `overageCount` used to be written and never
read anywhere — a merchant could be billed with nothing on screen to explain it.

**Enforcement switch: REMOVED (2026-09-08).** Plan gates and quotas are ALWAYS
live. The open/enforced operator switch existed only while the tiers were being
decided; it was global, so leaving it open served every merchant the top tier
for free, silently. To give ONE store more, grant it bonus quota (below) — same
goal, targeted, and visible on that store.

**Bonus quota (per store, 2026-09-07/08).** A `QuotaGrant` LEDGER
(rows, not a counter on Shop: auditable, expirable in batches, additive) topping
up ANY quota dimension for ONE shop, from Admin -> Usage -> that store.

ONE RULE: a live grant RAISES that shop.s cap. Effective limit = plan allowance
+ live grants; nothing is consumed one at a time. (A consumable model was built
first and replaced the same day: the displayed limit shrank as it was spent, and
it needed a hand-maintained "spend the credit before recording overage" rule
that a refactor could silently reverse into billing a merchant for the very
conversations the grant covered. A cap raise has no ordering to get wrong.)
Withdrawing or expiring a grant drops the cap back; nothing already created
under the higher cap is deleted, only new work stops.

GRANTABLE_DIMENSIONS is `conversations` + `products_synced` — and only those,
because a grant does something only where the check site adds `bonusQuota()`.
Offering the rest would let an operator grant 500 curated answers, see it saved,
and have nothing change. `grantQuota()` REFUSES an unwired dimension rather than
storing a no-op. Adding one is two lines: read the bonus at that quota.s check
site, then list it. FEATURES are never grantable — a grant tops up a number, it
does not unlock a capability; upgrading is the only way to those. Spent AFTER
the plan allowance and BEFORE overage — the ordering is the whole feature, since
spending them later would bill the merchant for exactly what the grant was meant
to cover. `aiAllowed()` checks the balance before any billing path, so a granted
Free shop keeps answering past its cap (the only mechanism that can do this:
Free has no usage line, so it can never be billed overage instead). Soonest-
expiring grant is spent first; an expired or withdrawn grant stays on the ledger
with `remaining = 0` for audit. Shown to the merchant on Plan & Usage — a silent
balance would make their own numbers look wrong. Suite: `quota-grants.test.ts` (42 checks,
TEST-CASES area Z).

**Never billable, by design:** Free (no subscription, no usage line) and any
shop whose `usageLineItemId` is missing — including a legacy row still marked
`billingInterval: "yearly"`, since Shopify rejects usage lines on ANNUAL
subscriptions (QA D1). All of them hard-cap instead,
and the FAQ copy derives from the same predicate so it cannot promise overage
that cannot be charged (QA D-15).

**The rate is not operator-editable** (see the section above). **Still pending
manual:** `appUsageRecordCreate` has never run against real Shopify billing — every automated pass is mock mode. Subscribe a dev store with
test charges and push it past quota before trusting the first real invoice.

## Gate enforcement

`requirePlan(shopId, feature)` helper — server-side check on every gated mutation/config read; UI reads the same matrix for locks/meters. Gates listed above; quota creates (curated, sources, products cap) enforced at write time.

**Annual billing: REMOVED (2026-09-07).** There is no yearly interval, no Monthly/Yearly toggle, no yearly price in the matrix, and no operator switch — the app offers monthly subscriptions only. Why: Shopify allows usage charges on monthly cycles only, so a yearly subscriber could never be billed for extra conversations. They hard-capped at their quota, and on the top tier there was not even an upgrade left to sell — the merchant paying the most, up front, got the worst outcome. Monthly-only makes the overage path work for every paid tier. `Shop.billingInterval` survives as a column and `overageBillable()` still refuses `"yearly"`, purely as a safety net for rows written before the removal.

**Enforcement switch** (`/admin/plans`, stored with the matrix). `enforced` = every gate and quota applies. `open` = every store is served the TOP TIER's entitlements — `OPEN_MODE_PLAN`, currently Plus — **not unlimited** (changed 2026-09-03: `getQuota` used to return `MAX_SAFE_INTEGER`, which meant no ceiling at all and meters reading "0 of 9,007,199,254,740,991"). Open mode is `max(top tier, the shop's own plan)` per dimension and the union of both feature lists, so it can only ever be an upgrade even if the matrix is mis-edited. Consequence worth knowing: a monthly paid shop that passes the TOP tier's conversation cap in open mode is billed overage at its own rate — open mode is generous, not free-for-all.

## Plan & Usage page (`/app/plan-usage`, per design)

Usage card (meter, resets-on-1st copy); Your-plan card (name + status badge incl. "No active subscription"); 4 plan cards (feature bullets from matrix, trial copy, overage note, CTA Current/Upgrade/Downgrade); discount code card; **Done-for-you card** ("Progryss builds your curated-answer library…" → contact link); FAQ accordion (6 items, verbatim policy copy from design).

## Business rules

- Never trust client for plan; Shop.plan refreshed from subscription webhook + on billing return.
- Downgrade with over-quota data: keep data, block new creates, banner explains (consistent with FAQ #5 "features pause").
- All charges through Shopify Billing (App Store requirement — no external payment).

## Acceptance criteria

1. Each tier subscribe flow completes on dev store (test charges), incl. trial; plan lands on Shop; UI badges correct (Current/Upgrade/Downgrade).
2. Meter: scripted sessions tick correctly (30-min boundary tested); reset job on the 1st; no rollover.
3. Free at cap → AI stops, widget fallback, banner; Basic at cap → usage records created at $0.4.
4. Every gate in the matrix enforced server-side (test per feature: branding, exports, templates, auto-detect, quotas, discounts sync, cart view).
5. Plan change prorates via Shopify (observed in test); cancel pauses premium features but keeps data.
6. Downgrade with 30 curated answers on Basic (cap 20): existing kept, creates blocked.

## Out of scope

Regional pricing, per-seat pricing, custom enterprise plans, coupon management UI beyond a code field.
