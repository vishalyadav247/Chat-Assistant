# 10 — Inbox & Human Handover

> The merchant's conversation workspace + the runtime that hands shoppers from AI to humans.
> Sources: design `inbox.html` + NOTES.md; `Chat-Flow-Explained.md` step 6; handover config shape from spec 08; conversation model from 01.

## Purpose

Admin page `/app/inbox`: 4-column workspace (Filters | List | Thread | Details) for live + historical conversations, with human reply into the shopper's widget. Plus the handover runtime: triggers → ticket → AI dormant → human resolves.

## Inbox UI (per design)

### Filters rail (with live counts)
All (badge = unread open count, red) · Open · Resolved · Unassigned (!assigned && open) · Handover · Starred · Blocked. Blocked conversations excluded from all views except Blocked.

### List column
Title reflects filter; **Unread-only toggle**; search by name; rows: gradient avatar initials, name, ★, relative time, unread dot, preview, tags (channel "Online store", Handover, AI=processing). Row click → mark read + open. Empty: "Nothing here yet."

### Thread column
Contact name + Anonymous tag; star toggle; **Resolve** button (open↔resolved, "Resolved ✓"); kebab. Message rendering: time dividers, `in`/`out` bubbles, `sys` events ("Handed over to a human agent.", "ChatConvert AI is preparing an answer…", "Visitor blocked.", "Conversation resolved."), Seen receipt. Composer: contenteditable, emoji/attach (v1: emoji real, attach hidden), Send disabled until text, Enter=send / Shift+Enter=newline. Sending as merchant: message role=out(author=agent) → delivered to widget (05 polling channel); conversation mode stays/becomes `human`.

### Details column
Conversation details: customer card (name/email/phone from Contact), **Assignee** (v1: single-user — Assign disabled like settings' invite; show "Unassigned"); meta accordions Visitor device / Recent orders / Browsed pages (from widget pageContext + contact); **Shopping cart** card — **premium gate** (Upgrade pill below required tier): live cart line items + total captured from widget cart context; Satisfaction survey card (rating or "Visitor has not rated yet"); footer **Block** (blocks visitor session: widget shows blocked state, conversation tagged) + **Delete** (hard delete conversation + messages, confirm dialog).

Responsive: collapse Details ≤1240, Filters ≤1040 per design.

### Realtime
v1: list + thread poll (5–10s) via loader revalidation; unread counts server-computed. (SSE/live upgrade later.)

## Handover runtime

### Triggers (config from 08)
- Explicit ask (always on): router/keyword detection of "talk to human" etc.
- Cannot answer: N (default 2) consecutive fallback/low-confidence turns.
- Repeated question: same question (embedding similarity) 2+ times.
- Negative sentiment (opt-in): heuristics (ALL CAPS, repeated punctuation, negative emojis, 2+ thumbs-down).
- Intent rules: semantic match on merchant topics (embedded, matched like banned topics).

### Flow (destination per config)
1. Trigger fires → sys message + calm handover copy (config messages).
2. **inbox destination**: capture email if unknown (pre-chat/inline form) → conversation flagged handover, mode=human, unread; merchant notified (email v1); AI dormant per aiWhileWaiting (never / outside business hours / always — availability from 16); widget shows "a team member will reply".
3. **collect_email destination**: form (configured fields: email+issue required, optional order#/phone/photo) → creates Contact(lead) + conversation note + post-submit message; expected reply time shown ("Within 24 hours").
4. **contact_methods destination**: message + contact method chips (from 06 settings).
5. Human resolves → Resolve button → sys message, mode back to `ai`, status resolved; survey trigger (16) may fire.

### Auto-resolution
Settings (16): auto-resolve after N minutes/hours/days of inactivity → status resolved + sys message + survey trigger.

## Business rules

- All queries shop-scoped; Block acts on session+contact, not IP (v1).
- Merchant replies allowed on any open conversation regardless of handover (taking over sets mode=human).
- Dashboard live feed (13) + analytics resolution split (14) read from these rows/events.
- Deletion respects GDPR expectations (hard delete).
- Handed-over conversations tick the usage meter only once per session (15 rule: 1 conversation = session).

## Acceptance criteria

1. Filters/counts/unread/search/star/resolve/block/delete all function; empty states per design.
2. AI→handover→human reply→widget delivery round-trip works (two browsers: admin + storefront).
3. Each trigger type fires per config thresholds (scripted conversations); AI stays dormant per aiWhileWaiting mode, resumes on resolve.
4. collect_email flow creates a lead Contact and shows configured messages; contact-methods flow renders chips.
5. Auto-resolve fires after configured inactivity; survey prompt appears when its trigger matches.
6. Cart card hidden below required tier; visible with live items above it.
7. Merchant reply marks Seen when widget renders it.

## Out of scope / gaps

Multi-agent assignment (team invites disabled v1), attach/file uploads in composer, Slack notifications (email only v1), typing indicators for merchant, IP-level blocking, realtime websockets.
