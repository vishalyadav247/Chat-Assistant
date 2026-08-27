# 20 — Mobile responsiveness (whole app usable on a phone)

## Goal

Every `/app` page and feature works cleanly at phone width (~390px) on both surfaces — the standalone web app (spec 18; mobile-first for Agents) and the embedded admin (Shopify mobile app webview). **Desktop (≥769px) rendering stays pixel-identical**: every change is an additive `@media (max-width: 768px)` / `(pointer: coarse)` rule or a behavior-neutral wrap.

## Rules (also in the polaris-admin-ui skill)

- One breakpoint: **768px** — `BP_MOBILE` / `MOBILE_MEDIA` in `app/components/ui/tokens.ts`.
- Global stylesheet `app/components/app-mobile.css` (linked from `app.tsx` `links`, reaches both surfaces). Opt-in classes: `.cc-split` (multi-column grid → one column, sticky children un-stick), `.cc-mobile-only` / `.cc-desktop-only`, `.cc-chart-scroll`, `.cc-panel-head`, `.cc-testchat`, `.cc-reorder-btns`.
- Markup/attribute swaps (`s-grid` templates) use `useIsMobile()` (`app/lib/ui/use-mobile.ts`, SSR-safe: desktop on server/first paint).
- Mobile inputs ≥16px font (iOS focus-zoom); `viewport-fit=cover` + `env(safe-area-inset-*)` for fixed bottom elements.
- New layouts must not hard-code column px without a ≤768px collapse.

## Behavior

- **Web shell** (≤900px): sticky top bar (hamburger + brand + Inbox unread pill) + the dark rail as a slide-in drawer (backdrop, Escape, closes on navigation). Desktop side rail untouched ≥901px.
- **Inbox** (≤768px): one pane at a time keyed off `?c=` — no `?c=` → list (horizontal filter-chip row + search + rows), `?c=` → full-screen thread with a back button (clears `?c=`; browser Back equivalent; mark-read semantics unchanged). Filters rail/Details column stay hidden as before; an **info button** in the thread header (visible <1241px, i.e. wherever the Details column is hidden) opens `InboxDetails` as a right slide-over — restoring assignee/contact/orders/cart/survey/block/delete at tablet + phone widths. Height fit uses `visualViewport` so the composer rides above the on-screen keyboard.
- **DataTable**: table pans inside an `overflow-x:auto` wrapper; fixed column widths apply ≥769px only; bulk bar wraps; footer pager centers with the per-page cluster wrapping under it.
- **Splits stacked** via `.cc-split`: chatbox editor+preview, curated-answers editor+panel, TestAiConsole chat+side, PlanCards 2×2 → 1-col.
- **FAQ tree**: Status/Featured tracks shrink to content ≤768px; filter selects flex full-width.
- **Reordering on touch**: `ReorderButtons` (up/down) render next to every `DragHandle` and the FAQ tree handle on coarse pointers (HTML5 drag doesn't fire on touch); keyboard fallback unchanged.
- Misc: analytics chart pans horizontally (min 640px) instead of shrinking labels; contact panel header wraps + `InfoRow` values wrap; availability day rows and chatbox contact-method rows wrap; web SaveBar respects the home-indicator safe area; auth pages already responsive.

## Mobile design language (v3, 2026-08-20 — Chatty reference)

Reference screenshots (layout only) are not retained; the shipped mobile UI is the reference.

- 8pt rhythm, >=44px touch targets, 16px inputs; white radius-12/14 cards on the #f6f6f7 canvas.
- **Top bar**: dark; hamburger + brand mark + name/shop column; unread Inbox pill + member avatar (gradient chip -> /app/account) right.
- **Drawer**: LIGHT panel (main_nav.png) — canvas background, dark text, plain line icons, active row = white card + shadow with accent icon chip; rounded right edge, blur scrim, spring curve, safe areas. Desktop rail keeps its dark theme (overrides live only in the <=900px block).
- **Inbox** (inbox_nav.png / conversation.png): list header = [filter button] [active-filter title] ... [Unread toggle], search full-width below; the filter button opens the SAME <InboxFilters> rail as a left slide-over (.cin-fov, grouped + counts, closes on pick/backdrop/Escape); rows 44px avatars; thread = 52px header, gradient out-bubbles, rounded composer + circular send.
- **KPI tiles**: stacked single column of flat compact tiles (dashboard.png / analytics.png) — .cc-statgrid forces 1-col <=768px.
- **Tabs**: TabPills (.cc-tabpills) become one horizontally-scrollable row <=768px, hidden scrollbar.
- **Plans** (plans.png): .cc-plan-carousel — horizontal scroll-snap carousel, 82%-wide cards with a peeking next card.
- Tables/training pages already match the reference structure (card header + actions, tab pills + search icon, x-scroll table, centered pager).

## Acceptance criteria

1. At 390px, every page renders with **no horizontal document scroll** (wide tables/charts pan inside their own containers).
2. Inbox on a phone: list → tap row → thread → back → list; filter chips switch tabs; info button opens details; assignee can be changed; send reply works with the keyboard open.
3. Web shell on a phone: drawer opens/closes (hamburger, backdrop, Escape, navigation); all nav items reachable; sign-out reachable.
4. Reordering (FAQ tree, starter questions, contact methods) possible on a touch device via the up/down buttons.
5. Desktop ≥769px: no visual change on any page (all new rules media-gated; wraps engage only when content doesn't fit).
6. `npm run typecheck` / `lint` / `build` green.
