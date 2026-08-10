---
name: polaris-admin-ui
description: Building ChatConvert admin pages with Polaris web components from the HTML design prototypes. Use when creating or modifying any /app route UI.
---

# Polaris admin UI conventions

## Source of truth for layout & interactions

The design prototypes in `.claude/resources/html_design/` + `NOTES.md` define every screen's structure, states, and interaction logic. **Carry over: structure, flows, interaction logic. Rebuild: styling (Polaris), data (loaders/actions).** Do not invent layouts; open the design file for the page you're building.

## Component mapping

- This template uses **Polaris web components** (`<s-page>`, `<s-section>`, `<s-card>`-family, `<s-button>`, `<s-text-field>`, `<s-select>`, `<s-switch>`, `<s-badge>`, `<s-data-table>`/index-table equivalents, `<s-modal>`, `<s-app-nav>`). Check `@shopify/polaris-types` + shopify.dev "Polaris web components" docs (via shopify-dev-mcp) for available elements/attributes — do not assume React Polaris API names.
- Design tokens → Polaris: accent `#6d3bf5` gradients are **widget-only** branding; admin UI uses standard Polaris tokens (merchants expect native admin look). The widget preview inside admin (chatbox page) keeps the custom brand styling.
- Design's custom toggles/pills/tables → nearest Polaris equivalent; don't pixel-clone admin chrome (the prototypes' fake Shopify sidebar/topbar is replaced by real Admin + `<s-app-nav>`).

## Patterns

- App nav: extend `app/routes/app.tsx` `<s-app-nav>` with the 10 sections (Dashboard, Inbox, Contacts, Chatbox, AI Agent, Proactive Chat, Curated Answers, Analytics, Plan & Usage, Settings).
- Forms: loader supplies current values → controlled inputs → `useSubmit`/fetcher actions → contextual save bar pattern (dirty-state Cancel/Save like the designs); server-side zod validation mirrors UI counters/limits (e.g. 100/250/1000-char fields show live counters per design).
- Tables: search + filter chips + pagination (10/page) as in designs; empty states use the designs' copy verbatim.
- Modals: one component per design modal; close via X/backdrop/Esc; destructive actions get confirmation.
- Toasts via App Bridge for save/job feedback; skeletons for loaders.
- **Icons: official Polaris icons ONLY** (user directive 2026-08-10). Never use text glyphs (▸ ▾ ▲ ▼ ★ ☆ ✕ ✓ ← → ↑ ↓) as UI icons — use `s-icon type="..."` / `s-button icon="..."` (`chevron-*`, `caret-*`, `arrow-*`, `star`/`star-filled`, `x`, `check`, `drag-handle`, `import`, `export`, `plus`…; full list in `@shopify/polaris-types`). No decorative trailing arrows on buttons/links. Emoji as merchant-editable DATA (FAQ category icons, starter emojis) are fine — the rule covers UI chrome.
- Grouped toolbar actions: `s-button commandFor` + `s-menu` ("More actions" / "Add new" pattern, see FaqManager). Filters: `s-clickable-chip commandFor` + `s-popover` with a choice list, removable ✕ when active.
- Reordering: drag handles (drag starts from the handle only — rows stay scrollable), shared `app/components/DragReorder.tsx` for flat lists; keep ArrowUp/Down keyboard fallback. Row hover = scoped stylesheet (see FaqManager TABLE_CSS).
- Counts/quotas/meters always come from server data derived from the plan matrix (spec 15) — never hard-code tier values (design bug to avoid).
- Currency: format with shop currency/locale from loader data (designs mix ₹/$ — ignore that).

## Files

Route files follow flat convention: `app.chatbox.tsx`, `app.ai-agent.tsx`, `app.ai-agent.training.tsx`, etc. Shared UI in `app/components/`. Every nested route exports `boundary.error`/`boundary.headers` (see shopify-app-dev skill).
