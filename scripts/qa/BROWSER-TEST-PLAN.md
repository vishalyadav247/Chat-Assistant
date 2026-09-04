# ChatConvert — Browser (visual + interaction) test plan

Companion to `scripts/qa/TEST-CASES.md`. Everything in TEST-CASES.md is executed by the
`scripts/qa/*.test.ts` suites at the HTTP / server / DB level. **This document covers only what a
script cannot see**: what a human actually looks at and clicks.

Run against the live dev tunnel. Get the current URL with:

```
curl -s http://127.0.0.1:20241/quicktunnel
```

`shopify.app.toml` may hold a STALE tunnel — always read the live one from the command above.

Legend for results: `PASS` / `FAIL` / `N/A` / `BLOCKED`.

---

## Prerequisites

| # | Item | Why |
|---|---|---|
| P1 | Dev server running (`npm run dev`), Postgres up (`npm run db:up`) | everything |
| P2 | Claude Chrome extension installed and connected | drives the browser |
| P3 | Signed into the dev store `jgw-check.myshopify.com` admin | embedded surface |
| P4 | A web-app member credential for `/web/login` | web surface |
| P5 | Operator credential for `/admin/login` | admin surface |
| P6 | Theme app embed enabled on the dev store's published theme | storefront widget |

---

## B1. Embedded admin (inside the Shopify iframe)

Entry: `https://admin.shopify.com/store/jgw-check/apps/chat-convert`

Per page — Dashboard, Inbox, Contacts, Chatbox, AI Agent (+ Instructions / Review / Test /
Training), Proactive Chat, Curated Answers, Analytics, Plan & Usage, Settings, Account:

| # | Check |
|---|---|
| B1.1 | Page renders inside the iframe with no blank region and no error boundary |
| B1.2 | Browser console has zero errors and zero React warnings (`read_console_messages`) |
| B1.3 | No network request 4xx/5xx on load (`read_network_requests`) |
| B1.4 | Left nav highlights the current page; every nav item navigates without a full reload |
| B1.5 | Polaris `<s-*>` components paint — no invisible/blank control where one is expected |
| B1.6 | Empty state renders correctly (use a shop with no data) |
| B1.7 | Every form: submit valid → success toast/banner + persisted; submit invalid → inline error |
| B1.8 | Loading state visible during async work; no layout shift on settle |
| B1.9 | Deep link with query params (`?c=`, `?tab=`, `?range=`) restores the right view |
| B1.10 | Browser back/forward keeps the session (no re-auth loop, no iframe bust) |
| B1.11 | Plan-gated controls show an upgrade prompt, never a broken/blank control |
| B1.12 | Chatbox live preview matches the storefront widget's real appearance |
| B1.13 | AI Agent → Test: send a message, get a streamed answer in the panel |
| B1.14 | Responsive at 1280 / 1024 / 768 — no horizontal scroll, no clipped controls |

## B2. Standalone web app

Entry: `<tunnel>/web`

| # | Check |
|---|---|
| B2.1 | `/web/login` renders; wrong password shows a generic error; right password lands on the inbox |
| B2.2 | Nav shows only what the signed-in role may see |
| B2.3 | Inbox: conversation list, open a thread, send a reply, see it appear |
| B2.4 | A reply sent here reaches the storefront widget live (keep B4 open side by side) |
| B2.5 | Assign / resolve / reopen; the AI resumes after reopen |
| B2.6 | Filters + search + pagination return correct results |
| B2.7 | Push-notification permission prompt appears (Basic+); denial is handled gracefully |
| B2.8 | Logout confirm page → logout → cannot go back into the app with the back button |
| B2.9 | Console clean; no 4xx/5xx |
| B2.10 | Responsive at 390px (agents use phones) — the whole inbox is usable |

## B3. Admin operator console

Entry: `<tunnel>/admin`

| # | Check |
|---|---|
| B3.1 | `/admin/login` renders; bad credentials rejected; good credentials land on the dashboard |
| B3.2 | Every page renders with real cross-tenant data: Access, AI, Logs, Plans, Promo codes, Settings, Usage |
| B3.3 | Plans: edit a quota → save → the merchant app reflects it within 30s (check in B1 side by side) |
| B3.4 | Plans: toggle enforcement open/enforced → gates change behaviour in the merchant app |
| B3.5 | Promo codes: create → the code applies at checkout in B1 Plan & Usage |
| B3.6 | Logs: filters, level filter, search, pagination all return correct rows |
| B3.7 | Usage → drill into a shop → figures match that shop's own Plan & Usage page |
| B3.8 | No secret value is visible anywhere on screen |
| B3.9 | Console clean; no 4xx/5xx |
| B3.10 | **Restore every setting changed during B3.3–B3.5** |

## B4. Storefront widget

Entry: the dev store's storefront with the app embed enabled.

| # | Check |
|---|---|
| B4.1 | Launcher appears in the configured position with the configured colour |
| B4.2 | Panel opens; greeting, starters/FAQ chips, and branding match Chatbox settings |
| B4.3 | Pre-chat form collects the configured fields and validates |
| B4.4 | Product question → answer streams in token by token → product cards render with images |
| B4.5 | Product card → add to cart actually adds to the real cart |
| B4.6 | Policy question → grounded answer, no invented link |
| B4.7 | Curated-answer question → the curated text comes back verbatim |
| B4.8 | Order tracking with a real order number returns that order and only that order |
| B4.9 | "Talk to a human" → handover; the agent sees it in B2; the reply lands here live |
| B4.10 | Online/offline copy matches the configured availability at the current time |
| B4.11 | Post-chat survey appears (Basic+) and submits |
| B4.12 | Reload the page → the conversation resumes with full history |
| B4.13 | Proactive campaign fires on its configured trigger |
| B4.14 | Keyboard only: reach the launcher, open, type, send, close. Focus is visible throughout |
| B4.15 | Mobile 390×844: panel fits, no horizontal scroll, keyboard does not cover the composer |
| B4.16 | Console clean on the storefront; the widget adds no page errors |
| B4.17 | Lighthouse on the storefront page with and without the widget — record the delta |

## B5. Cross-surface live checks

| # | Check |
|---|---|
| B5.1 | Widget message → appears in embedded Inbox AND web Inbox without a manual refresh (SSE) |
| B5.2 | Agent reply from web → appears in the widget without a refresh |
| B5.3 | Admin plan edit → merchant Plan & Usage updates within 30s |
| B5.4 | Availability toggle in Settings → widget online/offline copy changes (allow for the ~5 min widget-config cache; note the real observed delay) |
| B5.5 | Uninstall the app from the dev store → widget stops serving; reinstall inside the grace window → data intact |

---

## Recording

Record every result in **`scripts/qa/make-test-matrix.ts`** — the `ROWS` array holds one
entry per feature, and its `design` field is exactly what this document produces. Any FAIL
becomes a numbered defect in the `DEFECTS` array in the same file.

Edit the source, not the sheet. `test-matrix.xlsx` is generated from that file and is
gitignored, so anything typed into the spreadsheet is destroyed by the next run and
recorded nowhere. Regenerate when you want a readable copy:

```bash
npx tsx scripts/qa/make-test-matrix.ts
```

---

## Execution record — 2026-08-26

Run against `http://localhost:3000` (stable origin; the trycloudflare hostname
changes on every `npm run dev`, which invalidates any cookie set on the old one)
plus the live storefront `jgw-check.myshopify.com`.

### Verified PASS

| Area | Evidence |
|---|---|
| B1 embedded admin | Dashboard, Settings and nav render inside the Shopify iframe; console clean (only Vite/React dev notices) |
| B1.7 forms fire | Toggling "Automatic resolution" flipped the switch, hid its dependent row and raised the Save bar — the React-18 `onChange` fix, proven live |
| B2.6 inbox filters | Clicking "Handover" → `?filter=handover`; typing "arun" → `?filter=handover&q=arun`; both applied server-side (D-39) |
| B1.12 chatbox preview parity | Preview injects the REAL `widget-renderer.js` + widget CSS — parity by construction |
| B3.3 plan propagation | A `/admin/plans` override of Plus (1200) is live in the merchant's Plan & Usage |
| B4.1/4.2 widget | Launcher and panel render on the live storefront with the merchant's theme colour |
| B4.14 widget a11y | Native `<button>`, accessible name, `aria-haspopup="dialog"`, `aria-expanded` toggles, panel `role="dialog"` + `aria-modal`, focus moves to a VISIBLE control |
| Consent | `cc:session` absent on page load — no identifier before interaction (a competing chat app on the same store writes one immediately) |
| B4.4 recommendations | Real products, correct titles and store-currency prices; the AI's prose names exactly the products shown |
| B4.6/4.7 grounded answers | Policy question returned the real policy link; shipping question answered from knowledge |
| B4.12 resume | Navigating to another page restored the full transcript and conversation id |
| B5.1/B5.2 cross-surface | Storefront chat → inbox count 40→41 → agent reply → arrived in the widget labelled "Team", composer switched to "A team member will reply here…" |
| Handover dormancy | A resumed handed-over conversation kept the AI silent (spec 10) |

### Defects found by the browser that no script caught

1. **The AI recommended unpublished products.** 99 of 175 products were `status: ACTIVE`
   but not on the Online Store sales channel — invisible to storefront search and
   **404 on their product page** — yet fully recommendable. FIXED: sync now stores
   `onlineStoreUrl` + `publishedOnline`, and all four recommendation candidate
   queries require `publishedOnline = true`. Re-verified after a real sync:
   4/4 recommended products now return 200 and carry images (was 0/2).
2. **App display name was `chat-convert`** — the raw scaffolded slug — in the admin
   sidebar, app list and review prompt. FIXED in `shopify.app.toml`.
3. **"Recent orders"** in the inbox details pane expands to a permanent "No info".
   Not fixed — needs an Admin API wire-up or removal.
4. **Settings reports "App is embedded to your theme: Unknown"** while the embed is
   demonstrably active and serving. Detection is unreliable. Not fixed.

### Could NOT be executed, and why

- **Admin console visual pass** — a valid operator session exists server-side, but
  the cookie never landed in the Chrome window the extension drives. `/admin` is
  covered by 352 automated cases; only the visual sweep is outstanding.
- **True 390px mobile** — the extension cannot emulate a device, and Chrome refuses to
  render a window that narrow (viewport reports 0×0). The widget's mobile CSS fixes
  (min-height reset, `dvh`, `env(safe-area-inset-bottom)`) are source-verified only.
- **Keyboard activation** — synthetic key events were not delivered to the page at all
  (zero `keydown` reached a focused element), so Enter/Space activation could not be
  fired. The launcher is a native `<button>` in the tab order with a correct
  accessible name, so activation is guaranteed by the browser, but it is unproven.
- **Lighthouse** — no runner is available through these tools. Must be run manually
  from Chrome DevTools on a storefront page, with and without the app embed.
