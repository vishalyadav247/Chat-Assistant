# 13 — Dashboard & Onboarding

> The app home: greeting, KPIs, "Get your AI ready" setup steps, live conversation feed.
> Revised 2026-09-14 from the owner's mockup `chatconvert-dashboard.html` (setup made easier for a
> new merchant + single-column layout). The running page is the reference after this revision.

## Purpose

`/app` (index route): the first screen after install — time-of-day greeting, headline KPIs, an
8-step setup list with real completion detection, live conversations feed.

## Layout (revised 2026-09-14)

ONE column, top to bottom — the two-column checklist | feed grid is gone:

1. Hero
2. Status banner (at most one)
3. Overview card
4. **Get your AI ready** (setup steps)
5. Live conversations

## UI

### Hero
"Good {morning/afternoon/evening}, {shop name} 👋"; dynamic subline (waiting-question count + chat
add-to-carts in the last 30 days). Status pill top-right: **"Assistant on"** (pulsing dot) /
**"Assistant off"** — a status display, not a toggle (one mis-click on a pill must not switch the
AI off for every shopper). Actions: **Answer N questions** (→ unresolved queue) and **Preview widget**
(→ storefront). The hero's "Sync catalog" button was removed 2026-09-15 (owner): it ran the same
sync-all as step 1's Sync now / Re-sync now in the setup card directly below.

### Status banner (max one, by priority)
1. **AI off** — title "Your AI assistant is turned off"; body keeps the human-mode wording (the
   mockup's "Shoppers can still leave messages" copy was retired 2026-09-11 — shoppers get the
   waiting message and chats go to the Inbox). Button **"Turn it on"** switches the AI on in place
   (needs the `ai_agent` permission), toast, banner disappears — no trip to the AI Agent page.
2. **Near conversation quota** (≥80%) — unchanged.

The old "N setup steps left" banner is removed: the setup card directly below states the same
progress with a percentage.

### Overview card
Row 1: range dropdown (the analytics range vocabulary; plan-locked ranges disabled with the tier)
left, **Reload** right. Row 2: "Compare to: {previous equal period}". Plan banner when ranges are
locked. Four KPI tiles: Total conversations (▲% + sparkline), Live conversations (activity <5 min),
Chat add-to-carts (▲% + sparkline — assisted-revenue proxy), Resolution rate ("Resolved: X · Total: Y").

### Get your AI ready (setup steps)
Header: "Get your AI ready" + "Finish these steps to unlock the best results." left; big **N%** +
"X of Y steps done" right; horizontal gradient progress bar under it.

Steps render as a **timeline** (2026-09-14): the circles sit on a vertical rail joined by dashed
segments (green where the steps on both sides are done, grey otherwise); the rail runs through the
step 1 detail panel. Row separators start after the rail so they never cross it.

Each step row: numbered circle (green check when done) · title + one-line description · action on
the right — a primary button while to-do, "Completed" when done. The storefront step's live status
badge (On / Off / Draft theme only / Unknown) sits right after its title, not on the right.

| # | Title | Description | Action (to-do) | Done when |
|---|---|---|---|---|
| 1 | Train AI data — catalog & store | done: "Products, Collections, Pages, Blogs and Discounts — N items learned." · to-do: "Sync your products, collections, pages, blogs and discounts so your AI can learn them." | **Sync now** (runs all five syncs, opens the detail) | a product sync has completed (`SyncState.productSyncAt`) **and** ≥1 item is learned (QA-U2) |
| 2 | Train AI data — FAQs | Add the questions shoppers ask most, with your answers. | **Add FAQs** → Training › FAQs | ≥1 published FAQ |
| 3 | Train AI data — custom knowledge | PDFs, files, policies, or any specific website URL. | **Add sources** → Training › Custom knowledge | ≥1 **active** custom source (types other than the faq / store_pages / blog_articles bridges) |
| 4 | Add your store info | Tell your AI about your store — what you sell, where you're based and how shoppers can reach you. | **Add store info** → Instructions › General › Store info (`#store-info`) | Store info text saved (`ShopSettings.storeInfo.about` non-empty). Done shows "Completed" **and keeps a Review button**. (Replaced the short-lived "first Review click" rule the same day — the aim is store info, spec 08.) |
| 5 | Chatbox settings & appearance | Colours, position and greeting for your storefront widget. | **Customize** → Chatbox | widget settings saved |
| 6 | Proactive chat | Trigger messages that reach shoppers before they ask. | **Create campaign** → Proactive chat | ≥1 active campaign |
| 7 | Curated answers | Hand-write replies for your highest-intent questions. | **Start** → Curated answers | ≥1 published curated answer (was ≥5 — "easier to set up") |
| 8 | Enable AI agent on storefront | Turn on the app embed so the chat goes live for shoppers. | **Turn on** → theme editor (activateAppId deep link) | app embed ON in the published theme |

Step 8 keeps the embed states of Settings → General: **On** badge (done), **Draft theme only**
(warning badge + note naming the theme, counts as to-do), **Off** (to-do), **Unknown** (no
read_themes — informational, excluded from the total, "Check in Theme editor" link).

**Step 1 detail** (open by default; the chevron collapses it; a sync re-opens it): "Last synced …" +
**Re-sync now** button (while syncing the line reads "Syncing — N of M sources done"; no inner progress bar — removed 2026-09-15, the card header already has one); one row per source — Products,
Collections, Pages, Blogs, Discounts — with "N of M learned" and a status: **Syncing…** (spinner),
**Sync failed**, master Learn switch off → **no status badge, only an "Enable learning" link** to
that Training tab (the row reads "M synced · not learned yet"), **Nothing learned** (0 rows switched on, or nothing synced) or **Learned** (tick).
Step 1 is Completed once a product sync has run **and** at least one item is learned (QA-U2,
2026-09-14, owner-accepted — it used to complete on the sync alone, so a store with every Learn
switch off showed a finished step). Synced but nothing learned reads "Synced — but nothing is
switched on for your AI yet…" and stays to-do. "Learned" = rows with the per-row AI learn switch
on, counted only while that type's master Learn switch is on (the same rule the AI reads); for
**products** it is the `SHOWABLE_PRODUCT` rule the pipeline cards with (`lib/search/showable.ts`:
learn on + status active + published to the Online Store), so draft / unpublished products are
never counted. Manual syncs are throttled per store + type for 60 s (`enqueueSync`, QA-U1): a
repeat click queues nothing and shows "A sync is already running".
Syncing state: after a Re-sync the row shows Syncing… until that source's own sync timestamp is
newer than the click (products also while `SyncState.status = running`); the dashboard's 5s poll
advances it; after 10 minutes without a new timestamp the row reverts to its last state rather than
spinning forever. Products show **Sync failed** when `SyncState.status = error`.

The step list is **shown by default, including at 100%** (header "You're all set"); a
"Hide steps" toggle appears once everything is done.

**Percentage** = round(completed ÷ total × 100). total = the 8 steps minus the storefront step
when its embed status is "unknown" (can't be verified without read_themes); a "Draft theme only"
embed counts as to-do.

### Live conversations feed
Full width. Latest 4 open conversations: avatar initials, last shopper message, Live / Waiting for
agent / Open tag, relative time; click → inbox thread. Polls with the live KPI.

## Business rules

- All metrics shop-scoped; `isTest` conversations excluded; compare = previous equal period.
- Polling stays cheap: counts / groupBy only, no N+1 (step 1 adds one groupBy per content table).
- Buttons stay Polaris-native (`s-button`); the gradient is used only on the hero and progress bar.
  In the setup card every step button and Re-sync now are **primary (black)** (user, 2026-09-14,
  revised from white); "Enable learning" is blue and underlined in every state (a plain button styled as a link —
  `s-link` only underlines on hover and can't be restyled).
- Greeting uses the shop timezone.

## Implementation plan (2026-09-14)

1. **Server — `app/lib/dashboard/dashboard.server.ts`**
   - `ChecklistStep` gains `description`, `action` (`navigate` href | `external` url | `sync`),
     `actionLabel`; drop `linkLabel`/`href`-only rendering.
   - `setupChecklist` reads, in one `Promise.all`: embed detail, widget row, sync state, persona,
     published FAQ count, active custom source count, published curated count, active campaigns,
     shop settings (master Learn switches), and a learnEnabled `groupBy` for products, collections,
     store pages, blog articles, discounts.
   - Returns the 8 steps in the table order + `training: { sources[], learnedTotal, lastSyncedAt,
     productStatus }`.
2. **Route — `app/routes/app._index.tsx`**
   - Action `sync-all`: enqueue catalogSync, collectionSync, discountSync, pageSync, articleSync
     (hero Sync catalog + step 1 both use it). Action `enable-ai`: re-checks `ai_agent` permission,
     sets `aiEnabled`, invalidates shop config.
   - Single-column layout; banner changes above; setup-left banner removed.
3. **UI**
   - `DashboardChecklist.tsx` rewritten as "Get your AI ready" (header %, ProgressTrack, step rows,
     step 1 detail with client-side re-sync tracking).
   - `DashboardOverview.tsx`: compare label on its own row under the range/Reload row.
   - `DashboardHero.tsx`: pill copy "Assistant on / off".
4. **Tests** — `ui-web` dashboard heading expectation; features/install-lifecycle keep calling
   `setupChecklist`; add a features case for the new completion rules (FAQ, custom source, curated ≥1,
   learned counts respect the master switch).
5. **Verify** — typecheck, lint, build, features, ui-web; the owner checks visuals.

## Acceptance criteria

1. Steps flip to Completed from real state changes (each rule in the table); % and "X of Y" match;
   the unknown embed state is excluded from Y.
2. Step actions land on the right tab; step 8 opens the theme editor; Sync now / Re-sync enqueue all
   five syncs with a toast.
3. Step 1 counts equal the Training tabs' learning-on counts and drop to 0 for a type whose master
   switch is off; rows show Syncing… after a re-sync and Learned once each sync finishes.
4. "Turn it on" enables the AI from the dashboard (banner gone, pill "Assistant on").
5. KPIs match known data across ranges; deltas correct; live count + feed update within the poll.
6. Single-column layout at desktop and phone widths.

## Out of scope / gaps

Assisted revenue / sales share (order attribution — PCD submitted 2026-09-11, not yet built);
custom compare ranges; feed websockets.
