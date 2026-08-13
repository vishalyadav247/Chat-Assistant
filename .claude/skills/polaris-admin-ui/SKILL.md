---
name: polaris-admin-ui
description: Building ChatConvert admin pages with Polaris web components from the HTML design prototypes. Use when creating or modifying any /app route UI.
---

# Polaris admin UI conventions

## Source of truth for layout & interactions

The design prototypes in `.claude/resources/html_design/` + `NOTES.md` define every screen's structure, states, and interaction logic. **Carry over: structure, flows, interaction logic. Rebuild: styling (Polaris), data (loaders/actions).** Do not invent layouts; open the design file for the page you're building.

## Component mapping

- This template uses **Polaris web components** (`<s-page>`, `<s-section>`, `<s-card>`-family, `<s-button>`, `<s-text-field>`, `<s-select>`, `<s-switch>`, `<s-badge>`, `<s-data-table>`/index-table equivalents, `<s-modal>`, `<s-app-nav>`). Check `@shopify/polaris-types` + shopify.dev "Polaris web components" docs (via shopify-dev-mcp) for available elements/attributes — do not assume React Polaris API names.
- Design tokens → Polaris: **brand gradient policy (user decision 2026-08-10)** — the `#6d3bf5→#3b82f6` brand gradient IS allowed on hero/marketing/progress surfaces (dashboard hero banner, setup-card accents, promo cards, ProgressRing/ProgressTrack fills, template-picker previews, chat bubbles). Forms, tables, buttons, badges stay Polaris-native. All brand colors/gradients come from `app/components/ui/tokens.ts` (`BRAND`) — never hardcode `#6d3bf5`. The widget preview inside admin (chatbox page) keeps full custom brand styling.
- **Shared UI primitives live in `app/components/ui/`** — use them, don't re-roll: `tokens.ts` (SPACE/RADIUS/BRAND/SHADOW/TONES), `PageHeader` (back+tabs+toolbar row), `TabPills` (the ONE tab implementation), `Row`/`Toolbar` (no new raw `gap: N` inline styles — use SPACE keys), `StatTile`/`StatGrid` (KPI tiles: icon chip, tone, delta pill, sparkline, live variant, inset/elevated), `StripBanner` (two-part strip+body banner), `EmptyState`, `Progress` (ProgressRing/ProgressTrack).
- Design's custom toggles/pills/tables → nearest Polaris equivalent; don't pixel-clone admin chrome (the prototypes' fake Shopify sidebar/topbar is replaced by real Admin + `<s-app-nav>`).

## Patterns

- App nav: extend `app/routes/app.tsx` `<s-app-nav>` with the 10 sections (Dashboard, Inbox, Contacts, Chatbox, AI Agent, Proactive Chat, Curated Answers, Analytics, Plan & Usage, Settings).
- Forms: loader supplies current values → controlled inputs → `useSubmit`/fetcher actions → contextual save bar pattern (dirty-state Cancel/Save like the designs); server-side zod validation mirrors UI counters/limits (e.g. 100/250/1000-char fields show live counters per design).
- Tables (**user directive 2026-08-12: use the native Polaris table**): new or redesigned tables use the `s-table` family (`s-table` → `s-table-header-row`/`s-table-header` → `s-table-body`/`s-table-row`/`s-table-cell`; `format="numeric"` on numeric headers) — NOT hand-rolled `<table>` markup. The shared `app/components/DataTable.tsx` wrapper implements ALL of this furniture on `s-table` — pills go in its `toolbar` prop, collapsible search is built in (pass `searchFn`), selection + "N selected" bar via the `bulkActions` prop, footer (centered pager + items-per-page) always visible (`perPageSelector={false}` for server-fixed page sizes like Contacts). Use DataTable for every admin table (reference consumer: `TrainingDiscountsTab.tsx`); go direct to `s-table` only for shapes DataTable can't express. Clickable rows: `s-table-row` has NO onClick — set `clickDelegate` to the id of an `s-clickable` wrapping the first cell (see DataTable). Custom-designed surfaces are exempt from Polaris-native chrome: the Inbox 3-pane chat UI (`cin-*`), TestAiConsole chat surface, widget preview, and App Bridge contracts like `ui-save-bar` (requires plain `<button>` children). Standard furniture (per discount_screen_2.png): status pills (`SubTabs`) left + **collapsible search** right (tertiary `s-button icon="search"` toggles an `s-search-field`; icon flips to `x` to close+clear); row selection = `s-checkbox` column (header checkbox = select page, `indeterminate` for partial) + a "N selected" bar with bulk-action buttons; footer = 3-col grid with **pager centered** (chevron buttons + "Page X / Y") and one-line "Items per page" `s-select` (10/25/50) right. Empty states use the designs' copy verbatim.
- Modals: one component per design modal; close via X/backdrop/Esc; destructive actions get confirmation.
- Toasts via App Bridge for save/job feedback; skeletons for loaders.
- **Icons: official Polaris icons ONLY** (user directive 2026-08-10). Never use text glyphs (▸ ▾ ▲ ▼ ★ ☆ ✕ ✓ ← → ↑ ↓) as UI icons — use `s-icon type="..."` / `s-button icon="..."` (`chevron-*`, `caret-*`, `arrow-*`, `star`/`star-filled`, `x`, `check`, `drag-handle`, `import`, `export`, `plus`…; full list in `@shopify/polaris-types`). No decorative trailing arrows on buttons/links. Emoji as merchant-editable DATA (FAQ category icons, starter emojis) are fine — the rule covers UI chrome.
- Grouped toolbar actions: `s-button commandFor` + `s-menu` ("More actions" / "Add new" pattern, see FaqManager). Filters: `s-clickable-chip commandFor` + `s-popover` with a choice list, removable ✕ when active.
- Reordering: drag handles (drag starts from the handle only — rows stay scrollable), shared `app/components/DragReorder.tsx` for flat lists; keep ArrowUp/Down keyboard fallback. Row hover = scoped stylesheet (see FaqManager TABLE_CSS).
- Counts/quotas/meters always come from server data derived from the plan matrix (spec 15) — never hard-code tier values (design bug to avoid).
- Currency: format with shop currency/locale from loader data (designs mix ₹/$ — ignore that).

## Files

Route files follow flat convention: `app.chatbox.tsx`, `app.ai-agent.tsx`, `app.ai-agent.training.tsx`, etc. Shared UI in `app/components/`. Every nested route exports `boundary.error`/`boundary.headers` (see shopify-app-dev skill).
