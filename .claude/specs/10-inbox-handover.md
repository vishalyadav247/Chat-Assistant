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
Conversation details: customer card (name/email/phone from Contact), **Assignee** (owner + team members from the `TeamMember` table — spec 18; assignment also scopes who gets notified); meta accordions Visitor device / Recent orders / Browsed pages (from widget pageContext + contact); **Shopping cart** card — **premium gate** (Upgrade pill below required tier): live cart line items + total captured from widget cart context; Satisfaction survey card (rating or "Visitor has not rated yet"); footer **Block** (blocks visitor session: widget shows blocked state, conversation tagged) + **Delete** (hard delete conversation + messages, confirm dialog).

Responsive: collapse Details ≤1240, Filters ≤1040 per design.

### Realtime
`/app/inbox-events` POST fetch-stream SSE change feed (spec 18) → loader revalidation on every change; 30 s poll kept as fallback. Unread counts server-computed. Web surface: tab-title badge + optional chime.

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

### Human-support mode (2026-09-11, user decision)
A shop that has NOT activated the AI agent runs chat as a **human channel** — implicit, no
separate setting: `aiEnabled=false` (and not Test AI) makes the pipeline flip each
conversation to `mode="human"` on its FIRST turn instead of dead-ending on the offline
message. One system waiting message is sent — **merchant-editable** (2026-09-11, user request:
`shopSettingsSchema.humanModeMessage`, edited in **Settings → Chatbox** ("Human support
mode" card, saved with the tab's normal SaveBar; the AI Agent page's off-banner links
there). Placement settled after two rejected homes the same day (user): NOT the Human
handover tab ("handover is a different setting") and NOT an inline card on the AI Agent
page ("not looking good") — a banner link + Settings is the pattern. Blank → the
pipeline's default "our team is helping other customers right
now — we'll connect you with an agent shortly"; sourceLayer `human` — deliberately NOT
`handover`, which the analytics rollup counts), the
team is notified via the same `notifyShopperMessage` dispatch, and every later turn takes
the existing human-mode branch (AI dormant, Inbox replies reach the widget via its
5-second human-mode polling). Inbox list shows a green **Human** tag for
`mode=human && !handover` (Handover keeps its own tag; zero schema change). Everything
else — FAQs, order tracking, contact methods, starters, pre-chat, surveys, chat
availability — is AI-independent and unchanged. The usage-cap case (`aiAllowed` false with
AI activated) deliberately keeps the offline message: a quota running out must not flood
the team with live chats. These conversations never tick the AI conversation meter.

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

Attach/file uploads in composer, Slack notifications, typing indicators for merchant, IP-level blocking, websockets. (Team assignment, live feed and push/email notifications moved into spec 18.)
