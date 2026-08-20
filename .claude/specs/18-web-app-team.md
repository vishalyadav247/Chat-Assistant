# 18 — Standalone web app, team logins & browser notifications

> Use the whole app outside the Shopify admin (like Chatty's "Open in web"): merchant team members who are **not** Shopify staff sign in with email + password, work the Inbox, and get browser push notifications when a shopper needs a human.
> Sources: user request 2026-08-19; Chatty reference behaviour; Shopify App Store requirements 1.1.1 / 2.2.2 / 4.5 (see §Compliance).

## Purpose

Add a **second surface** for the existing `/app/*` pages. Nothing about the embedded admin experience changes (App Store req 2.2.2: the embedded app stays feature-complete and primary). The web surface is additive:

- `Open in web ↗` from the admin (Inbox header, Settings → Team) opens a new tab already signed in as the **owner** (one-time handoff token — no password needed; the owner may set one later under Account).
- Settings → Team **invites** create real `TeamMember` rows; the invitee gets an email (or the owner copies the link) → sets name + password → lands in the inbox.
- Roles: **owner/admin** = every page (billing changes stay admin-only); **agent** = Inbox + Contacts.
- **Browser push** (Web Push/VAPID, first-party, no vendor) for handover requests and shopper replies in human-mode chats, per-member toggles; plus a live inbox change feed (SSE) that replaces the 7 s poll on both surfaces.

## Architecture

```
request → requireShopAccess(request, { permission? })        (app/lib/access.server.ts)
  ├─ Shopify signals (id_token / shop / host / embedded / session param, Authorization: Bearer)
  │      → authenticate.admin (unchanged)                     surface = "admin", role = owner
  ├─ valid cc_web_session cookie → TeamSession row → TeamMember   surface = "web", role = member.role
  ├─ stale cookie or cc_surface=web marker                   → 302 /web/login?next=…
  └─ nothing                                                 → authenticate.admin (OAuth bounce as before)
```

- Same URLs on both surfaces (`/app/inbox` etc.). `app/routes/app.tsx` renders App Bridge + `<s-app-nav>` in the admin, and the ChatConvert `WebShell` (no App Bridge) on the web.
- `shopId` always comes from a trusted server record: the Shopify session **or the `TeamSession` row behind an opaque HttpOnly cookie** (4th trusted source; `db-tenancy` skill + `tenancy.server.ts` updated). `SameSite=Lax` means the cookie never reaches admin-iframe requests.
- `getAdmin()` on the access object returns the live admin client in the admin and `unauthenticated.admin(shopDomain)` (offline token) on the web.
- Polaris `<s-*>` load from `polaris.js` without App Bridge (`<AppProvider embedded={false}>`); `app/lib/ui/surface.tsx` provides a `useAppBridge()` **shim** (real global in admin, toast host on web) so existing call sites don't branch. `SaveBar` renders a fixed bar on the web; `ReviewPrompt` is admin-only.
- Web documents get `Content-Security-Policy: frame-ancestors 'none'` (entry.server + `/web/*` headers).

## Data model (migration `20260819180000_team_web_access`)

- `TeamMember` — `shopId`, `email`, `name`, `role` owner|admin|agent, `status` invited|active|disabled, `passwordHash?` (scrypt, Node crypto), `notifyPrefs` JSON `{push:{handover,humanReply,newConversation}, emailHandover, sound}`, `failedLogins`, `lockedUntil`, invited/joined/lastLogin timestamps. `@@unique([shopId,email])`. Backfilled from the old `ShopSettings.settings.team.members` JSON (ids preserved → `Conversation.assigneeId` keeps working); the JSON key is gone from the schema.
- `TeamSession` — `tokenHash @unique` (sha256 of the raw token), `shopId`, `memberId`, `kind` session|handoff|invite|reset, `expiresAt`, `lastSeenAt`, `userAgent`. Sessions: 30-day sliding; handoff 2 min; invite 7 days; reset 1 h.
- `PushSubscription` — `endpoint @unique`, `p256dh`, `auth`, `shopId`, `memberId`, `lastUsedAt`, `failedAt`.
- Owner assignee stays the literal `assigneeId = "owner"`; `assigneeKeyFor(member)` maps the owner row to it.
- Plan matrix: new quota `team_seats` (members excl. owner) — provisional Free 1 / Basic 3 / Pro 5 / Plus 10; enforced at invite via `getQuota` (no-op while `ENFORCEMENT = "open"`).

## Routes & modules

| Path | Purpose |
|---|---|
| `app/lib/access.server.ts` | `requireShopAccess`, `can(role, surface, permission)`, `requireAdminSurface`, `requireWebSurface` |
| `app/lib/team/*.server.ts` | `team` (roster, invites, login, owner bootstrap, recipients), `password` (scrypt), `tokens`, `web-session` (cookie), `team-intents` (Settings intents), `login-limiter` |
| `app/lib/email/email.server.ts` | `sendEmail` — `EMAIL_PROVIDER=log|resend`; templates invite / reset / handover |
| `app/lib/notify.server.ts` → `app/lib/notify/{deliver,push}.server.ts` | producers enqueue pg-boss `team-notify`; job picks recipients (role, assignment, prefs) → Web Push + handover email |
| `app/routes/web.*` | `web.tsx` layout, `login`, `logout`, `forgot`, `reset.$token`, `invite.$token`, `handoff`, `_index` |
| `app/routes/app.web-handoff.tsx` | admin-only: ensure owner row + mint handoff token |
| `app/routes/app.account.tsx` | web-only: profile, password, notification prefs + enable/disable push on this device, sign out everywhere |
| `app/routes/app.push-subscription.tsx` | web-only: POST subscribe / DELETE unsubscribe |
| `app/routes/app.inbox-events.tsx` + `app/lib/ui/inbox-live.ts` | POST fetch-stream SSE change feed (3 s DB signature check, 10 min max, client reconnects) — both surfaces |
| `app/components/web/*` | `WebShell` (rail nav + account footer + push prompt), `AuthCard`, `OpenInWebButton` |
| `public/sw.js` | service worker: show notification, click → focus/open `/app/inbox?c=` |

Env: `WEB_APP_URL?` (defaults to `SHOPIFY_APP_URL`), `EMAIL_PROVIDER` (`log` | `resend` | `smtp`), `RESEND_API_KEY` / `SMTP_HOST|PORT|USER|PASS|SECURE`, `EMAIL_FROM`, optional `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`. **Push is zero-config**: without env VAPID keys a pair is generated once and stored in `app_secrets` (`app/lib/notify/vapid.server.ts`; env overrides — subscriptions are bound to the public key, so keep it stable). Email without a provider falls back to console log + copy-link UI (the Team section says so).

## Notifications

| Event | Producer | Default push | Recipients |
|---|---|---|---|
| handover (inbox/contact-methods destination, or handover/leave-message form submitted) | `pipeline/handover.server.ts` (when no form shown), `inbox.server.ts submitHandoverForm` | on | assignee if assigned, else all active members with the pref; handover **email** to members with `emailHandover` (default on for owner/admin) |
| shopper message while `mode=human` | `pipeline/index.server.ts` human-mode branch | on | assignee if assigned, else all with the pref |
| new conversation | `ensureConversation` create | off | all with the pref |

Payload (encrypted end-to-end per Web Push): title, ≤80-char snippet, deep link, `tag = conversationId` (collapses repeats). Deep links go through `/web/login?next=/app/inbox?c=…` (signed-in browsers are forwarded; a fresh device gets the login form, never the Shopify admin bounce). The handover **email** carries no transcript snippet (third-party processor). Test-console and blocked conversations never notify. Dead endpoints (404/410) are pruned on send. Browser push is only offered on the web surface (permission prompts are blocked inside the admin iframe). The web inbox also badges the tab title `(n) Inbox` and (pref) chimes on new activity while the tab is hidden.

## Compliance & security

- Embedded routes keep session-token auth (req 1.1.1); the web surface uses a first-party `HttpOnly; Secure; SameSite=Lax` cookie. `shopify-compliance` skill rule scoped accordingly.
- Login: generic errors (no enumeration), per-device limiter (20/10 min), per-account lockout (5 fails → 15 min), reset/invite tokens single-use, password change revokes other sessions. Open-redirect guard on `?next`; Origin/Referer check on the cookie-less auth POSTs (login CSRF); reset links never for the owner row and web admins may only reset agents; owner-row bootstrap drops any pre-seeded password/sessions; the inbox change feed re-validates the web session every ~15 s; push endpoints must be https on public hosts (SSRF guard); `Referrer-Policy: no-referrer` + `Cache-Control: no-store` on token-bearing web pages.
- Team member PII (name, email) + push endpoints are shop-scoped and deleted by `cleanupShop` (`scripts/verify-compliance.ts` asserts 30 tables). Resend (if enabled) is a processor → privacy policy. Polaris licence: the web shell is ChatConvert-branded and visually distinct from the admin.
- App Store review (req 4.5): testing instructions must include a working web login (invite a reviewer account on the review store).

## Acceptance criteria

1. Admin unchanged: every `/app` page renders embedded; toasts/save bar/review prompt behave as before; Inbox updates via the change feed (+30 s fallback poll).
2. Inbox → **Open in web** opens a new tab signed in as owner on `/app/inbox`; nav shows all pages; Plan & Usage is read-only with an admin deep link; `/app/account` exists; sign out → `/web/login`.
3. Settings → Team: invite creates an Invited member (seat quota respected), returns a copy-able link, emails when `EMAIL_PROVIDER=resend`; resend/reset-link/role/disable/remove work; removing a member kills their sessions and unassigns their conversations.
4. Invite link → set name + password → lands in inbox; an **agent** sees only Inbox + Contacts, `/app/settings` → "No access"; an **admin** sees everything except billing actions.
5. Login: wrong password → generic error; 5 failures → locked 15 min; email on two stores → store picker; forgot-password flow works (email or owner-issued link).
6. Security: `/app/*` with a web cookie **and** Shopify signals takes the admin path; forged/expired cookie → login redirect; handoff token is single-use and expires in 2 min; every new query is shop-scoped (tenancy audit).
7. Push: with VAPID keys, enabling notifications in Account subscribes the browser; a storefront handover and a shopper reply in a human-mode chat produce OS notifications that open the conversation; toggles stop them; stale endpoints are pruned.
8. `cleanupShop` removes team rows; `npx tsx scripts/verify-compliance.ts` passes.

## Audit record (2026-08-19)

tenancy-auditor: 0 LEAK; RISKs (admin→owner reset link, owner promotion keeping a password, login CSRF, SSE surviving revocation, browse-data unpermissioned) all fixed. shopify-reviewer: 0 Critical; Majors fixed (App Bridge `window.open("")` resolving to the iframe URL → `about:blank`; push endpoint SSRF guard; notification deep links via `/web/login?next=`); minors fixed (account page no redirect in admin, SW top-level client + fallback, entry.server path match + no-store/no-referrer, generic login error, no snippet in email, JSON roster stripped by migration `20260819183000_strip_team_json`, new-conversation enqueue gated, title-badge regex, toast host always mounted, 17track link target=_blank). Remaining process items: web test login in App Store testing instructions (4.5), privacy policy (Resend, team accounts, push endpoints).

## Out of scope / later

Per-seat pricing, SSO/Google login, 2FA, email-only (passwordless) login, mobile PWA install manifest, push inside the embedded admin, member activity audit log, "assigned to me" inbox filter, Slack.
