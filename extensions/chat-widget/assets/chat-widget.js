/* ChatConvert storefront widget shell (spec 05).
 * Initial payload = config fetch + launcher only (<30KB gz budget). The panel
 * modules (widget-renderer.js / widget-transport.js) are injected on first
 * launcher click. No framework, no CDNs, no secrets — proxy endpoints only.
 */
(function () {
  "use strict";

  /* ── Proactive campaigns: PURE evaluator (spec 12) ───────────────────────
   * Answers "may this campaign fire on this page, for this shopper?" — page
   * scope + every Conditions rule. The TIMING controls (dwell, scroll depth,
   * exit intent) are armed separately by the runtime further down, because
   * they need timers and listeners.
   *
   * ctx: { pageType, path, productId, collectionId, seen:{id:1},
   *        cart:{itemCount,totalValue}|null, cartRemoved, isCustomer,
   *        device:"desktop"|"mobile", online, today:"YYYY-MM-DD", country }
   *
   * Exposed on window.ChatConvertCampaigns so scripts/test-campaign-triggers.ts
   * can run it in a node vm with no DOM — keep it pure. */
  function ccEvalCampaign(campaign, ctx) {
    if (!campaign) return false;
    ctx = ctx || {};
    if (ctx.seen && ctx.seen[campaign.id]) return false; // once per session

    var t = campaign.trigger || {};
    var c = campaign.conditions || {};
    var scope = t.pageScope || "all_pages";
    var path = String(ctx.path || "");

    // ── page scope ──
    if (scope === "home" && ctx.pageType !== "home") return false;
    if (scope === "search" && ctx.pageType !== "search") return false;
    if (scope === "cart" && ctx.pageType !== "cart") return false;
    if (scope === "specific_pages") {
      if (!t.urlContains || path.indexOf(t.urlContains) === -1) return false;
    }
    if (scope === "all_product_pages" && ctx.pageType !== "product") return false;
    if (scope === "specific_product_pages") {
      if (ctx.pageType !== "product") return false;
      var pids = t.pageProductIds || [];
      // An empty list would mean "no page qualifies" — the save path already
      // rejects that, so treat it as "any product page" rather than silence.
      if (pids.length && pids.indexOf(ctx.productId) === -1) return false;
    }
    if (scope === "all_collection_pages" && ctx.pageType !== "collection") return false;
    if (scope === "specific_collection_pages") {
      if (ctx.pageType !== "collection") return false;
      var cids = t.pageCollectionIds || [];
      if (cids.length && cids.indexOf(ctx.collectionId) === -1) return false;
    }

    // ── conditions ──
    if (c.audience === "customers" && !ctx.isCustomer) return false;
    if (c.audience === "visitors" && ctx.isCustomer) return false;
    if (c.device === "desktop" && ctx.device !== "desktop") return false;
    if (c.device === "mobile" && ctx.device !== "mobile") return false;
    if (c.displayTime === "business_hours" && !ctx.online) return false;
    if (c.displayDuration === "custom" && ctx.today) {
      if (c.startDate && ctx.today < c.startDate) return false;
      if (c.endDate && ctx.today > c.endDate) return false;
    }
    if (c.countryMode === "selected") {
      var wanted = c.countries || [];
      if (!ctx.country || wanted.indexOf(ctx.country) === -1) return false;
    }

    // ── cart window ──
    var hasMax = t.cartMaxValue !== null && t.cartMaxValue !== undefined && t.cartMaxValue > 0;
    if ((t.cartMinItems || 0) > 0 || (t.cartMinValue || 0) > 0 || hasMax) {
      if (!ctx.cart) return false; // cart state required but unknown
      if ((t.cartMinItems || 0) > 0 && (ctx.cart.itemCount || 0) < t.cartMinItems) return false;
      if ((t.cartMinValue || 0) > 0 && (ctx.cart.totalValue || 0) < t.cartMinValue) return false;
      if (hasMax && (ctx.cart.totalValue || 0) > t.cartMaxValue) return false;
    }

    // "Remove items from cart" is an EVENT, not a page — it only fires on the
    // page view that follows an actual removal.
    if (campaign.templateType === "remove_items" && !ctx.cartRemoved) return false;

    return true;
  }
  /** Shopify request.page_type → campaign page type. */
  function ccPageType(raw) {
    if (raw === "index") return "home";
    if (raw === "list-collections") return "collection";
    return raw || "";
  }
  if (typeof window !== "undefined") {
    window.ChatConvertCampaigns = { evalCampaign: ccEvalCampaign, pageType: ccPageType };
  }

  var host = document.getElementById("chatconvert-root");
  if (!host) return;

  var base = host.getAttribute("data-proxy-base") || "/apps/ccwidget";
  var customerName = host.getAttribute("data-customer-name") || "";
  var pageType = host.getAttribute("data-page-type") || "";
  var rendererSrc = host.getAttribute("data-renderer-src");
  var transportSrc = host.getAttribute("data-transport-src");
  var cssSrc = host.getAttribute("data-css-src");
  // Proactive-chat page context (spec 12). Product/collection ids are emitted
  // as GIDs so they compare directly against the catalog mirror's stored ids;
  // country comes from the storefront's active market, not the browser locale.
  var productGid = host.getAttribute("data-product-id") || "";
  var collectionGid = host.getAttribute("data-collection-id") || "";
  var storeCountry = (host.getAttribute("data-country") || "").toUpperCase();
  var isLoggedIn = host.getAttribute("data-logged-in") === "1";

  /* CSS loads only after the config confirms the widget is active (review m4):
   * disabled/uninstalled shops pay zero style bytes. Launcher mounts on the
   * stylesheet's load event so it never flashes unstyled. */
  var cssPromise = null;
  function ensureCss() {
    if (!cssPromise) {
      cssPromise = new Promise(function (resolve) {
        if (!cssSrc) return resolve();
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssSrc;
        link.onload = resolve;
        link.onerror = resolve;
        document.head.appendChild(link);
      });
    }
    return cssPromise;
  }

  var SESSION_KEY = "cc:session";
  // Stable per-browser id, no expiry. SESSION_KEY rotates after 30 idle minutes
  // because that is the billing session rule (spec 15) — which also made the
  // agent forget the shopper. Identity gets its own key so it can outlive it.
  var VISITOR_KEY = "cc:visitor";
  var CONVO_KEY = "cc:convo";
  var PRECHAT_KEY = "cc:prechat";
  var CONFIG_KEY = "cc:config";
  var POLL_KEY = "cc:poll";
  var HUMAN_KEY = "cc:human"; // "1" = a team member took over (AI dormant)
  var BLOCKED_KEY = "cc:blocked"; // "1" = merchant blocked this visitor
  var SURVEY_KEY = "cc:survey"; // conversationId whose survey was already shown
  var OPEN_KEY = "cc:open"; // "1" = panel open — survives page navigation
  var SCREEN_KEY = "cc:screen";
  var DEFAULT_PLACEHOLDER = "Type your message…";
  // A placeholder is an instruction to the person about to type, not a status
  // line. "A team member will reply here…" read as the latter — it told the
  // shopper what the BOX was for rather than what to do with it, and the same
  // fact is already in the thread as the handover message
  // (settings/schemas.ts afterHandoverMessage).
  var HUMAN_PLACEHOLDER = "Message the team…";
  var BLOCKED_PLACEHOLDER = "This chat has been closed.";
  var CONFIG_TTL = 5 * 60 * 1000;
  var SESSION_IDLE = 30 * 60 * 1000; // billing session rule (spec 15)

  var config = null;
  var R = null; // ChatConvertRenderer
  var T = null; // ChatConvertTransport

  var ui = {}; // root/launcher/panel/body/msgs/input...
  var state = {
    open: false,
    screen: "home",
    conversationId: null,
    shopperMessages: 0,
    streaming: false,
    startersShown: false,
    prechatVisible: false,
    pendingText: null,
    surveyShown: false,
    surveyPending: false,
    pollTimer: null,
    pollSince: null,
    humanMode: false,
    blocked: false,
    resolvedSeen: false,
    restoring: false,
    // Ids already rendered this page — the cursor alone can't prevent a
    // double render when /history and a poll overlap, or when the client
    // clock drifts from the server's (QA D1/D2/D9).
    renderedIds: {},
    lastUserText: null,
  };

  // ── tiny utils ───────────────────────────────────────────────────────────
  function store(area, key, value) {
    try {
      if (value === null) area.removeItem(key);
      else area.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
  }
  function read(area, key) {
    try { return area.getItem(key); } catch (e) { return null; }
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "cc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /** A rotated/expired session is a NEW conversation: per-conversation flags
   *  must reset too, or a blocked/human thread's lock survives into it (D6). */
  function resetConversation() {
    state.conversationId = null;
    state.pollSince = null;
    state.humanMode = false;
    state.blocked = false;
    state.resolvedSeen = false;
    state.renderedIds = {};
    state.emptyPolls = 0;
    stopPolling();
    store(sessionStorage, CONVO_KEY, null);
    store(sessionStorage, POLL_KEY, null);
    store(sessionStorage, HUMAN_KEY, null);
    store(sessionStorage, BLOCKED_KEY, null);
  }

  function readSession() {
    var raw = read(localStorage, SESSION_KEY);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      return s && s.id ? s : null;
    } catch (e) { return null; }
  }

  /** sessionId with 30-min inactivity rotation; touch() extends the window.
   *
   *  PRIVACY: this id is FUNCTIONAL storage — it exists so the chat the
   *  shopper started can be continued and so a human agent can reply into the
   *  same thread. It is therefore minted and written only at the point the
   *  shopper actually uses the chat (opens the panel, sends a message, adds to
   *  cart from a card…), never on a passive page view. Boot uses peekSession()
   *  instead, which reads and can expire but never creates. */
  function sessionId(touch) {
    var now = Date.now();
    var s = readSession();
    if (!s || now - (s.at || 0) > SESSION_IDLE) {
      s = { id: uuid(), at: now };
      resetConversation();
    }
    if (touch) s.at = now;
    store(localStorage, SESSION_KEY, JSON.stringify(s));
    return s.id;
  }

  /** The browser's long-lived visitor id, minted on first use. Never rotated:
   *  it is what lets the agent recognise a shopper who comes back tomorrow.
   *  Undefined when localStorage is unavailable (private mode, blocked
   *  storage) — the server falls back to sessionId exactly as before. */
  function visitorId() {
    var stored = read(localStorage, VISITOR_KEY);
    if (stored) return stored;
    var minted = uuid();
    store(localStorage, VISITOR_KEY, minted);
    // A write that silently failed must not be sent as if it had stuck, or
    // every page view would claim a different identity.
    return read(localStorage, VISITOR_KEY) || undefined;
  }

  /** Read-only form used at boot: expires a stale record (a delete, not a
   *  write) and returns null rather than minting an id for a page view. */
  function peekSession() {
    var s = readSession();
    if (!s) return null;
    if (Date.now() - (s.at || 0) > SESSION_IDLE) {
      store(localStorage, SESSION_KEY, null);
      resetConversation();
      return null;
    }
    return s.id;
  }

  // ── tracking consent (Shopify Customer Privacy API) ──────────────────────
  /* The chat's own storage is functional and ungated (above). The `/event`
   * beacons are analytics telemetry, so they are gated on the shopper's
   * analytics consent whenever the storefront exposes the API. The API is not
   * present on every storefront; per Shopify's own guidance an absent API
   * means tracking may proceed. Consent never gates the chat itself. */
  var privacy = { api: null, started: false, settled: false };
  /** Resolve the API once, at boot, so the answer is ready before the first
   *  beacon. `settled` distinguishes "no API on this storefront" (→ allowed)
   *  from "still loading" (→ hold), so no event slips out ahead of consent. */
  function initPrivacy() {
    if (privacy.started) return;
    privacy.started = true;
    var S = window.Shopify; // absent on non-Shopify pages / theme previews
    // Consent can be collected later in the visit — re-read the API then.
    document.addEventListener("visitorConsentCollected", function () {
      privacy.api = (window.Shopify && window.Shopify.customerPrivacy) || privacy.api;
      privacy.settled = true;
    });
    if (S && S.customerPrivacy) {
      privacy.api = S.customerPrivacy;
      privacy.settled = true;
      return;
    }
    if (!S || typeof S.loadFeatures !== "function") {
      privacy.settled = true; // API unavailable here — nothing to consult
      return;
    }
    try {
      S.loadFeatures([{ name: "consent-tracking-api", version: "0.1" }], function (err) {
        if (!err && window.Shopify) privacy.api = window.Shopify.customerPrivacy || null;
        privacy.settled = true;
      });
    } catch (e) { privacy.settled = true; }
  }
  function analyticsAllowed() {
    initPrivacy();
    if (!privacy.settled) return false; // still resolving — don't pre-empt consent
    var api = privacy.api;
    if (!api || typeof api.analyticsProcessingAllowed !== "function") return true;
    try { return api.analyticsProcessingAllowed() !== false; } catch (e) { return true; }
  }

  // ── config fetch (sessionStorage cache, ≤5 min) ──────────────────────────
  /** How long this payload's online/offline line stays true. The server sends
   *  `availability.ttl` (seconds to the next schedule boundary, capped at 5
   *  min) so the widget stops claiming "We're online" after closing time. */
  function configTtl(data) {
    var a = data && data.availability;
    var ttl = a && typeof a.ttl === "number" ? a.ttl * 1000 : CONFIG_TTL;
    return Math.max(15000, Math.min(CONFIG_TTL, ttl));
  }
  function cachedConfigAt() {
    try {
      var hit = JSON.parse(read(sessionStorage, CONFIG_KEY));
      return hit && hit.at ? hit.at : 0;
    } catch (e) { return 0; }
  }
  function fetchConfig() {
    // Minute bucket: the route answers with `Cache-Control: max-age=300`, so
    // without this the browser/CDN copy could pin a status line up to five
    // minutes past a boundary — on top of the sessionStorage cache. Bucketing
    // (rather than a random token) keeps page-to-page navigation inside the
    // same minute on the cached response.
    var url = base + "/widget-config?t=" + Math.floor(Date.now() / 60000);
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) return null; // 404 = uninstalled/disabled → render nothing
        return res.json().then(function (data) {
          store(sessionStorage, CONFIG_KEY, JSON.stringify({ at: Date.now(), data: data }));
          return data;
        });
      })
      .catch(function () { return null; }); // network error → silent
  }
  function getConfig() {
    var raw = read(sessionStorage, CONFIG_KEY);
    if (raw) {
      try {
        var hit = JSON.parse(raw);
        if (hit && Date.now() - hit.at < configTtl(hit.data)) return Promise.resolve(hit.data);
      } catch (e) { /* refetch */ }
    }
    return fetchConfig();
  }

  /** A tab left open across a boundary still holds the boot payload: re-pull
   *  the status line when the shopper opens the panel. Only the availability
   *  slice is swapped in — re-theming a live panel mid-session would flicker. */
  function refreshAvailability() {
    if (Date.now() - cachedConfigAt() < configTtl(config)) return;
    fetchConfig().then(function (data) {
      if (!data || !data.availability || !config) return;
      config.availability = data.availability;
      if (state.open && state.screen === "home") showScreen("home");
    });
  }

  // ── lazy module loading ──────────────────────────────────────────────────
  var modulesPromise = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement("script");
      tag.src = src;
      tag.defer = true;
      tag.onload = resolve;
      tag.onerror = reject;
      document.head.appendChild(tag);
    });
  }
  function ensureModules() {
    if (!modulesPromise) {
      modulesPromise = Promise.all([
        window.ChatConvertRenderer || !rendererSrc ? Promise.resolve(null) : loadScript(rendererSrc),
        window.ChatConvertTransport || !transportSrc ? Promise.resolve(null) : loadScript(transportSrc),
      ]).then(function () {
        R = window.ChatConvertRenderer;
        T = window.ChatConvertTransport;
        if (!R || !T) throw new Error("modules missing");
        // Bot identity (store branding → Settings → General store logo/name;
        // else default chat icon, no caption).
        if (R.setAvatar) R.setAvatar(config && config.avatar);
      });
    }
    return modulesPromise;
  }

  // ── boot: launcher only ──────────────────────────────────────────────────
  getConfig().then(function (data) {
    if (!data || data.active === false || !data.widget) return;
    config = data;
    initPrivacy(); // resolve consent state before any beacon can fire
    // Deep links go in right after the launcher — the only thing they need —
    // rather than at the end of the chain, where a campaign failure would
    // silently take them down with it.
    ensureCss()
      .then(mountLauncher)
      .then(mountDebug) // no-op unless the URL carries ccdebug=1
      .then(initDeepLinks)
      .then(initCampaigns)
      .then(maybeRestoreOpen);
  });

  /** Reopen the panel after a page navigation when it was open on the last
   *  page (open/closed state + screen live in sessionStorage per tab). */
  function maybeRestoreOpen() {
    if (state.open || read(sessionStorage, OPEN_KEY) !== "1") return;
    var screen = read(sessionStorage, SCREEN_KEY);
    if (screen === "chat" || screen === "tracking") state.screen = screen;
    ensureModules()
      .then(openPanel)
      .catch(function () { /* modules failed — stay closed, no errors */ });
  }

  function themeVars(appearance) {
    if (appearance && appearance.colorMode === "solid") return { c1: appearance.solid, c2: appearance.solid };
    var g = (appearance && appearance.gradient) || {};
    return { c1: g.start || "#6d3bf5", c2: g.end || "#3b82f6" };
  }

  var LAUNCH_ICONS = {
    chat: '<svg width="24" height="24" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 5h12v8H8l-3 3V5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    help: '<svg width="24" height="24" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 8a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6 1V11.5M10 14h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  };

  function mountLauncher() {
    var appearance = config.widget.appearance;
    var lc = appearance.launcher;
    var root = document.createElement("div");
    root.className = "cw-root cw-pos-" + (lc.position || "bottom_right");
    var v = themeVars(appearance);
    root.style.setProperty("--cw1", v.c1);
    root.style.setProperty("--cw2", v.c2);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cw-launcher" + (lc.style !== "icon" ? " cw-launcher--pill" : "");
    if (lc.bgColor) btn.style.background = lc.bgColor; // custom launcher bg (else brand CSS vars)
    btn.setAttribute("aria-label", lc.label || "Open chat");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    if (lc.style === "icon" || lc.style === "icon_label") {
      if (lc.icon === "custom" && lc.customIconUrl) {
        var img = document.createElement("img");
        img.src = lc.customIconUrl;
        img.alt = "";
        btn.appendChild(img);
      } else {
        var ic = document.createElement("span");
        ic.setAttribute("aria-hidden", "true");
        ic.innerHTML = LAUNCH_ICONS[lc.icon === "help" ? "help" : "chat"];
        btn.appendChild(ic);
      }
    }
    if (lc.style === "label" || lc.style === "icon_label") {
      var span = document.createElement("span");
      span.textContent = lc.label || "Chat with us";
      if (lc.labelColor) span.style.color = lc.labelColor; // parity with widget-renderer launcher()
      btn.appendChild(span);
    }
    btn.addEventListener("click", togglePanel);
    root.appendChild(btn);
    document.body.appendChild(root);
    ui.root = root;
    ui.launcher = btn;
  }

  // ── mobile viewport: the soft keyboard ───────────────────────────────────
  /* The keyboard shrinks the VISUAL viewport; by default the LAYOUT viewport
   * keeps its full height. `position: fixed` is laid out against the layout
   * viewport, so a full-height panel keeps its full size, the composer sits
   * behind the keys, and the browser scrolls the storefront trying to reveal
   * the focused field.
   *
   * `interactive-widget=resizes-content` tells the browser to shrink the
   * LAYOUT viewport instead. `inset: 0` then means "the area above the
   * keyboard" and there is nothing left to compute — earlier versions of this
   * file tried to derive the keyboard height from window.innerHeight and
   * visualViewport, and were wrong three times running.
   *
   * Chrome 108+ and Firefox 132+ honour it — Android needs no JavaScript here
   * at all, and is confirmed working on device. Safari does not honour it, and
   * that is the only reason applyViewport() below exists. */
  var scrollUnlock = null;
  var viewportMetaRestore = null;
  var vvLoop = null;

  /** `innerWidth` as well as the media query: they agree in every normal case,
   *  but if a theme's viewport meta makes them disagree, the CSS full-bleed
   *  layout is what matters and matchMedia is what decides it — so a mismatch
   *  must not leave the panel full-bleed with nothing sizing it. */
  function isPhone() {
    return Boolean(
      (window.matchMedia && window.matchMedia("(max-width: 480px)").matches) ||
        window.innerWidth <= 480,
    );
  }

  /** Set while the panel is open on a phone, restored on close. Skipped when
   *  the theme already chose a value — that is the merchant's call, not ours. */
  function lockInteractiveWidget() {
    if (viewportMetaRestore || !isPhone()) return;
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    var original = meta.getAttribute("content") || "";
    if (original.indexOf("interactive-widget") !== -1) return;
    var head = original.replace(/[, ]+$/, "");
    meta.setAttribute("content", (head ? head + "," : "") + "interactive-widget=resizes-content");
    viewportMetaRestore = function () {
      meta.setAttribute("content", original);
      viewportMetaRestore = null;
    };
  }

  /* THE SPLIT, and why this is a frame loop rather than event handlers.
   *
   * Android works with no JavaScript at all: Chrome honours
   * `interactive-widget=resizes-content` (set above), which shrinks the LAYOUT
   * viewport for the keyboard, so `inset: 0` already means "the area above the
   * keys" and the CSS alone is correct.
   *
   * iOS honours none of it. Safari leaves the layout viewport at full height
   * and shrinks the VISUAL viewport instead, so a `position: fixed` panel keeps
   * its full height and the composer ends up behind the keys. The panel's
   * geometry therefore has to be written by hand — and the only source for it
   * is `window.visualViewport`.
   *
   * Two attempts drove that from `visualViewport`'s own resize/scroll events
   * and BOTH failed on real hardware, in the same way: the panel stayed the
   * wrong size until the shopper typed, because typing makes Safari scroll the
   * caret into view and that finally produced an event carrying settled
   * numbers. Which event to trust, and when, turned out to be unanswerable —
   * every guess was wrong on the device even when it was right on paper.
   *
   * So stop subscribing and start reading. While the panel is open on a phone,
   * measure the viewport every animation frame and write only when it changed.
   * There is no event to miss, no settle timer to mistune, and no ordering to
   * get wrong. It costs one property read per frame while a full-screen modal
   * is up — nothing is animating behind it — and the write is skipped on the
   * overwhelming majority of frames because the geometry is unchanged. */
  var appliedGeometry = "";

  function applyViewport() {
    var p = ui.panel;
    if (!p) return;
    var s = p.style;
    var vv = window.visualViewport;

    if (!vv || !state.open || !isPhone()) {
      if (appliedGeometry === "") return; // already clear — do not touch layout
      appliedGeometry = "";
      s.top = s.left = s.right = s.bottom = s.width = s.height = s.transform = "";
      return;
    }

    var w = Math.round(vv.width);
    var h = Math.round(vv.height);
    var x = Math.round(vv.offsetLeft);
    var y = Math.round(vv.offsetTop);
    var geometry = w + "x" + h + "@" + x + "," + y;
    if (geometry === appliedGeometry) return;
    var grew = appliedGeometry !== "" && h > parseInt(appliedGeometry.split("x")[1], 10);
    appliedGeometry = geometry;

    // `inset: 0` leaves top AND bottom set; adding a height over-constrains the
    // box and the browser silently drops one of the three. State the origin and
    // the size, and let the other two edges go.
    s.top = "0px";
    s.left = "0px";
    s.right = "auto";
    s.bottom = "auto";
    s.width = w + "px";
    s.height = h + "px";
    // The offset is applied as a TRANSFORM, not as `top`. Moving the layout box
    // makes Safari re-run its own "scroll the focused field into view" against
    // the new position, which moves the visual viewport again, which moves the
    // panel again — a loop that settles somewhere wrong. A transform moves only
    // what is painted, so Safari's measurement stays put and the loop cannot
    // start. Usually a no-op: with the body pinned, the offset is 0.
    s.transform = x || y ? "translate3d(" + x + "px," + y + "px,0)" : "";

    // The thread just changed height. Keep the newest message against the
    // composer — but only when the panel SHRANK (the keyboard opening). On the
    // way back out there is new room below, and yanking the scroll then would
    // fight a shopper who had deliberately scrolled up to read.
    if (!grew && state.screen === "chat") scroll();
  }

  function startViewportLoop() {
    if (vvLoop !== null) return;
    var step = function () {
      applyViewport();
      vvLoop = requestAnimationFrame(step);
    };
    vvLoop = requestAnimationFrame(step);
  }

  function stopViewportLoop() {
    if (vvLoop === null) return;
    cancelAnimationFrame(vvLoop);
    vvLoop = null;
  }

  // ── on-device diagnostic (?ccdebug=1) ────────────────────────────────────
  /* Never rendered for a shopper: it mounts only when the URL carries
   * `ccdebug=1`. It exists because the iOS keyboard geometry cannot be
   * reproduced on any emulator or desktop browser, so the only way to see what
   * Safari actually reports — rather than what the spec says it should — is to
   * read it off the phone. `heights` is the important line: it records every
   * DISTINCT visualViewport height with the millisecond it arrived, which
   * answers the one question guesswork cannot, namely whether the settled
   * height is ever reported at all, and if so how late. */
  var dbg = { resize: 0, scroll: 0, frames: 0, heights: [], t0: Date.now() };
  var dbgEl = null;

  function debugEnabled() {
    try {
      return /[?&]ccdebug=1/.test(window.location.search);
    } catch (e) {
      return false;
    }
  }

  function mountDebug() {
    if (dbgEl || !debugEnabled()) return;
    dbgEl = document.createElement("pre");
    // Appended AFTER .cw-root, so an equal z-index still paints it on top; the
    // panel is what we are measuring, so it must not cover the readout.
    dbgEl.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;margin:0;padding:5px 7px;" +
      "font:10.5px/1.32 ui-monospace,Menlo,Consolas,monospace;white-space:pre;" +
      "background:rgba(0,0,0,.85);color:#8ef5a8;pointer-events:none;";
    document.body.appendChild(dbgEl);
    debugTick();
  }

  function debugTick() {
    if (!dbgEl) return;
    dbg.frames++;
    var vv = window.visualViewport;
    var p = ui.panel;
    var cs = p ? getComputedStyle(p) : null;
    var meta = document.querySelector('meta[name="viewport"]');
    var px = function (v) { return Math.round(parseFloat(v) || 0); };

    if (vv) {
      var h = Math.round(vv.height);
      var lastSeen = dbg.heights.length ? dbg.heights[dbg.heights.length - 1].h : -1;
      if (h !== lastSeen) {
        dbg.heights.push({ h: h, t: Date.now() - dbg.t0 });
        if (dbg.heights.length > 6) dbg.heights.shift();
      }
    }

    dbgEl.textContent = [
      vv
        ? "vv    " + Math.round(vv.width) + "x" + Math.round(vv.height) +
          "  off " + Math.round(vv.offsetLeft) + "," + Math.round(vv.offsetTop) +
          "  pageTop " + Math.round(vv.pageTop) +
          "  scale " + Math.round(vv.scale * 100) / 100
        : "vv    ABSENT",
      "win   " + window.innerWidth + "x" + window.innerHeight +
        "  scrollY " + Math.round(window.pageYOffset || 0),
      "inline t=" + ((p && p.style.top) || "-") + " h=" + ((p && p.style.height) || "-") +
        " w=" + ((p && p.style.width) || "-"),
      "real   t=" + (cs ? px(cs.top) : "-") + " h=" + (cs ? px(cs.height) : "-") +
        " padB=" + (cs ? px(cs.paddingBottom) : "-"),
      "flags  phone=" + (isPhone() ? 1 : 0) + " open=" + (state.open ? 1 : 0) +
        " kbd=" + (p && p.classList.contains("cw-kbd") ? 1 : 0) +
        " body=" + (document.body.style.position || "static") +
        " loop=" + (vvLoop === null ? 0 : 1) + " applied=" + (appliedGeometry || "-"),
      "meta   " + (meta ? (meta.getAttribute("content") || "").slice(-38) : "NONE"),
      "ev     resize " + dbg.resize + "  scroll " + dbg.scroll + "  frames " + dbg.frames,
      "heights " + dbg.heights.map(function (e) { return e.h + "@" + e.t; }).join(" "),
    ].join("\n");
    requestAnimationFrame(debugTick);
  }

  /** Counters for the diagnostic only — the panel no longer depends on these
   *  events for anything, which is the entire point of the frame loop. */
  function bindViewport() {
    var vv = window.visualViewport;
    if (!vv || !dbgEl) return;
    vv.addEventListener("resize", function () { dbg.resize++; });
    vv.addEventListener("scroll", function () { dbg.scroll++; });
  }

  /** Stop the storefront scrolling behind a full-screen panel.
   *
   *  `overflow: hidden` on the body — all this used to do — is not a scroll
   *  lock on iOS. Safari scrolls the document anyway to bring the focused
   *  composer into view, and THAT scroll is what dragged the panel around.
   *  Pinning the body is the lock that actually holds. It was avoided before
   *  because it discards the merchant's scroll position; stashing the offset
   *  in `top` and restoring it on close is what buys that back. */
  function lockBodyScroll() {
    if (scrollUnlock || !isPhone()) return;
    var body = document.body;
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var prev = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
    };
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = -y + "px";
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    scrollUnlock = function () {
      body.style.overflow = prev.overflow;
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      // Pinning the body parked the document at 0 — put the shopper back where
      // they were, or closing the chat teleports them to the top of the page.
      window.scrollTo(0, y);
      scrollUnlock = null;
    };
  }

  // ── panel lifecycle ──────────────────────────────────────────────────────
  function togglePanel() {
    if (state.open) return closePanel();
    ensureModules()
      .then(openPanel)
      .catch(function () { /* modules failed to load — stay closed, no errors */ });
  }

  function beacon(type, payload, cart) {
    // Analytics telemetry only — the shopper's own chat never depends on it
    // (the cart also rides each message's pageContext), so dropping it when
    // analytics consent is withheld costs the conversation nothing.
    if (!analyticsAllowed()) return;
    try {
      var body = { type: type, payload: payload || {} };
      if (cart) {
        // Cart snapshot + identity so the server can pin the live cart to
        // this conversation for the inbox details card.
        body.cart = cart;
        body.sessionId = sessionId(false);
        body.conversationId = state.conversationId || undefined;
      }
      fetch(base + "/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(function () { /* analytics never breaks UX */ });
    } catch (e) { /* ignore */ }
  }

  function openPanel() {
    removeCampaignBubble();
    if (!ui.panel) buildPanel();
    ui.panel.style.display = "flex";
    ui.launcher.style.display = "none";
    ui.launcher.setAttribute("aria-expanded", "true");
    beacon("widget_opened", { pageType: pageType });
    refreshAvailability(); // status line may have crossed a schedule boundary
    refreshCartSnapshot(); // first message's pageContext carries the cart
    state.open = true;
    store(sessionStorage, OPEN_KEY, "1");
    lockInteractiveWidget(); // before the first measurement — it resizes it
    bindViewport(); // diagnostic counters only
    lockBodyScroll();
    applyViewport(); // first frame now, rather than waiting for the loop
    startViewportLoop();
    var focusChat = config.widget.chatFocusMode && config.widget.liveChat;
    showScreen(focusChat ? "chat" : state.screen === "chat" ? "chat" : "home");
    if (state.pollTimer === null && state.conversationId) startPolling();
    // The first `input, button` in the panel is the header Back button, which
    // is display:none on the home screen — focusing it is a no-op and focus
    // falls to <body>, so Escape (bound to the panel) and the focus trap never
    // fire. Focus the composer when it is on screen, else the first VISIBLE
    // focusable, else the panel itself (tabindex="-1").
    var focusable = ui.inputEl && ui.inputEl.offsetParent !== null ? ui.inputEl : visibleFocusables()[0];
    (focusable || ui.panel).focus();
  }

  function closePanel() {
    stopViewportLoop();
    if (scrollUnlock) scrollUnlock();
    if (viewportMetaRestore) viewportMetaRestore();
    if (ui.panel) {
      // Every property applyViewport can write has to come back off, not just
      // the height — a stale inline `top`/`width`/`transform` would survive
      // into the next open (and onto the desktop layout after a rotate).
      var ps = ui.panel.style;
      ps.top = ps.left = ps.right = ps.bottom = ps.width = ps.height = ps.transform = "";
      appliedGeometry = "";
      ui.panel.classList.remove("cw-kbd");
      ps.display = "none";
    }
    ui.launcher.style.display = "";
    ui.launcher.setAttribute("aria-expanded", "false");
    state.open = false;
    store(sessionStorage, OPEN_KEY, "0");
    stopPolling();
    ui.launcher.focus();
  }

  function buildPanel() {
    // tabindex="-1": programmatic focus target of last resort, so an open
    // dialog always holds focus (Escape + the Tab trap are bound here).
    var panel = R.el("div", "cw-panel", { role: "dialog", "aria-modal": "true", tabindex: "-1", "aria-label": config.widget.header.name || "ChatConvert chat" });
    panel.style.display = "none";

    var head = R.header(config, { showBack: false }, { onBack: onBack, onClose: closePanel });
    panel.appendChild(head.el);
    ui.back = head.backEl;

    var body = R.el("div", "cw-body");
    panel.appendChild(body);
    ui.body = body;

    // Chat screen pieces are persistent so history survives screen switches.
    ui.chatWrap = R.el("div");
    ui.chatWrap.style.display = "flex";
    ui.chatWrap.style.flexDirection = "column";
    ui.chatWrap.style.gap = "12px";
    ui.chatWrap.style.flex = "1"; // fill the body so starter chips can pin to the bottom
    ui.msgs = R.el("div", "cw-msgs", { "aria-live": "polite" });
    ui.chatWrap.appendChild(ui.msgs);

    var bar = R.inputBar({ onSend: trySend });
    ui.inputBar = bar.el;
    ui.inputEl = bar.inputEl;
    ui.sendEl = bar.sendEl;
    ui.inputBar.style.display = "none";
    panel.appendChild(ui.inputBar);

    panel.appendChild(R.footer(config.showBranding));

    // The home-indicator inset is dead space once the keyboard covers it — it
    // lifts the composer off the top of the keys by ~34px, which reads as the
    // panel sitting in the wrong place. Drop it while a field holds focus.
    // `relatedTarget` keeps the padding from flashing back when focus moves
    // between two fields (composer → pre-chat), where focusout precedes focusin.
    // Only the safe-area class is driven from focus now. The panel's geometry
    // is not: the frame loop is already watching, so there is no moment to
    // catch and nothing here that can be mistimed.
    panel.addEventListener("focusin", function (e) {
      if (isTextField(e.target)) panel.classList.add("cw-kbd");
    });
    panel.addEventListener("focusout", function (e) {
      if (!isTextField(e.relatedTarget)) panel.classList.remove("cw-kbd");
    });

    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePanel();
      } else if (e.key === "Tab") {
        trapFocus(e);
      }
    });

    ui.root.insertBefore(panel, ui.launcher);
    ui.panel = panel;
  }

  /** A field that summons the soft keyboard. Buttons and checkboxes take focus
   *  without one, so they must not claim the keyboard-open state. */
  function isTextField(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    return !/^(button|submit|reset|checkbox|radio|file|range|color|image)$/i.test(node.type || "text");
  }

  /** Focusable descendants of the panel that are actually rendered. */
  function visibleFocusables() {
    var focusables = ui.panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    var visible = [];
    for (var i = 0; i < focusables.length; i++) {
      if (focusables[i].offsetParent !== null) visible.push(focusables[i]);
    }
    return visible;
  }

  function trapFocus(e) {
    var visible = visibleFocusables();
    if (visible.length === 0) return;
    var first = visible[0];
    var last = visible[visible.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ── screens ──────────────────────────────────────────────────────────────
  function showScreen(name, payload) {
    state.screen = name;
    // FAQ answers carry a payload that can't persist — restore lands on home.
    store(sessionStorage, SCREEN_KEY, name === "faq" ? "home" : name);
    var w = config.widget;
    var chatFocus = w.chatFocusMode && w.liveChat;
    ui.back.style.display = name === "home" || (name === "chat" && chatFocus) ? "none" : "";
    ui.inputBar.style.display = name === "chat" ? "flex" : "none";
    ui.body.textContent = "";

    if (name === "home") {
      ui.body.appendChild(
        R.homeScreen(config, {}, {
          onOpenChat: function () { showScreen("chat"); },
          onOpenTracking: function () { showScreen("tracking"); },
          onOpenFaq: function (faq) { showScreen("faq", faq); },
          // Server-side FAQ search across ALL published FAQs (spec 05 delta
          // closed) — resolves null on any failure so the renderer falls back
          // to filtering the featured set client-side.
          onFaqSearch: function (q) {
            return fetch(base + "/faq-search?q=" + encodeURIComponent(q), {
              headers: { Accept: "application/json" },
            })
              .then(function (res) { return res.ok ? res.json() : null; })
              .then(function (data) { return data && data.faqs ? data.faqs : null; })
              .catch(function () { return null; });
          },
        }),
      );
    } else if (name === "chat") {
      prepareChat();
      ui.body.appendChild(ui.chatWrap);
      ui.body.scrollTop = ui.body.scrollHeight;
      if (!isInputLocked()) ui.inputEl.focus();
    } else if (name === "tracking") {
      ui.body.appendChild(R.trackingScreen(config, {}, { onTrack: onTrack }));
    } else if (name === "faq" && payload) {
      ui.body.appendChild(R.faqAnswer(payload));
    }
  }

  function onBack() {
    showScreen("home");
  }

  // ── deep links ───────────────────────────────────────────────────────────
  /** Links that open the panel on a screen instead of navigating:
   *    #cc-track  → order tracking      #cc-chat → chat      #cc-open → home
   *  They work from merchant-authored HTML INSIDE the panel (FAQ answers,
   *  campaign messages — sanitize.server.ts allow-lists the `#cc-` href) and
   *  from anywhere on the storefront: a theme menu item pointing at
   *  `/#cc-track` lands on the home page with tracking already open. */
  var DEEP_LINKS = {
    "cc-track": "tracking",
    "cc-tracking": "tracking",
    "cc-chat": "chat",
    "cc-open": "home",
  };

  function deepLinkScreen(hash) {
    var key = String(hash || "").replace(/^#/, "").toLowerCase();
    return Object.prototype.hasOwnProperty.call(DEEP_LINKS, key) ? DEEP_LINKS[key] : null;
  }

  /** Tracking and live chat are merchant toggles — a link left in an FAQ after
   *  one is turned off must not open a screen the store no longer offers. */
  function availableScreen(screen) {
    var w = (config && config.widget) || {};
    if (screen === "tracking" && !w.orderTracking) return "home";
    if (screen === "chat" && !w.liveChat) return "home";
    return screen;
  }

  function openPanelOn(screen) {
    var target = availableScreen(screen);
    removeCampaignBubble();
    ensureModules()
      .then(function () {
        if (!state.open) {
          state.screen = target;
          openPanel();
        }
        showScreen(target);
      })
      .catch(function () { /* modules failed — nothing to open */ });
  }

  function initDeepLinks() {
    // Delegated, so it also catches links rendered later (FAQ answers, campaign
    // bodies) without every renderer having to wire them up.
    document.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var href = a.getAttribute("href") || "";
      var bare = href.charAt(0) === "#"; // fragment-only: always this page
      var screen = deepLinkScreen(bare ? href : a.hash);
      if (!screen) return;
      // A `/#cc-track` link pointing at another page (or another site) must
      // still navigate; only swallow the click when it targets this page.
      if (!bare && (a.host !== location.host || a.pathname !== location.pathname)) return;
      e.preventDefault();
      openPanelOn(screen);
    });

    // Landing with the hash already set (cross-page link, shared URL), then
    // clearing it so the same link works again later in the session.
    var onHash = function () {
      var screen = deepLinkScreen(location.hash);
      if (!screen) return;
      history.replaceState(null, "", location.pathname + location.search);
      openPanelOn(screen);
    };
    window.addEventListener("hashchange", onHash);
    onHash();
  }

  // ── chat flow ────────────────────────────────────────────────────────────
  function prepareChat() {
    if (!state.startersShown) {
      state.startersShown = true;
      // A conversation from earlier in this session (page navigation) restores
      // its history from the server instead of showing the intro again.
      if (state.conversationId) restoreHistory();
      else renderIntro();
    }
    if (state.blocked) ui.inputEl.placeholder = BLOCKED_PLACEHOLDER;
    else if (isHumanMode()) ui.inputEl.placeholder = HUMAN_PLACEHOLDER;
    lockInput(isInputLocked());
  }

  /** Welcome bubble + starter chips + guest prechat (first-time chat view). */
  function renderIntro() {
    // Welcome bubble (offline variant when configured + currently offline).
    var w = config.widget;
    var offline = config.availability && config.availability.status !== "online";
    var template =
      offline && w.offlineMessageEnabled && w.offlineMessage
        ? w.offlineMessage
        : config.welcomeMessage;
    appendEl(R.messageBubble("bot", R.welcomeText(template, customerName)).el);

    if (w.starters.enabled && w.starters.items.length > 0) {
      ui.starters = R.starterChips(w.starters.items, { onStarter: onStarter });
      ui.chatWrap.appendChild(ui.starters);
    }
    // Guest mode: form is required before chat (design: "Require information
    // before chat"). Lock input until submitted.
    if (w.prechat.mode === "guest" && !prechatDone()) {
      showPrechat(false);
    } else if (w.prechat.mode === "both" && !prechatDone() && w.prechat.showAfterMessages === 0) {
      // "Show form after 0 messages" = up front, before the first message —
      // the post-message check in the stream-done handler can only ever fire
      // after message #1, so 0 would otherwise behave like 1.
      showPrechat(true);
    }
  }

  /** Rebuild the thread from the server (spec 05 delta: history survives
   *  storefront navigation). Falls back to the intro on any failure. */
  function restoreHistory() {
    state.restoring = true;
    var loading = R.messageBubble("sys", "Loading conversation…");
    appendEl(loading.el);
    var done = function () {
      if (loading.el.parentNode) loading.el.parentNode.removeChild(loading.el);
    };
    T.getJson(
      base +
        "/history?conversationId=" +
        encodeURIComponent(state.conversationId) +
        "&sessionId=" +
        encodeURIComponent(sessionId(false)),
    )
      .then(function (data) {
        done();
        state.restoring = false;
        var msgs = (data && data.messages) || [];
        if (msgs.length === 0) return renderIntro();
        msgs.forEach(function (m) {
          if (m.id) state.renderedIds[m.id] = 1;
          if (m.role === "in") {
            appendEl(R.messageBubble("user", m.content).el);
            state.shopperMessages++;
          } else {
            appendEl(
              R.messageBubble(
                m.role === "sys" || m.author === "system" ? "sys" : "bot",
                m.content,
                m.author === "agent" ? "Team" : null,
              ).el,
            );
            if (m.productCards && m.productCards.length) {
              appendEl(R.productCards(m.productCards, config.currency, { onAdd: onCardAdd }));
            }
          }
        });
        // The cursor must jump to the newest message we just rendered, or the
        // first poll re-delivers the whole restored thread (QA D1).
        var newest = msgs[msgs.length - 1].createdAt;
        if (newest && (!state.pollSince || new Date(newest) > new Date(state.pollSince))) {
          state.pollSince = newest;
          store(sessionStorage, POLL_KEY, state.pollSince);
        }
        if (data.blocked) setBlocked();
        else if (data.mode === "human" && data.status !== "resolved") setHumanMode(true);
        if (state.open) startPolling();
        scroll();
      })
      .catch(function () {
        state.restoring = false;
        // Conversation gone/unreachable — start fresh like a new visitor.
        done();
        renderIntro();
      });
  }

  function isInputLocked() {
    return (
      state.streaming ||
      state.blocked ||
      (config.widget.prechat.mode === "guest" && !prechatDone() && state.prechatVisible)
    );
  }
  function lockInput(locked) {
    ui.inputEl.disabled = locked;
    ui.sendEl.disabled = locked;
  }

  function hideStarters() {
    if (ui.starters && ui.starters.parentNode) ui.starters.parentNode.removeChild(ui.starters);
  }

  function appendEl(node) {
    ui.msgs.appendChild(node);
    ui.body.scrollTop = ui.body.scrollHeight;
  }

  function onStarter(starter) {
    hideStarters();
    appendEl(R.messageBubble("user", starter.question).el);
    if (starter.answerHtml) {
      // Canned answer — zero pipeline call.
      appendEl(R.htmlBubble(starter.answerHtml).el);
    } else {
      sendMessage(starter.question, true);
    }
  }

  function trySend(text) {
    var prechat = config.widget.prechat;
    if (prechat.mode === "guest" && !prechatDone()) {
      state.pendingText = text;
      if (!state.prechatVisible) showPrechat(false);
      return;
    }
    hideStarters();
    appendEl(R.messageBubble("user", text).el);
    sendMessage(text, true);
  }

  function sendMessage(text, echoDone) {
    if (state.streaming) return;
    state.streaming = true;
    lockInput(true);
    state.lastUserText = text;
    state.shopperMessages += 1;
    checkSurveyTrigger(text);

    var typing = R.typingIndicator();
    appendEl(typing);

    var botBubble = null;
    // Tokens stream in as plain text (formatting cannot be parsed half a word
    // at a time); the accumulated reply is re-rendered once at the end so
    // **bold** and links come out as bold and links instead of raw markdown.
    var botText = "";
    function bot() {
      if (!botBubble) {
        if (typing.parentNode) typing.parentNode.removeChild(typing);
        botBubble = R.messageBubble("bot", "");
        appendEl(botBubble.el);
      }
      return botBubble.bubbleEl;
    }
    function renderBotText() {
      if (botBubble && botText) R.setRichText(botBubble.bubbleEl, botText);
    }

    T.streamChat(
      base,
      {
        sessionId: sessionId(true),
        visitorId: visitorId(),
        conversationId: state.conversationId || undefined,
        message: text,
        pageContext: {
          pageType: pageType,
          url: window.location.pathname,
          cart: cartSnapshot || undefined,
        },
      },
      {
        onToken: function (t) {
          botText += t;
          bot().appendChild(document.createTextNode(t));
          scroll();
        },
        onMessage: function (m) { botText = m; R.setRichText(bot(), m); scroll(); },
        onCards: function (cards) {
          appendEl(R.productCards(cards, config.currency, { onAdd: onCardAdd }));
        },
        onActions: function (actions) {
          appendEl(R.actionChips(actions, { onAction: onChatAction }));
        },
        onHandover: handleHandover,
        onDone: function (frame) { renderBotText(); finishTurn(typing, frame, echoDone); },
        onError: function () { failTurn(typing, botBubble); },
      },
    );
  }

  function scroll() {
    ui.body.scrollTop = ui.body.scrollHeight;
  }

  /** An action button under a reply. The agent only ever chose a KEY from the
   *  screens this shop has switched on; where that key goes is decided here,
   *  through the same guard the `#cc-track` deep links use. */
  function onChatAction(action) {
    beacon("chat_action_clicked", { key: action.key });
    openPanelOn(action.screen || "home");
  }

  function finishTurn(typing, frame, maybePrechat) {
    if (typing.parentNode) typing.parentNode.removeChild(typing);
    state.streaming = false;
    if (frame.conversationId) {
      state.conversationId = frame.conversationId;
      store(sessionStorage, CONVO_KEY, frame.conversationId);
    }
    var prechat = config.widget.prechat;
    if (
      maybePrechat &&
      prechat.mode === "both" &&
      !prechatDone() &&
      !state.prechatVisible &&
      state.shopperMessages >= prechat.showAfterMessages
    ) {
      showPrechat(true);
    }
    if (frame.outcome === "visitor_blocked") setBlocked();
    else if (frame.outcome === "human_mode") setHumanMode(true);
    // Poll while a conversation exists so a merchant reply ("take over" on an
    // AI-mode thread, or a reply to a resolved one) reaches the shopper live.
    // Only while the panel is open, or a closed panel leaves an orphan timer
    // ticking for the life of the page (QA D4).
    if (state.conversationId && state.open) startPolling();
    if (state.surveyPending && !state.surveyShown && state.conversationId) {
      state.surveyShown = true;
      store(sessionStorage, SURVEY_KEY, state.conversationId);
      state.surveyPending = false;
      appendEl(R.surveyPrompt(config.survey, { onRate: onSurveyRate }));
    }
    lockInput(isInputLocked());
    if (!isInputLocked() && state.open && state.screen === "chat") ui.inputEl.focus();
  }

  function failTurn(typing, partial) {
    if (typing.parentNode) typing.parentNode.removeChild(typing);
    // A truncated stream leaves a half-written bot bubble above the error;
    // drop it so Retry doesn't stack a second partial answer under it (D15).
    if (partial && partial.el && partial.el.parentNode) {
      partial.el.parentNode.removeChild(partial.el);
    }
    state.streaming = false;
    lockInput(false);
    appendEl(R.messageBubble("sys", "Message didn't send — check your connection.").el);
    var retry = R.el("button", "cw-retry", { type: "button" });
    retry.textContent = "Retry";
    retry.addEventListener("click", function () {
      if (retry.parentNode) retry.parentNode.removeChild(retry);
      if (state.lastUserText) sendMessage(state.lastUserText, true);
    });
    appendEl(retry);
  }

  // ── pre-chat form ────────────────────────────────────────────────────────
  function prechatDone() {
    return read(localStorage, PRECHAT_KEY) === "done" || read(localStorage, PRECHAT_KEY) === "skip";
  }

  function showPrechat(skippable) {
    state.prechatVisible = true;
    var form = R.prechatForm(config, { skippable: skippable }, {
      onSubmit: function (data) {
        T.postJson(base + "/prechat", {
          sessionId: sessionId(true),
          conversationId: state.conversationId || undefined,
          email: data.email,
          name: data.name,
          phone: data.phone,
          optIn: !!data.optIn,
        })
          .then(function () { done("done"); })
          .catch(function () { done("done"); }); // never block chat on analytics-grade failure
      },
      onSkip: function () { done("skip"); },
    });
    function done(result) {
      store(localStorage, PRECHAT_KEY, result);
      state.prechatVisible = false;
      if (form.parentNode) form.parentNode.removeChild(form);
      lockInput(isInputLocked());
      var pending = state.pendingText;
      state.pendingText = null;
      if (pending) {
        appendEl(R.messageBubble("user", pending).el);
        sendMessage(pending, false);
      } else {
        ui.inputEl.focus();
      }
    }
    ui.chatWrap.appendChild(form);
    scroll();
    lockInput(isInputLocked());
    var firstInput = form.querySelector("input");
    if (firstInput) firstInput.focus();
  }

  // ── cart state + theme cart UI ───────────────────────────────────────────
  // The add.js `sections` param makes Shopify return freshly rendered section
  // HTML with the add — that is what Dawn-family drawers/badges render from
  // (opening the drawer without it shows the stale, often empty, markup).
  var CART_SECTIONS = "cart-drawer,cart-icon-bubble";
  var cartSnapshot = null; // { itemCount, totalValue, items[] } — inbox cart card source

  function refreshCartSnapshot() {
    return fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (cart) {
        if (!cart) return null;
        cartSnapshot = {
          itemCount: cart.item_count || 0,
          totalValue: (cart.total_price || 0) / 100,
          items: (cart.items || []).slice(0, 20).map(function (i) {
            return {
              title: i.product_title || i.title || "Item",
              variant: i.variant_title || "",
              quantity: i.quantity || 1,
              price: (i.price || 0) / 100,
            };
          }),
        };
        return cartSnapshot;
      })
      .catch(function () { return null; });
  }

  /** Update the theme's cart UI from an add.js response carrying `sections`.
   *  openDrawer=true → Dawn-family renderContents (re-renders drawer + header
   *  badge, then opens). Returns true when the drawer handled everything. */
  function applyCartSections(data, openDrawer) {
    var sections = data && data.sections;
    var drawer = document.querySelector("cart-drawer");
    if (openDrawer && drawer && sections && typeof drawer.renderContents === "function") {
      drawer.renderContents(data);
      // Some Dawn versions track emptiness on the <cart-drawer> root but only
      // clear it from .drawer__inner — a leftover is-empty hides the items.
      drawer.classList.remove("is-empty");
      var innerEl = drawer.querySelector(".drawer__inner");
      if (innerEl) innerEl.classList.remove("is-empty");
      return true;
    }
    if (sections && sections["cart-icon-bubble"]) {
      var holder = document.getElementById("cart-icon-bubble");
      if (holder) {
        var parsed = new DOMParser().parseFromString(sections["cart-icon-bubble"], "text/html");
        var src = parsed.querySelector(".shopify-section") || parsed.body;
        holder.innerHTML = src.innerHTML;
      }
    }
    return false;
  }

  // ── product cards ────────────────────────────────────────────────────────
  /** The card's variant as a GID. Cards replayed from history were stored
   *  before variantGid existed, so derive it from the numeric id when absent. */
  function variantGid(card) {
    if (card.variantGid) return card.variantGid;
    return card.variantId ? "gid://shopify/ProductVariant/" + card.variantId : null;
  }

  /** True when this storefront exposes the standard cart actions. They ship on
   *  every Liquid storefront and are ready after DOMContentLoaded, so this is a
   *  readiness check rather than a real capability question. */
  function hasCartActions() {
    return Boolean(
      window.Shopify &&
        window.Shopify.actions &&
        typeof window.Shopify.actions.updateCart === "function",
    );
  }

  /**
   * Add via Shopify.actions — the theme decides how its cart renders, so this
   * is the path that works on Horizon.
   *
   * The /cart/add.js route below it is Dawn-shaped: it re-renders a
   * `<cart-drawer>` through `renderContents`, which Horizon does not have
   * (it uses `<cart-drawer-component>` / `<cart-items-component>` / `<cart-icon>`).
   * On Horizon that path found no drawer, dispatched an event nothing listens
   * for, and navigated the shopper to /cart — straight out of the chat.
   */
  function addViaActions(card) {
    return window.Shopify.actions
      .updateCart({ lines: [{ merchandiseId: variantGid(card), quantity: 1 }] })
      .then(function (result) {
        // The cart can reject a line without the call failing (sold out, a
        // limit) — that is a product-page problem, not a silent no-op.
        if (result && result.userErrors && result.userErrors.length) {
          throw new Error(result.userErrors[0].message || "cart rejected the line");
        }
        return refreshCartSnapshot().then(function (snapshot) {
          beaconAdd(card, snapshot);
          if (config.cartDrawer) {
            closePanel();
            return window.Shopify.actions.openCart();
          }
          appendSys("Added " + card.title + " to your cart ✓");
        });
      });
  }

  /** The analytics that ride every successful add, whichever path made it. */
  function beaconAdd(card, snapshot) {
    beacon("added_to_cart", { product: card.title, variantId: card.variantId }, snapshot);
    // The add belongs to the campaign that opened this chat, if any — one
    // credit per campaign, not one per item added.
    if (attributedCampaignId) {
      beacon("campaign_atc", { campaignId: attributedCampaignId, product: card.title });
      attributedCampaignId = null;
    }
  }

  function onCardAdd(card) {
    // Cards carry a numeric variantId (first available variant) when the
    // catalog mirror has variant data; fall back to the product page when not
    // (multi-option products deserve the picker anyway).
    if (!card.variantId) {
      window.location.href = "/products/" + card.handle;
      return;
    }
    if (hasCartActions()) {
      return addViaActions(card).catch(function () {
        // Theme or cart rejected it — let the product page handle it.
        window.location.href = "/products/" + card.handle;
      });
    }
    return fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        items: [{ id: Number(card.variantId), quantity: 1 }],
        sections: CART_SECTIONS,
        sections_url: window.location.pathname,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("cart add failed");
        return res.json();
      })
      .then(function (data) {
        // Fresh snapshot rides the beacon so the inbox cart card updates
        // immediately, and future messages carry it in pageContext.
        refreshCartSnapshot().then(function (snapshot) {
          beaconAdd(card, snapshot);
        });
        if (config.cartDrawer) {
          // Honor "open cart drawer after add to cart" (spec 16): minimize the
          // chat and hand off to the theme.
          closePanel();
          if (!applyCartSections(data, true)) {
            // Non-Dawn fallback: conventional event, else the cart page.
            var drawer = document.querySelector("cart-drawer");
            document.documentElement.dispatchEvent(
              new CustomEvent("cart:refresh", { bubbles: true }),
            );
            if (drawer && typeof drawer.open === "function") {
              drawer.open();
            } else if (!drawer) {
              window.location.href = "/cart";
            }
          }
        } else {
          applyCartSections(data, false); // header badge only — chat stays open
          appendSys("Added " + card.title + " to your cart ✓");
        }
      })
      .catch(function () {
        // Theme rejected the AJAX add (sold out / requires selection) — let the
        // product page handle it.
        window.location.href = "/products/" + card.handle;
      });
  }

  function appendSys(text) {
    if (R && ui.msgs) {
      appendEl(R.messageBubble("sys", text).el);
      scroll();
    }
  }

  // ── proactive campaigns runtime (spec 12) ────────────────────────────────
  // Thin scheduler in the shell; the bubble UI lives in the lazy renderer, so
  // a page where no campaign matches downloads nothing extra. One campaign per
  // page view, once per session (sessionStorage key per campaign id).
  var CAMP_SEEN_PREFIX = "cc:camp:";
  var CART_COUNT_KEY = "cc:cartn";
  var campaignShown = false;
  var campaignCartTotal = null; // set when /cart.js was fetched — {{cart_total}} source
  var campaignArmed = null; // teardown for the currently armed timing listener

  function campSeen(id) {
    return read(sessionStorage, CAMP_SEEN_PREFIX + id) === "1";
  }

  /** Everything the pure evaluator needs that the shell can read synchronously. */
  function campaignContext() {
    var now = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return {
      pageType: ccPageType(pageType),
      path: window.location.pathname,
      productId: productGid,
      collectionId: collectionGid,
      cart: null,
      cartRemoved: false,
      isCustomer: Boolean(customerName) || isLoggedIn,
      device: window.matchMedia && window.matchMedia("(max-width: 768px)").matches ? "mobile" : "desktop",
      online: Boolean(config && config.availability && config.availability.status === "online"),
      // Local calendar date — the merchant picked the window in their own
      // shop's terms and shoppers read it in theirs; an ISO UTC date would
      // start and end campaigns a day early for half the world.
      today: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()),
      country: storeCountry,
    };
  }

  function initCampaigns() {
    var list = (config && config.campaigns) || [];
    var candidates = [];
    for (var i = 0; i < list.length; i++) {
      if (!campSeen(list[i].id)) candidates.push(list[i]);
    }
    if (candidates.length === 0) return;
    var ctx = campaignContext();

    // /cart.js is fetched ONLY when a candidate campaign actually needs cart
    // state — a cart window, a removal trigger, or the {{cart_total}} tag.
    var needsCart = candidates.some(function (c) {
      var t = c.trigger || {};
      if (c.templateType === "remove_items") return true;
      if ((t.cartMinItems || 0) > 0 || (t.cartMinValue || 0) > 0) return true;
      if (t.cartMaxValue !== null && t.cartMaxValue !== undefined && t.cartMaxValue > 0) return true;
      return /\{\{\s*cart_total\s*\}\}/.test(String((c.message && c.message.bodyHtml) || ""));
    });

    var ready = needsCart
      ? fetch("/cart.js", { headers: { Accept: "application/json" } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (cart) {
            if (!cart) return;
            var count = cart.item_count || 0;
            ctx.cart = { itemCount: count, totalValue: (cart.total_price || 0) / 100 };
            campaignCartTotal = ctx.cart.totalValue;
            // Removal detection without theme hooks: the previous page view's
            // line-item count is kept per tab, so a drop between views means
            // the shopper took something out.
            var previous = parseInt(read(sessionStorage, CART_COUNT_KEY) || "", 10);
            ctx.cartRemoved = !isNaN(previous) && count < previous;
            store(sessionStorage, CART_COUNT_KEY, String(count));
          })
          .catch(function () { /* cart unknown → cart campaigns stay silent */ })
      : Promise.resolve();

    ready.then(function () {
      // Server sends campaigns priority-ordered — first match wins.
      for (var j = 0; j < candidates.length; j++) {
        if (ccEvalCampaign(candidates[j], ctx)) return armCampaign(candidates[j]);
      }
    });
  }

  /** Attach the campaign's timing control. Returns nothing; the campaign fires
   *  (at most once) through fireCampaign. */
  function armCampaign(c) {
    var t = c.trigger || {};
    if (t.exitIntent) {
      var onOut = function (e) {
        if (e.clientY <= 0 && !e.relatedTarget) {
          document.removeEventListener("mouseout", onOut);
          fireCampaign(c);
        }
      };
      document.addEventListener("mouseout", onOut);
      campaignArmed = function () { document.removeEventListener("mouseout", onOut); };
      return;
    }
    if (t.sendAfter === "scroll") {
      var target = Math.min(100, Math.max(1, t.scrollPercent || 50));
      var onScroll = function () {
        var doc = document.documentElement;
        var scrollable = (doc.scrollHeight || 0) - (window.innerHeight || 0);
        // A page shorter than the viewport can never reach a percentage —
        // treat it as fully scrolled so the campaign isn't silently dead.
        var pct = scrollable > 0 ? ((window.pageYOffset || doc.scrollTop || 0) / scrollable) * 100 : 100;
        if (pct >= target) {
          window.removeEventListener("scroll", onScroll);
          fireCampaign(c);
        }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      campaignArmed = function () { window.removeEventListener("scroll", onScroll); };
      onScroll(); // short pages qualify immediately
      return;
    }
    var timer = setTimeout(function () { fireCampaign(c); }, (t.delaySeconds || 0) * 1000);
    campaignArmed = function () { clearTimeout(timer); };
  }

  /** Contextual product data (Smart Product Page chips, similar/complementary
   *  cards) can't ride the shared 5-minute config cache — fetch it per page. */
  function fetchCampaignProducts(c) {
    if (!c.needsContextualProducts || !productGid) return Promise.resolve(null);
    return fetch(
      base + "/campaign-products?campaign=" + encodeURIComponent(c.id) + "&product=" + encodeURIComponent(productGid),
      { headers: { Accept: "application/json" } },
    )
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }

  function fireCampaign(c) {
    if (campaignShown || state.open || campSeen(c.id)) return;
    campaignShown = true;
    store(sessionStorage, CAMP_SEEN_PREFIX + c.id, "1");
    Promise.all([ensureModules(), fetchCampaignProducts(c)])
      .then(function (results) {
        if (state.open) return;
        var extra = results[1] || {};
        var campaign = c;
        if (extra.products && extra.products.length) {
          // Shallow copy — never mutate the cached config payload.
          campaign = {};
          for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) campaign[k] = c[k];
          campaign.products = extra.products;
        }
        var selectedVariant = null;
        var bubble = R.campaignBubble(
          campaign,
          {
            currency: config.currency,
            customerName: customerName,
            cartTotal: campaignCartTotal,
            anchor: extra.anchor || null,
            starters: campaignStarters(),
          },
          {
            onDismiss: removeCampaignBubble,
            onCta: function (api, seed) { handleCampaignCta(campaign, api, seed, selectedVariant); },
            onView: function (card) { window.location.href = "/products/" + card.handle; },
            onLead: function (values, api) { submitCampaignLead(campaign, values, api); },
            onSelectVariant: function (option) { selectedVariant = option; },
          },
        );
        ui.campaign = bubble.el;
        ui.root.insertBefore(bubble.el, ui.panel || ui.launcher);
        beacon("campaign_view", { campaignId: campaign.id, templateType: campaign.templateType });
      })
      .catch(function () { /* renderer failed — no bubble, no errors */ });
  }

  /** Conversation starters reused as the Text template's "Quick question" chips. */
  function campaignStarters() {
    var starters = (config && config.widget && config.widget.starters) || {};
    if (!starters.enabled) return [];
    return (starters.items || []).map(function (item) {
      return { label: item.question || item.label || "" };
    }).filter(function (item) { return item.label; });
  }

  function removeCampaignBubble() {
    if (campaignArmed) { campaignArmed(); campaignArmed = null; }
    if (ui.campaign && ui.campaign.parentNode) ui.campaign.parentNode.removeChild(ui.campaign);
    ui.campaign = null;
  }

  /** Open the panel straight into the chat screen, optionally seeding a first
   *  message (floater "Ask about it", quick-question chips). */
  function openChatWith(seed) {
    removeCampaignBubble();
    ensureModules()
      .then(function () {
        if (!state.open) {
          state.screen = "chat";
          openPanel();
        }
        showScreen("chat");
        if (seed) trySend(seed);
      })
      .catch(function () { /* modules failed — nothing to open */ });
  }

  function handleCampaignCta(c, api, seed, variant) {
    beacon("campaign_click", { campaignId: c.id, templateType: c.templateType });
    attributeCampaign(c);
    var m = c.message || {};
    if (m.kind === "discount" && !m.lead && m.discountCode) {
      // Shopify share-link endpoint sets the discount cookie for checkout.
      fetch("/discount/" + encodeURIComponent(m.discountCode))
        .then(function () { api.confirm("Code " + m.discountCode + " will be applied at checkout ✓"); })
        .catch(function () { api.confirm("Use code " + m.discountCode + " at checkout"); });
      return;
    }
    if (seed) return openChatWith(seed);
    if (m.kind === "floater" && variant && variant.value) {
      return openChatWith("I'm looking at this in " + variant.value + " — is it a good fit?");
    }
    openChatWith(null);
  }

  function submitCampaignLead(c, values, api) {
    var lead = (c.message && c.message.lead) || {};
    fetch(base + "/campaign-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaignId: c.id,
        sessionId: sessionId(false),
        email: values.email,
        name: values.name || undefined,
        phone: values.phone || undefined,
      }),
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var text = (data && data.message) || lead.successMessage || "Thank you for subscribing!";
        var code = (data && data.discountCode) || (c.message && c.message.discountCode);
        api.confirm(code ? text + "\n\nYour code: " + code : text);
        if (code) {
          fetch("/discount/" + encodeURIComponent(code)).catch(function () { /* best effort */ });
        }
      })
      .catch(function () {
        api.confirm("We couldn't save that just now — please try again later.");
      });
  }

  /** Attribution for the chat the campaign opened. The design's bubbles hand
   *  the shopper to chat rather than adding to cart inline, so the add happens
   *  later, on the in-chat product cards — stamp the cart NOW and remember the
   *  campaign so that add can still be credited (spec 12 revenue attribution). */
  var attributedCampaignId = null;
  function attributeCampaign(c) {
    attributedCampaignId = c.id;
    fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ attributes: { chatconvert_campaign: c.id } }),
    }).catch(function () { /* attribution is best-effort */ });
  }

  // ── order tracking ───────────────────────────────────────────────────────
  /** Custom tracking URL (spec 16): scheme-normalized; "{number}" positions the
   *  number mid-URL, otherwise it's appended (path-style and ?param= both). */
  function customTrackingUrl(customUrl, number) {
    var url = String(customUrl || "").trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url.replace(/^\/+/, "");
    return url.indexOf("{number}") !== -1
      ? url.replace("{number}", encodeURIComponent(number))
      : url + encodeURIComponent(number);
  }

  /** New-tab open via a real anchor click (window.open+noopener returns null
   *  even on success, so it can't be used to detect blocking). */
  function openExternal(url) {
    var a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function onTrack(data, api) {
    if (!data.value) return; // renderer validates; belt-and-braces
    var tracking = (config && config.orderTracking) || { mode: "default", customUrl: "" };

    if (data.tab === "tracking") {
      if (!api) return; // admin preview passes no api — form only
      if (tracking.mode === "integration") {
        // Real-time status card from the connected tracking provider.
        api.loading(true);
        T.postJson(base + "/order-track", { trackingNumber: data.value })
          .then(function (res) {
            api.loading(false);
            if (res && res.ok && res.shipment) {
              api.show(R.shipmentCard(data.value, res.shipment));
            } else if (res && res.error === "unavailable") {
              api.fail("Tracking lookup isn't available right now. Please try again later.");
            } else {
              api.fail("We couldn't find that tracking number. Please check it and try again.");
            }
          })
          .catch(function () {
            api.loading(false);
            api.fail("Tracking lookup isn't available right now. Please try again later.");
          });
        return;
      }
      // Custom mode: open the merchant's tracking page in a new tab.
      if (!tracking.customUrl) {
        api.fail("Tracking by number isn't set up for this store yet. Please track with your order number instead.");
        return;
      }
      openExternal(customTrackingUrl(tracking.customUrl, data.value));
      return;
    }

    // Order-number tab: instant in-widget status via the proxy (no login).
    if (!api) return; // admin preview passes no api — form only
    api.loading(true);
    T.postJson(base + "/order-track", {
      orderNumber: data.value,
      method: data.contactMethod,
      contact: data.contact,
    })
      .then(function (res) {
        api.loading(false);
        if (res && res.ok && res.order) {
          api.show(R.orderStatusCard(res.order, config));
        } else if (res && res.error === "unavailable") {
          api.fail("Order lookup isn't available right now. Please try again later.");
        } else {
          api.fail(
            "We couldn't find a matching order. Double-check the order number and " +
              (data.contactMethod === "phone" ? "phone number." : "email address."),
          );
        }
      })
      .catch(function () {
        api.loading(false);
        api.fail("Order lookup isn't available right now. Please try again later.");
      });
  }

  // ── handover (spec 10): leave-a-message form + AI dormancy ───────────────
  /** Contact-method chips (spec 10 step 4: "message + contact method chips").
   *  Same rows, same markup and same CSS as the home screen's block — they come
   *  from Chatbox → Contact methods (spec 06), already in the widget config. */
  function contactChips() {
    var cm = config.widget && config.widget.contactMethods;
    if (!cm || !cm.enabled || !cm.items || cm.items.length === 0) return null;
    var wrap = R.el("div", "cw-actions");
    cm.items
      .slice()
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .forEach(function (m) {
        var chip = R.el("a", "cw-cm cw-cm--" + m.type, {
          href: R.contactHref(m),
          "aria-label": m.type,
          target: m.type === "whatsapp" ? "_blank" : "_self",
          rel: "noopener",
        });
        chip.innerHTML = R.icons[m.type] || R.icons.email; // static, app-authored SVG
        wrap.appendChild(chip);
      });
    return wrap;
  }

  function handleHandover(data) {
    // Destination "contact methods" (and the inbox destination's offline
    // contact-methods branch): the server already streamed the message bubble,
    // the chips are what let the shopper act on it.
    if (data.contactMethods) {
      var chips = contactChips();
      if (chips) appendEl(chips);
    }
    if (data.form) {
      var form = R.handoverForm(data.form, {
        onSubmit: function (values, api) {
          T.postJson(base + "/handover-form", {
            sessionId: sessionId(true),
            conversationId: state.conversationId || undefined,
            values: values,
          })
            .then(function (res) {
              if (form.parentNode) form.parentNode.removeChild(form);
              appendEl(
                R.messageBubble(
                  "bot",
                  (res && res.postSubmitMessage) ||
                    data.form.postSubmitMessage ||
                    "Thanks — our team will follow up soon.",
                ).el,
              );
            })
            .catch(function () {
              api.fail("Couldn't send — check your connection and try again.");
            });
        },
      });
      ui.chatWrap.appendChild(form);
      scroll();
      var first = form.querySelector("input, textarea");
      if (first) first.focus();
    }
    if (data.aiDormant) {
      setHumanMode(true);
    }
  }

  // ── human-mode polling ───────────────────────────────────────────────────
  function isHumanMode() {
    return state.humanMode;
  }
  function setHumanMode(on) {
    state.humanMode = on;
    store(sessionStorage, HUMAN_KEY, on ? "1" : null);
    if (ui.inputEl && !state.blocked) {
      ui.inputEl.placeholder = on ? HUMAN_PLACEHOLDER : DEFAULT_PLACEHOLDER;
    }
  }
  /** Merchant blocked this visitor: composer locked for the conversation. */
  function setBlocked() {
    if (state.blocked) return;
    state.blocked = true;
    // Persisted so the composer is locked immediately on the next page rather
    // than after /history answers (QA D7).
    store(sessionStorage, BLOCKED_KEY, "1");
    stopPolling();
    if (ui.inputEl) {
      ui.inputEl.placeholder = BLOCKED_PLACEHOLDER;
      lockInput(true);
    }
  }
  /** Poll cadence: snappy while a human is on the thread, backing off once a
   *  thread goes quiet so an abandoned open panel stops hammering (QA D5). */
  function pollIntervalMs() {
    if (state.humanMode) return 5000;
    var empties = state.emptyPolls || 0;
    if (empties >= 12) return 30000;
    if (empties >= 4) return 15000;
    return 5000;
  }
  function applyPollInterval() {
    if (!state.pollTimer) return;
    var next = pollIntervalMs();
    if (next === state.pollEvery) return;
    stopPolling();
    state.pollEvery = next;
    state.pollTimer = setInterval(pollMessages, next);
  }
  function startPolling() {
    if (state.pollTimer || state.blocked) return;
    if (!state.pollSince) state.pollSince = new Date().toISOString();
    store(sessionStorage, POLL_KEY, state.pollSince);
    state.pollEvery = pollIntervalMs();
    state.pollTimer = setInterval(pollMessages, state.pollEvery);
  }
  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }
  function pollMessages() {
    // Never poll over an in-flight /history restore — the two would race and
    // render the same messages twice (QA D2).
    if (!state.conversationId || !state.open || state.restoring) return;
    // seen=1: the shopper is looking at the thread — agent replies get a
    // Seen receipt in the merchant inbox (spec 10 acceptance 7).
    T.getJson(
      base +
        "/messages?conversationId=" +
        encodeURIComponent(state.conversationId) +
        "&sessionId=" +
        encodeURIComponent(sessionId(false)) +
        "&since=" +
        encodeURIComponent(state.pollSince) +
        "&seen=1",
    )
      .then(function (data) {
        var fresh = 0;
        (data.messages || []).forEach(function (m) {
          // Skip anything /history already drew (QA D1/D2).
          if (m.id && state.renderedIds[m.id]) {
            state.pollSince = m.createdAt;
            return;
          }
          if (m.id) state.renderedIds[m.id] = 1;
          fresh++;
          appendEl(
            R.messageBubble(
              m.author === "system" ? "sys" : "bot",
              m.content,
              m.author === "agent" ? "Team" : null,
            ).el,
          );
          state.pollSince = m.createdAt;
        });
        store(sessionStorage, POLL_KEY, state.pollSince);
        // Idle threads back off so an abandoned open panel isn't a 5s
        // read+write loop forever (QA D5).
        state.emptyPolls = fresh > 0 ? 0 : (state.emptyPolls || 0) + 1;
        applyPollInterval();
        if (data.blocked) {
          setBlocked();
          return;
        }
        // Reset unconditionally: "unresolve" leaves mode at "ai", which used
        // to strand resolvedSeen=true and swallow the next resolve (QA D3).
        if (data.status !== "resolved") state.resolvedSeen = false;
        if (data.mode === "human" && data.status !== "resolved") {
          if (!state.humanMode) setHumanMode(true); // merchant took over an AI thread
        } else if (data.status === "resolved") {
          if (!state.resolvedSeen) onConversationResolved();
        } else if (state.humanMode) {
          setHumanMode(false);
        }
      })
      .catch(function () { /* transient — keep polling */ });
  }

  /** Merchant resolved the thread: AI wakes up, maybe survey. Polling keeps
   *  running so a later merchant reply (which reopens it) still arrives. */
  function onConversationResolved() {
    state.resolvedSeen = true;
    setHumanMode(false);
    ui.inputEl.placeholder = DEFAULT_PLACEHOLDER;
    var survey = config.survey;
    if (
      config.widget.survey &&
      survey &&
      survey.triggerOnResolve &&
      !state.surveyShown &&
      state.conversationId
    ) {
      state.surveyShown = true;
      store(sessionStorage, SURVEY_KEY, state.conversationId);
      state.surveyPending = false;
      appendEl(R.surveyPrompt(survey, { onRate: onSurveyRate }));
    }
  }

  // ── satisfaction survey ──────────────────────────────────────────────────
  function checkSurveyTrigger(text) {
    if (!config.widget.survey || state.surveyShown || state.surveyPending) return;
    var survey = config.survey;
    if (!survey || !survey.triggerKeywords || !survey.triggerKeywords.enabled) return;
    var lower = text.toLowerCase();
    var hit = (survey.triggerKeywords.keywords || []).some(function (k) {
      return k && lower.indexOf(k.toLowerCase()) !== -1;
    });
    if (hit) state.surveyPending = true;
  }

  function onSurveyRate(rating) {
    if (!state.conversationId) return;
    T.postJson(base + "/survey", { conversationId: state.conversationId, sessionId: sessionId(false), rating: rating }).catch(
      function () { /* non-blocking */ },
    );
  }

  // ── restore conversation id for this tab ─────────────────────────────────
  (function () {
    // Read-only: expires a stale session (clearing its convo) but never mints
    // one — a page view alone must not write an identifier (see sessionId()).
    peekSession();
    var convo = read(sessionStorage, CONVO_KEY);
    if (convo) {
      state.conversationId = convo;
      // Human-mode survives reloads: resume polling from where we left off.
      var since = read(sessionStorage, POLL_KEY);
      if (since) state.pollSince = since;
      state.humanMode = read(sessionStorage, HUMAN_KEY) === "1";
      state.blocked = read(sessionStorage, BLOCKED_KEY) === "1";
      // The survey is once per conversation, not once per page load (QA D8).
      state.surveyShown = read(sessionStorage, SURVEY_KEY) === convo;
    }
  })();
})();
