/* ChatConvert storefront widget shell (spec 05).
 * Initial payload = config fetch + launcher only (<30KB gz budget). The panel
 * modules (widget-renderer.js / widget-transport.js) are injected on first
 * launcher click. No framework, no CDNs, no secrets — proxy endpoints only.
 */
(function () {
  "use strict";

  /* ── Proactive campaigns: PURE trigger evaluator (spec 12) ───────────────
   * ctx: { pageType, path, seen?: {id:1}, cart?: {itemCount,totalValue},
   *        elapsedMs?: number }. Exposed on window.ChatConvertCampaigns for
   * node-based unit tests (scripts/test-campaign-triggers.ts) — keep pure. */
  function ccEvalTrigger(campaign, ctx) {
    if (!campaign) return false;
    var t = campaign.trigger || {};
    if (ctx.seen && ctx.seen[campaign.id]) return false; // once per session
    var pts = t.pageTypes && t.pageTypes.length ? t.pageTypes : ["any"];
    if (pts.indexOf("any") === -1 && pts.indexOf(ctx.pageType) === -1) return false;
    if (t.urlContains && String(ctx.path || "").indexOf(t.urlContains) === -1) return false;
    if (typeof ctx.elapsedMs === "number" && (t.delaySeconds || 0) * 1000 > ctx.elapsedMs) return false;
    if ((t.cartMinItems || 0) > 0 || (t.cartMinValue || 0) > 0) {
      if (!ctx.cart) return false; // cart state required but unknown
      if ((t.cartMinItems || 0) > 0 && (ctx.cart.itemCount || 0) < t.cartMinItems) return false;
      if ((t.cartMinValue || 0) > 0 && (ctx.cart.totalValue || 0) < t.cartMinValue) return false;
    }
    return true;
  }
  /** Shopify request.page_type → campaign page type. */
  function ccPageType(raw) {
    if (raw === "index") return "home";
    if (raw === "list-collections") return "collection";
    return raw || "";
  }
  if (typeof window !== "undefined") {
    window.ChatConvertCampaigns = { evalTrigger: ccEvalTrigger, pageType: ccPageType };
  }

  var host = document.getElementById("chatconvert-root");
  if (!host) return;

  var base = host.getAttribute("data-proxy-base") || "/apps/ccwidget";
  var customerName = host.getAttribute("data-customer-name") || "";
  var pageType = host.getAttribute("data-page-type") || "";
  var rendererSrc = host.getAttribute("data-renderer-src");
  var transportSrc = host.getAttribute("data-transport-src");
  var cssSrc = host.getAttribute("data-css-src");

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
  var CONVO_KEY = "cc:convo";
  var PRECHAT_KEY = "cc:prechat";
  var CONFIG_KEY = "cc:config";
  var POLL_KEY = "cc:poll";
  var OPEN_KEY = "cc:open"; // "1" = panel open — survives page navigation
  var SCREEN_KEY = "cc:screen";
  var DEFAULT_PLACEHOLDER = "Type your message…";
  var HUMAN_PLACEHOLDER = "A team member will reply here…";
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

  /** sessionId with 30-min inactivity rotation; touch() extends the window. */
  function sessionId(touch) {
    var now = Date.now();
    var s = null;
    var raw = read(localStorage, SESSION_KEY);
    if (raw) {
      try { s = JSON.parse(raw); } catch (e) { s = null; }
    }
    if (!s || !s.id || now - (s.at || 0) > SESSION_IDLE) {
      s = { id: uuid(), at: now };
      state.conversationId = null;
      store(sessionStorage, CONVO_KEY, null);
      store(sessionStorage, POLL_KEY, null);
    }
    if (touch) s.at = now;
    store(localStorage, SESSION_KEY, JSON.stringify(s));
    return s.id;
  }

  // ── config fetch (sessionStorage cache, 5 min) ───────────────────────────
  function getConfig() {
    var raw = read(sessionStorage, CONFIG_KEY);
    if (raw) {
      try {
        var hit = JSON.parse(raw);
        if (hit && Date.now() - hit.at < CONFIG_TTL) return Promise.resolve(hit.data);
      } catch (e) { /* refetch */ }
    }
    return fetch(base + "/widget-config", { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) return null; // 404 = uninstalled/disabled → render nothing
        return res.json().then(function (data) {
          store(sessionStorage, CONFIG_KEY, JSON.stringify({ at: Date.now(), data: data }));
          return data;
        });
      })
      .catch(function () { return null; }); // network error → silent
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
    ensureCss().then(mountLauncher).then(initCampaigns).then(maybeRestoreOpen);
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

  // ── panel lifecycle ──────────────────────────────────────────────────────
  function togglePanel() {
    if (state.open) return closePanel();
    ensureModules()
      .then(openPanel)
      .catch(function () { /* modules failed to load — stay closed, no errors */ });
  }

  function beacon(type, payload, cart) {
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
    refreshCartSnapshot(); // first message's pageContext carries the cart
    state.open = true;
    store(sessionStorage, OPEN_KEY, "1");
    var focusChat = config.widget.chatFocusMode && config.widget.liveChat;
    showScreen(focusChat ? "chat" : state.screen === "chat" ? "chat" : "home");
    if (state.pollTimer === null && isHumanMode()) startPolling();
    var focusable = ui.panel.querySelector("input, button");
    if (focusable) focusable.focus();
  }

  function closePanel() {
    if (ui.panel) ui.panel.style.display = "none";
    ui.launcher.style.display = "";
    ui.launcher.setAttribute("aria-expanded", "false");
    state.open = false;
    store(sessionStorage, OPEN_KEY, "0");
    stopPolling();
    ui.launcher.focus();
  }

  function buildPanel() {
    var panel = R.el("div", "cw-panel", { role: "dialog", "aria-modal": "true", "aria-label": config.widget.header.name || "ChatConvert chat" });
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

  function trapFocus(e) {
    var focusables = ui.panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    var visible = [];
    for (var i = 0; i < focusables.length; i++) {
      if (focusables[i].offsetParent !== null) visible.push(focusables[i]);
    }
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

  // ── chat flow ────────────────────────────────────────────────────────────
  function prepareChat() {
    if (!state.startersShown) {
      state.startersShown = true;
      // A conversation from earlier in this session (page navigation) restores
      // its history from the server instead of showing the intro again.
      if (state.conversationId) restoreHistory();
      else renderIntro();
    }
    if (isHumanMode()) ui.inputEl.placeholder = HUMAN_PLACEHOLDER;
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
        var msgs = (data && data.messages) || [];
        if (msgs.length === 0) return renderIntro();
        msgs.forEach(function (m) {
          if (m.role === "in") {
            appendEl(R.messageBubble("user", m.content).el);
            state.shopperMessages++;
          } else {
            appendEl(
              R.messageBubble("bot", m.content, m.author === "agent" ? "Team" : null).el,
            );
            if (m.productCards && m.productCards.length) {
              appendEl(R.productCards(m.productCards, config.currency, { onAdd: onCardAdd }));
            }
          }
        });
        // Human-mode threads resume polling exactly where the last page left
        // off (pollSince already restored from sessionStorage at boot).
        if (data.mode === "human" && data.status !== "resolved" && state.open) startPolling();
        scroll();
      })
      .catch(function () {
        // Conversation gone/unreachable — start fresh like a new visitor.
        done();
        renderIntro();
      });
  }

  function isInputLocked() {
    return (
      state.streaming ||
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
    function bot() {
      if (!botBubble) {
        if (typing.parentNode) typing.parentNode.removeChild(typing);
        botBubble = R.messageBubble("bot", "");
        appendEl(botBubble.el);
      }
      return botBubble.bubbleEl;
    }

    T.streamChat(
      base,
      {
        sessionId: sessionId(true),
        conversationId: state.conversationId || undefined,
        message: text,
        pageContext: {
          pageType: pageType,
          url: window.location.pathname,
          cart: cartSnapshot || undefined,
        },
      },
      {
        onToken: function (t) { bot().appendChild(document.createTextNode(t)); scroll(); },
        onMessage: function (m) { R.setText(bot(), m); scroll(); },
        onCards: function (cards) {
          appendEl(R.productCards(cards, config.currency, { onAdd: onCardAdd }));
        },
        onHandover: handleHandover,
        onDone: function (frame) { finishTurn(typing, frame, echoDone); },
        onError: function () { failTurn(typing); },
      },
    );
  }

  function scroll() {
    ui.body.scrollTop = ui.body.scrollHeight;
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
    if (frame.outcome === "human_mode" || frame.outcome === "handover") {
      startPolling();
    }
    if (state.surveyPending && !state.surveyShown && state.conversationId) {
      state.surveyShown = true;
      state.surveyPending = false;
      appendEl(R.surveyPrompt(config.survey, { onRate: onSurveyRate }));
    }
    lockInput(isInputLocked());
    if (!isInputLocked() && state.open && state.screen === "chat") ui.inputEl.focus();
  }

  function failTurn(typing) {
    if (typing.parentNode) typing.parentNode.removeChild(typing);
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
  function onCardAdd(card) {
    // Cards carry a numeric variantId (first available variant) when the
    // catalog mirror has variant data; fall back to the product page when not
    // (multi-option products deserve the picker anyway).
    if (!card.variantId) {
      window.location.href = "/products/" + card.handle;
      return;
    }
    fetch("/cart/add.js", {
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
          beacon("added_to_cart", { product: card.title, variantId: card.variantId }, snapshot);
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
  // Thin scheduler in the shell; bubble UI lives in the lazy renderer, which
  // is injected only when a campaign actually fires. One campaign per page
  // view, once per session (sessionStorage key per campaign id).
  var CAMP_SEEN_PREFIX = "cc:camp:";
  var campaignShown = false;
  var campaignCartTotal = null; // set when /cart.js was fetched — {{cart_total}} source

  function campSeen(id) {
    return read(sessionStorage, CAMP_SEEN_PREFIX + id) === "1";
  }

  function initCampaigns() {
    var list = (config && config.campaigns) || [];
    var candidates = [];
    for (var i = 0; i < list.length; i++) {
      if (!campSeen(list[i].id)) candidates.push(list[i]);
    }
    if (candidates.length === 0) return;
    var ctx = { pageType: ccPageType(pageType), path: window.location.pathname, cart: null };
    // /cart.js is fetched ONLY when a candidate campaign has cart conditions
    // or renders the {{cart_total}} merge tag.
    var needsCart = candidates.some(function (c) {
      var t = c.trigger || {};
      if ((t.cartMinItems || 0) > 0 || (t.cartMinValue || 0) > 0) return true;
      return /\{\{\s*cart_total\s*\}\}/.test(String(c.message || ""));
    });
    var ready = needsCart
      ? fetch("/cart.js", { headers: { Accept: "application/json" } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (cart) {
            if (cart) {
              ctx.cart = { itemCount: cart.item_count || 0, totalValue: (cart.total_price || 0) / 100 };
              campaignCartTotal = ctx.cart.totalValue;
            }
          })
          .catch(function () { /* cart unknown → cart campaigns stay silent */ })
      : Promise.resolve();
    ready.then(function () {
      // Server sends campaigns priority-ordered — first match wins.
      for (var j = 0; j < candidates.length; j++) {
        if (ccEvalTrigger(candidates[j], ctx)) return armCampaign(candidates[j]);
      }
    });
  }

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
    } else {
      setTimeout(function () { fireCampaign(c); }, (t.delaySeconds || 0) * 1000);
    }
  }

  function fireCampaign(c) {
    if (campaignShown || state.open || campSeen(c.id)) return;
    campaignShown = true;
    store(sessionStorage, CAMP_SEEN_PREFIX + c.id, "1");
    ensureModules()
      .then(function () {
        if (state.open) return;
        var bubble = R.campaignBubble(
          c,
          { currency: config.currency, customerName: customerName, cartTotal: campaignCartTotal },
          {
            onDismiss: removeCampaignBubble,
            onCta: function (api) { handleCampaignCta(c, api); },
            onAdd: function (card, api) { campaignAdd(c, card, api); },
          },
        );
        ui.campaign = bubble.el;
        ui.root.insertBefore(bubble.el, ui.panel || ui.launcher);
        beacon("campaign_view", { campaignId: c.id, templateType: c.templateType });
      })
      .catch(function () { /* renderer failed — no bubble, no errors */ });
  }

  function removeCampaignBubble() {
    if (ui.campaign && ui.campaign.parentNode) ui.campaign.parentNode.removeChild(ui.campaign);
    ui.campaign = null;
  }

  function handleCampaignCta(c, api) {
    beacon("campaign_click", { campaignId: c.id, templateType: c.templateType });
    if (c.ctaAction === "apply_code" && c.discountCode) {
      // Shopify share-link endpoint sets the discount cookie for checkout.
      fetch("/discount/" + encodeURIComponent(c.discountCode))
        .then(function () { api.confirm("Code " + c.discountCode + " will be applied at checkout ✓"); })
        .catch(function () { api.confirm("Use code " + c.discountCode + " at checkout"); });
    } else if (
      c.ctaAction === "link" &&
      c.ctaUrl &&
      (c.ctaUrl.charAt(0) === "/" || /^https?:\/\//i.test(c.ctaUrl))
    ) {
      // Defense in depth: schema validates on save, but never navigate to a
      // non-http(s)/relative URL from merchant config (review M3).
      window.location.href = c.ctaUrl;
    } else {
      removeCampaignBubble();
      togglePanel();
    }
  }

  /** Campaign product-card ATC — carries campaignId through the beacon and
   *  stamps the cart attribute `chatconvert_campaign` for order attribution. */
  function campaignAdd(c, card, api) {
    if (!card.variantId) {
      window.location.href = "/products/" + card.handle;
      return;
    }
    fetch("/cart/add.js", {
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
        applyCartSections(data, false); // refresh the header badge in place
        refreshCartSnapshot();
        fetch("/cart/update.js", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ attributes: { chatconvert_campaign: c.id } }),
        }).catch(function () { /* attribution is best-effort */ });
        beacon("campaign_atc", { campaignId: c.id, revenue: card.price, product: card.title });
        api.confirm("Added " + card.title + " to your cart ✓");
      })
      .catch(function () {
        // Theme rejected the AJAX add — let the product page handle it.
        window.location.href = "/products/" + card.handle;
      });
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
  function handleHandover(data) {
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
      ui.inputEl.placeholder = HUMAN_PLACEHOLDER;
    }
  }

  // ── human-mode polling ───────────────────────────────────────────────────
  function isHumanMode() {
    return state.pollSince !== null;
  }
  function startPolling() {
    if (state.pollTimer) return;
    if (!state.pollSince) state.pollSince = new Date().toISOString();
    store(sessionStorage, POLL_KEY, state.pollSince);
    state.pollTimer = setInterval(pollMessages, 5000);
  }
  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }
  function pollMessages() {
    if (!state.conversationId || !state.open) return;
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
        (data.messages || []).forEach(function (m) {
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
        if (data.status === "resolved") onConversationResolved();
      })
      .catch(function () { /* transient — keep polling */ });
  }

  /** Merchant resolved the thread: stop polling, wake the AI, maybe survey. */
  function onConversationResolved() {
    stopPolling();
    state.pollSince = null;
    store(sessionStorage, POLL_KEY, null);
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
    sessionId(false); // rotate stale sessions first (also clears stale convo)
    var convo = read(sessionStorage, CONVO_KEY);
    if (convo) {
      state.conversationId = convo;
      // Human-mode survives reloads: resume polling from where we left off.
      var since = read(sessionStorage, POLL_KEY);
      if (since) state.pollSince = since;
    }
  })();

  // ── manual SSE probe (?ccprobe=1) — proxy buffering go/no-go check ───────
  if (window.location.search.indexOf("ccprobe=1") !== -1) {
    (function () {
      var started = Date.now();
      fetch(base + "/ping")
        .then(function (res) {
          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buffer = "";
          function pump() {
            return reader.read().then(function (result) {
              if (result.done) return undefined;
              buffer += decoder.decode(result.value, { stream: true });
              var parts = buffer.split("\n\n");
              buffer = parts.pop() || "";
              parts.forEach(function (part) {
                var line = part.split("\n").find(function (l) { return l.indexOf("data: ") === 0; });
                if (line) console.log("[ChatConvert probe]", line.slice(6), "+" + (Date.now() - started) + "ms");
              });
              return pump();
            });
          }
          return pump();
        })
        .catch(function (err) { console.error("[ChatConvert probe] failed", err); });
    })();
  }
})();
