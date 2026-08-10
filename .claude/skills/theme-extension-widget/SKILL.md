---
name: theme-extension-widget
description: Storefront chat widget development — theme app extension, app proxy calls, SSE client, cart interactions. Use when working in extensions/chat-widget/ or on proxy.* routes.
---

# Storefront widget development

Spec: `.claude/specs/05-storefront-widget.md`. UI truth: the live-preview widget in `.claude/resources/html_design/chatbox.html` (screens, states, flows).

## Extension rules

- `extensions/chat-widget/` is a **theme app extension** (app embed block). Vanilla JS/CSS only — no framework, no external CDNs (review + performance). Target <30KB gz core, script deferred, zero CLS (launcher reserves its own fixed-position space).
- Style isolation: Shadow DOM (preferred) or strict `cw-` prefix; never leak styles into the theme. All branding (colors/launcher/logo) comes from settings JSON, applied as CSS custom properties (`--cw1`, `--cw2`).
- Liquid block may read `customer.first_name` (for `{{customer_name}}`) and template context (page type for campaigns) — nothing else from the theme.

## Backend calls (app proxy only)

- Base path `/apps/chatconvert/*` → proxied to the app's `proxy.*` routes. The widget NEVER calls OpenAI or carries any secret.
- Config: `GET /apps/chatconvert/widget-config` (cache ~5 min in memory + sessionStorage). App uninstalled/disabled → 404 → render nothing, no console errors.
- Chat: `POST /apps/chatconvert/chat` with `{sessionId, conversationId?, message, pageContext}`; read the streamed body:

```js
const res = await fetch(url, {method:"POST", body: JSON.stringify(payload)});
const reader = res.body.getReader(); // parse SSE frames: token | cards | message | done
```

- Not `EventSource` (GET-only). Handle heartbeat comments; on network drop show retry UI (no auto-resume v1).
- Human-mode: poll `GET /apps/chatconvert/messages?since=` every 5s while `mode=human`.

## Cart

- Add to cart via theme AJAX API `POST /cart/add.js` with variant id; then per settings either trigger the theme cart drawer (publish `cart:refresh`-style events / theme-specific hooks per settings.theme) or confirm in-chat. Set cart attribute `chatconvert_campaign` for attribution when a campaign drove it.

## Session & privacy

- `sessionId` UUID in localStorage (functional storage only — no tracking cookies). New session after 30 min inactivity (billing meter definition, spec 15).
- Accessibility: focus trap when open, `aria-live="polite"` message list, Escape closes, prefers-reduced-motion respected.

## Testing

- Always verify on a real dev-store storefront (`shopify app dev` → preview). Streaming through the CLI tunnel may buffer — use the `/apps/chatconvert/ping` probe; if buffered, test against localhost networking mode before blaming code.
