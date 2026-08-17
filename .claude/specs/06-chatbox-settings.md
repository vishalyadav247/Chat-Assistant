# 06 — Chatbox Settings (Admin)

> Widget builder: three tabs of settings + live preview with full parity to the storefront widget.
> Sources: design `chatbox.html` (most detailed page) + NOTES.md §Chatbox; consumed by spec 05.

## Purpose

Admin page `/app/chatbox` where merchants configure the widget. Left: settings (tabs General / Chat page / Appearance). Right: sticky live preview that mirrors every change instantly. Page-head On/Off badge + Activate/Deactivate.

## Data model

`WidgetSettings.settings` (JSON, zod-validated) — shape:

```
{
  active: bool,
  chatFocusMode: bool,                       // jump straight to chat; only with liveChat on
  header: { logoUrl?, name ("" → "ChatConvert"), description },
  chatStatus: bool,                          // links to settings?tab=availability
  liveChat: bool,
  contactMethods: { enabled: bool, items: [{type: whatsapp|phone|email, value, countryCode?, order}] },
  orderTracking: bool,                       // method configured in settings?tab=chatbox
  faqs: bool,                                // featured FAQs from spec 07
  welcomeMessage (supports {{customer_name}}), offlineMessageEnabled, offlineMessage,
  starters: { enabled: bool, items: [{emoji, question ≤100, answerHtml, order}] },
  avatarMode: store_branding | team_member,
  prechat: { mode: guest|anonymous|both, showAfterMessages: int (both mode), description,
             fields: [{key: email|name|phone, required}],   // email always present+required
             marketingOptIn: bool, disclaimer: {enabled, html} },
  survey: bool,                              // configured in settings?tab=survey
  appearance: {
    colorMode: solid|gradient, solid: hex, gradient: {start, end},
    launcher: { style: icon|label|icon_label, label ("Chat with us"), icon: chat|help|custom, customIconUrl?,
                position: bottom_right|bottom_left|top_right|top_left,
                bgColor ("" = brand; effective value the widget reads), customBgColor (remembered pick —
                "Use brand color" on/off restores it instead of resetting; 2026-08-17), labelColor },
    // Upload chip stays selectable while the default icon is active; only its ✕ clears customIconUrl.
    removeBranding: bool                     // Basic+ gate
  }
}
```

File uploads (logo ≤2MB PNG/JPG, custom launcher icon) → Shopify Files API (or app CDN) → store URL, never data-URLs (design's FileReader approach is prototype-only).

## UI requirements (from design)

### General tab
Chat focus mode toggle; Header card (logo upload, name, description — live to preview header); Contact & Chat card (chat status → link to availability, live chat toggle, contact methods: add-dropdown WhatsApp/Phone/Email single-use per type, rows with drag reorder + flag/country code for phone + delete); Order tracking toggle (link to settings); FAQs toggle (link to ai-agent FAQs).

### Chat page tab
Welcome message textarea with `{{customer_name}}` insert link + emoji picker + "use different offline message" checkbox; Conversation starter master toggle + question cards (edit modal: question ≤100 with counter, rich-text answer; delete; add; "Import from FAQs" pulls published FAQs); Chat avatar radio (store branding w/ edit link → settings#general | team member profile); Pre-chat form (start-mode radios w/ conditional blocks, show-after-X input in both-mode, description, field rows: Email `Required` fixed, add Name/Phone as `Optional`, delete; marketing opt-in checkbox; disclaimer checkbox → info note + RTE default "By sending us a message, you agree to our privacy policy."); Display satisfaction survey toggle (link settings?tab=survey).

### Appearance tab
Brand colors segmented Solid|Gradient, 6 preset swatches each + custom hex inputs w/ color chips; Chatbox button: launcher style radio-cards, icon choice incl. upload, position select; Remove-branding toggle (gated: locked + upgrade prompt below Basic).

### Live preview (parity contract with spec 05)
Home screen (blocks show/hide with toggles, empty state), chat screen (welcome bubble w/ merge tag → "there", starter chips, input), order tracking screen (tabs, conditional radios, Track btn), launcher (style/icon/position/colors), minimize/restore. Switching to Chat page tab auto-shows chat screen. Preview is a **shared component/renderer with the real widget** where feasible (same settings JSON in → same DOM out) to prevent drift.

## Behavior

- Save model: explicit Save/Cancel bar (Polaris contextual save bar) per tab group; optimistic preview, persisted via action → `WidgetSettings` upsert; `analytics_event(type: widget_settings_saved)`.
- Activate/Deactivate toggles `active` — deactivated widget renders nothing on storefront.
- Onboarding checklist step "Customize your chatbox widget" (13) completes on first save.
- All mutations shop-scoped; validation server-side (zod) mirrors UI constraints (lengths, hex colors, url types).

## Plan gating

Remove-branding: Basic+ (server rejects below tier; UI shows lock + upgrade link).

## Acceptance criteria

1. Every control in the design exists, persists, and round-trips (reload shows saved state).
2. Preview matches storefront widget for the same settings (spot-check launcher variants, colors, prechat modes, starters).
3. Contact-method single-use dropdown + re-add after delete behaves per design.
4. Logo/icon upload stores a URL; 3MB file rejected with clear error.
5. `{{customer_name}}` renders "there" in preview; real name on storefront when logged in.
6. Remove-branding blocked on Free (server + UI); allowed on Basic.
7. Deactivate hides widget on storefront within one config-cache TTL.

## Out of scope / gaps

Team-member avatar management (needs team feature — settings 16 shows invite disabled); import-from-FAQs is read-only pick list v1; per-language starter/welcome translations (backlog with translation settings).
