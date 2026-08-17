# Asking merchants for App Store reviews

A portable guide for wiring review prompts into a Shopify app. Written while building it
into Linkfront, but nothing here is Linkfront-specific — the worked example at the end is,
and it's marked as such.

Everything below is from Shopify's own docs:

- [Reviews API reference](https://shopify.dev/docs/api/app-home/apis/user-interface-and-interactions/reviews-api)
- [Manage app reviews](https://shopify.dev/docs/apps/launch/marketing/manage-app-reviews)

---

## 1. What you actually get

`shopify.reviews.request()` — an App Bridge call that asks Shopify to open **its own** review
modal, overlaid on your app inside the admin. The merchant rates and comments without ever
leaving your app.

```ts
const result = await shopify.reviews.request();
// → { success: true,  code: 'success' }
// → { success: false, code: 'cooldown-period', message: '…' }
```

You decide *when to ask*. **Shopify decides whether it appears.** That split is the single
most important thing to internalise, and everything in §3 follows from it.

Also worth knowing: only merchants who currently have your app installed can review it —
plus a 45-day window after uninstalling.

---

## 2. The constraints, in full

Shopify refuses the request in all of these cases and hands you a code saying which:

| Code | Meaning |
|---|---|
| `success` | Modal displayed |
| `cooldown-period` | Already displayed within the last **60 days** |
| `annual-limit-reached` | Already displayed **3×** in the last 365 days |
| `recently-installed` | Installed **less than 24h** ago |
| `already-reviewed` | Merchant already reviewed — **permanent** |
| `merchant-ineligible` | Merchant can't review this app |
| `mobile-app` | Not supported on mobile |
| `already-open` / `open-in-progress` | A modal is already opening or open |
| `cancelled` | Opening was cancelled |

**The cooldown is keyed to the modal being *displayed*, not to a review being submitted.**
A merchant who dismisses it still starts the 60-day clock and still spends one of their
three annual slots. Budget accordingly: you get **at most 3 shots per merchant per year**,
regardless of what they do with them.

---

## 3. The core design decision: store no state of your own

The instinct is to add a `lastPromptedAt` column and a "have we asked yet" flag. **Don't.**
Shopify already tracks all of it and enforces it on every call. A second copy can only drift:

- A merchant can review straight from your App Store listing without the modal ever opening.
  Shopify knows. Your database never would — so you'd keep asking someone who already
  reviewed.
- Your cooldown arithmetic and Shopify's will disagree at the edges, and Shopify's is the
  one that decides.

So: **call on every app load, let Shopify decline, log the code.** No columns, no counters,
no cron, no "cooldown expired" event to handle. The first load after the cooldown lapses
naturally becomes the next prompt.

The call is App Bridge talking to the admin frame — no request to your server, no Admin API
rate limit consumed. Calling it and being refused is genuinely cheap.

---

## 4. When to fire it

Shopify's guidance, and the reasoning behind it:

> It's better to request a review at the end of a successful workflow than when a merchant
> first opens your app, or at any point that interrupts their task. **Don't trigger a request
> with a merchant action**, as rate-limiting might prevent the modal from displaying, making
> your app appear to be broken.

That last clause is the one people miss. If you wire it to a "Publish" button, then ~9 times
out of 10 Shopify silently refuses and the merchant has just clicked something that visibly
did nothing. **Fire on load, where a refusal is invisible.**

### Choosing your gate

Pick conditions that mean *this merchant has gotten value*. Two are usually enough:

1. **Install age > 24h.** Mirrors Shopify's `recently-installed` floor. Buys nothing on its
   own — Shopify would refuse anyway — it just avoids a call whose answer you already know.
2. **One real engagement signal**, specific to your app: they published something, completed
   setup, processed an order. This is the condition doing actual work. Someone who installed
   three days ago and never used the app has nothing to say, and prompting them invites a
   one-star review.

Keep both in a **single pure predicate** so the gate is testable without a database and
tunable in one place.

### Deciding how persistently to ask

Sticky conditions (once true, always true) mean you'll ask every ~60 days, 3×/year, forever,
until they review. That's within Shopify's limits and is what the API is designed for — but
decide it deliberately rather than discovering it in month seven. If you want an end, gate on
install age being under ~12 months; it needs no new schema.

---

## 5. Implementation pattern

Four pieces, in dependency order.

### 5.1 A pure domain module

No I/O, importable from client components:

```ts
export const REVIEW_MIN_INSTALL_AGE_MS = 24 * 60 * 60 * 1000;

export function isReviewPromptEligible({ installedAt, hasEngaged, now = new Date() }) {
  if (!installedAt || !hasEngaged) return false;
  return now.getTime() - installedAt.getTime() > REVIEW_MIN_INSTALL_AGE_MS;
}
```

Inject `now` so the boundary cases are testable. Accept a nullable `installedAt` — "no row
yet" means a brand-new shop, which is inside the floor anyway, and handling it here keeps the
null check out of your loader.

### 5.2 Resolve eligibility in the shared shell loader

Whatever route wraps all your admin screens. Two notes that cost real time otherwise:

- **Use a read, not an upsert.** This runs on every admin page load. If your settings helper
  upserts (many do, to be convenient), you've just turned a read into a write on the hot path.
- **Resolve the conditions in parallel** (`Promise.all`), and pass a single boolean to the
  client.

### 5.3 A once-per-mount hook

```ts
export function useReviewPrompt(eligible: boolean): void {
  const shopify = useAppBridge();
  const asked = useRef(false);

  useEffect(() => {
    if (!eligible || asked.current) return;
    if (typeof shopify.reviews?.request !== "function") return;   // see §7
    asked.current = true;

    shopify.reviews.request().then(
      (r) => { if (!r.success) console.debug(`[reviews] not shown: ${r.code}`); },
      (e) => console.debug("[reviews] request failed", e),
    );
  }, [eligible, shopify]);
}
```

The ref guard matters more than it looks. Loaders revalidate on **every client-side
navigation**, so `eligible` arrives repeatedly with the same value. Without the guard you'd
ask on each one and could burn all three annual slots in one session.

Mount it in the **parent** route. Navigating between child routes swaps the child but leaves
the parent mounted, which gives you exactly one request per app load rather than one per
screen — the behaviour you want.

### 5.4 A manual fallback link

For everyone the API structurally cannot reach — mobile, mid-cooldown, past the annual cap.
Deep-link straight to the review form:

```
https://apps.shopify.com/<your-handle>#modal-show=WriteReviewModal
```

⚠️ The fragment is **`WriteReviewModal`**. It's an undocumented-looking magic string with no
validation — get it wrong and the link degrades silently into "here's our listing page."
Pin it in a test.

Two things that will bite:

- **`target="_blank"` is mandatory.** The admin frames your app and the App Store refuses to
  be framed, so a same-tab navigation lands the merchant on a blank panel.
- **Your handle doesn't exist until the listing is live.** Keep it as one constant, return
  `null` while it's blank, and have the UI render nothing. It switches on when you fill it in.

Put the link on a settled screen (Settings, Plans, an About section) — never mid-task.

---

## 6. Testing it

**On a development store, Shopify bypasses every rate limit and restriction.** That's the only
way to see the modal before your listing is live. Reviews submitted from dev stores are never
published.

The trap: **there are two independent 24-hour clocks.**

| Check | Whose data | Can you influence it? |
|---|---|---|
| Your install-age gate | Your database | Yes — backdate it locally |
| `recently-installed` | Shopify's records | **No** |

Backdating your own timestamp only opens *your* gate, letting the call go out. Shopify then
applies its own rule against its own record. On a dev store that rule is bypassed anyway — so
in practice **your own gate is the only thing blocking you**, and backdating clears it:

```bash
docker exec <db-container> psql -U <user> -d <db> \
  -c "UPDATE \"ShopSettings\" SET \"createdAt\" = NOW() - INTERVAL '2 days';"
```

Never run that against production. It cannot help — Shopify's clock is the binding one there —
and it corrupts a real timestamp.

### Reading the result

The console log from §5.3 is your entire diagnostic surface:

| What you see | What it means |
|---|---|
| Modal appears | Working end to end |
| `[reviews] not shown: <code>` | Your gate passed, Shopify refused — the code says why |
| **Nothing at all** | *Your* gate blocked it; you never called Shopify |

That last row is the one worth remembering: **silence means your code stopped it, any log line
means Shopify did.**

---

## 7. Gotchas

- **App Bridge is CDN-delivered and self-updating.** You can't pin the version a given merchant
  has cached, and `reviews` is a newer API. On an older bundle `shopify.reviews.request()`
  throws a `TypeError` from inside your effect — which React escalates to the error boundary,
  blanking an admin screen over a review prompt. Guard with
  `typeof shopify.reviews?.request !== "function"`.
- **`useAppBridge()` is not context-based.** It returns `window.shopify` and *throws* if that
  global is missing. Safe above your `AppProvider` in the tree (the App Bridge `<script>` is
  blocking and runs before hydration), but it will throw on any route rendered outside the
  admin — a public demo page, for instance.
- **Nothing works until your app is listed.** Unlisted apps return `merchant-ineligible` on
  real stores. Build it early, but expect silence until the listing lands.
- **Verify which app you're testing against.** If your `shopify.app.toml` carries a stale
  `client_id`, you'll be prompting a review for a different app entirely.

---

## 8. Checklist for a new app

- [ ] Pure predicate for the gate: install age + one engagement signal, both tested
- [ ] Eligibility resolved in the shared shell loader, using a **read** not an upsert
- [ ] Once-per-mount hook in the **parent** route, with the `shopify.reviews` guard
- [ ] Decline code logged to console — it's your only diagnostic
- [ ] **No** `lastPromptedAt` column anywhere
- [ ] Fallback deep link with `WriteReviewModal` + `target="_blank"`, hidden until the handle exists
- [ ] Decided consciously whether to ask forever or stop after ~12 months
- [ ] Tested on a **development** store with the install date backdated

---

## Appendix: how Linkfront does it

| Piece | File |
|---|---|
| Constants, URL builder, `isReviewPromptEligible` | `app/domain/review.ts` |
| `hasPublishedPage` (the engagement signal) | `app/.server/data/pages.ts` |
| Once-per-mount hook | `app/hooks/useReviewPrompt.ts` |
| Shell loader + hook mount | `app/routes/app.tsx` |
| Fallback link | `app/routes/app.plans.tsx` |
| Tests | `tests/unit/review.test.ts` |

The gate is: `ShopSettings.createdAt` older than 24h **AND** the shop has a *currently*
published `BioPage`. Current state rather than ever-published, deliberately — a merchant who
published and then took everything down is not someone to ask.

Install age reads `ShopSettings.createdAt`, which is written on the shop's first authenticated
admin load. Strictly that's *first app open*, not *install*. Usually identical, but a merchant
who installs and waits a week gets a later date than Shopify has. That's harmless: it only
makes the gate more conservative than Shopify's, never less.
