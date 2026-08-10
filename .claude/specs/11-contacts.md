# 11 — Contacts (CRM)

> Everyone who talked to the widget or left contact info, classified and exportable.
> Sources: design `contacts.html` + NOTES.md; Contact model from 01; creation paths from 05 (pre-chat), 08/10 (lead capture).

## Purpose

Admin page `/app/contacts`: list + stats of contacts collected across channels, with type classification and CSV export.

## Data model

`Contact` (01): name, email, phone, type, channel, location, marketingOptIn, conversationCount (computed or denormalized), createdAt.

### Type classification (auto, re-evaluated on events)
- **customer** — matched to a Shopify customer with ≥1 order (match by email via Admin API customer lookup; requires no PCD for basic match v1 — if restricted, classify customer only via logged-in storefront session `customer.id`).
- **lead** — shared contact info (pre-chat email, fallback capture, handover form) without known order.
- **anonymous** — chatted, no identity (sessionId only; name "Visitor N").

### Channel enum (design)
`store` (Online store) live now; `email`, `msgr`, `wa`, `ig` reserved (multi-channel roadmap) — enum includes them, UI renders labels.

### Location
Coarse geo from request (country/city via CDN headers if available) — best-effort, blank OK.

## UI (per design)

- **Stat tiles** (server-computed): Total contacts ("across all channels"), Customers ("have placed an order"), Leads ("shared contact info"), Anonymous ("not yet identified").
- Panel: search name OR email; sort (v1: created desc; sort button decorative→implement created/name toggle); tabs All / Customer / Lead / Anonymous.
- Table: Name (avatar initials) | Email (`—` if empty) | Type badge | Channel | Location | Conversations (right-aligned). Row click → contact detail (v1: side panel with info + conversation list linking to inbox).
- Pagination: 10/page, Page x/y, prev/next disabled states, rows-per-page select.
- Empty state: "No contacts match your search."
- **Export modal**: radio Current page / All contacts → CSV download (async job if >1k rows), columns = table + optIn + created.

## Creation/update paths

- Pre-chat form submit (05) → upsert by (shopId, email) → lead (or customer if match).
- Fallback email capture (08) → lead.
- Logged-in storefront shopper chats → customer (from liquid customer object).
- Anonymous conversation start → anonymous contact bound to sessionId; upgraded in-place when identity arrives (no duplicates).
- Marketing opt-in flag from pre-chat checkbox; syncing opt-in to Shopify customer (accepts_marketing) — **only** with explicit opt-in and documented scope (write_customers) — deferred, flagged for compliance review (17).

## Business rules

- Upsert by email within shop; anonymous merge on identify.
- GDPR: customers/redact (17) deletes matching contacts + their conversations; retention window (16) applies to conversations, not contacts (contacts kept until redact/uninstall).
- Shop-scoped everything; export never leaks cross-shop.

## Acceptance criteria

1. Each creation path produces the right type; anonymous→lead upgrade merges (no dup rows).
2. Stats, tabs, search, pagination behave per design; conversation counts accurate and link to inbox.
3. Export current-page vs all produces correct CSVs (encoding UTF-8, opt-in column).
4. Redact request removes contact + conversations (verified in 17 tests).

## Out of scope / gaps

Multi-channel ingestion (email/messenger/whatsapp/instagram), contact editing/notes, segments, Shopify customer sync write-back.
