/* ChatConvert widget renderer (spec 05).
 * FRAMEWORK-FREE, DOM-API-pure view layer shared by the storefront shell
 * (chat-widget.js) and the admin live preview (spec 06). Rules:
 *   - all data in via arguments (config/state), all events out via callbacks
 *   - no fetch, no Shopify globals, no reads outside the given elements
 * Attached to window.ChatConvertRenderer (theme assets are not ESM-bundled).
 */
(function () {
  "use strict";

  // ── SVG icons (from the chatbox.html design) ─────────────────────────────
  var ICONS = {
    chat: '<svg width="24" height="24" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 5h12v8H8l-3 3V5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    help: '<svg width="24" height="24" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 8a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6 1V11.5M10 14h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    back: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    send: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 10l14-6-6 14-2-6-6-2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    chev: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 5l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="m13.5 13.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    whatsapp: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>',
    phone: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2Z"/></svg>',
    email: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/></svg>',
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  function el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        node.setAttribute(k, attrs[k]);
      });
    }
    return node;
  }

  /** Set plain text preserving newlines (never innerHTML for untrusted text). */
  function setText(node, text) {
    node.textContent = "";
    String(text == null ? "" : text)
      .split("\n")
      .forEach(function (line, i) {
        if (i > 0) node.appendChild(document.createElement("br"));
        node.appendChild(document.createTextNode(line));
      });
  }

  function svg(node, markup) {
    node.innerHTML = markup; // static, app-authored SVG only
    return node;
  }

  /** A model-written href we are willing to follow: this store's own paths, or
   *  an explicit https page. Everything else (javascript:, data:, mailto
   *  built from model text) renders as plain text instead of a link. */
  function safeHref(raw) {
    var href = String(raw || "").trim();
    if (/^https:\/\/[^\s<>"']+$/i.test(href)) return href;
    if (/^\/[^\s<>"']*$/.test(href)) return href;
    return null;
  }

  var INLINE = /\[([^\]\n]{1,120})\]\((https:\/\/[^\s)]+|\/[^\s)]*)\)|(https:\/\/[^\s<>"']+)|\*\*([^*\n]{1,200})\*\*/g;

  /**
   * Bot text with the small amount of formatting the model actually produces:
   * **bold**, markdown links, and bare https URLs.
   *
   * Everything is built with createElement/createTextNode — the model's output
   * never becomes markup, so there is nothing to inject. Two visible bugs this
   * fixes: replies were arriving with literal `**` around product names, and a
   * URL in a reply (or quoted out of the merchant's own help articles)
   * rendered as dead text because bot bubbles were textContent only.
   */
  function appendInline(node, text) {
    var source = String(text == null ? "" : text);
    var at = 0;
    var m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(source)) !== null) {
      if (m.index > at) node.appendChild(document.createTextNode(source.slice(at, m.index)));
      var linkLabel = m[1];
      var linkHref = m[2];
      var bareUrl = m[3];
      var bold = m[4];
      if (bold !== undefined) {
        var strong = document.createElement("strong");
        strong.textContent = bold;
        node.appendChild(strong);
      } else {
        var href = safeHref(linkHref !== undefined ? linkHref : bareUrl);
        var label = linkLabel !== undefined ? linkLabel : bareUrl;
        if (href) {
          var a = el("a", null, { href: href, rel: "noopener noreferrer" });
          // A storefront path stays in this tab (the widget survives the
          // navigation); an external page must not take the shopper away.
          if (href.charAt(0) !== "/") a.setAttribute("target", "_blank");
          a.textContent = label;
          node.appendChild(a);
        } else {
          node.appendChild(document.createTextNode(m[0]));
        }
      }
      at = m.index + m[0].length;
    }
    if (at < source.length) node.appendChild(document.createTextNode(source.slice(at)));
  }

  /** Like setText, but renders the inline formatting above. Bot/agent bubbles
   *  only — a shopper's own message is always shown exactly as they typed it. */
  function setRichText(node, text) {
    node.textContent = "";
    String(text == null ? "" : text)
      .split("\n")
      .forEach(function (line, i) {
        if (i > 0) node.appendChild(document.createElement("br"));
        appendInline(node, line);
      });
  }

  // Bot/agent identity on message bubbles (spec 06 "Chat avatar"): with
  // "Store branding" the shell passes {url, name} from Settings → General →
  // Store information — logo (or the name's initials) as the avatar and the
  // name as the author caption. null → default chat icon, no caption.
  var botIdentity = null;
  function setAvatar(identity) {
    botIdentity = identity && (identity.url || identity.name) ? identity : null;
  }
  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    var a = parts[0].charAt(0);
    var b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
    return (a + b).toUpperCase();
  }
  function avatar() {
    var av = el("span", "cw-av");
    if (botIdentity && botIdentity.url) {
      av.className += " cw-av--img";
      av.appendChild(el("img", null, { src: botIdentity.url, alt: "" }));
      return av;
    }
    if (botIdentity && initials(botIdentity.name)) {
      av.className += " cw-av--initials";
      av.textContent = initials(botIdentity.name);
      return av;
    }
    return svg(av, ICONS.chat);
  }
  /** Author caption for bot bubbles: explicit label wins (e.g. "Team"). */
  function botLabel(label) {
    if (label) return label;
    return botIdentity && botIdentity.name ? botIdentity.name : null;
  }

  function themeVars(appearance) {
    if (appearance && appearance.colorMode === "solid") {
      return { c1: appearance.solid, c2: appearance.solid };
    }
    var g = (appearance && appearance.gradient) || {};
    return { c1: g.start || "#6d3bf5", c2: g.end || "#3b82f6" };
  }

  function applyTheme(node, appearance) {
    var v = themeVars(appearance);
    node.style.setProperty("--cw1", v.c1);
    node.style.setProperty("--cw2", v.c2);
  }

  function formatPrice(price, currency) {
    // A missing price is unknown, not free — rendering "$0.00" was worse than
    // rendering nothing (QA D18). Currency is the shop's; the number format
    // follows the shopper's locale, which is what they expect to read.
    if (price == null || price === "" || isNaN(Number(price))) return "";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
      }).format(Number(price));
    } catch (e) {
      return (currency || "USD") + " " + Number(price).toFixed(2);
    }
  }

  function welcomeText(template, customerName) {
    // typeof guard, not String(): a non-string here means the caller and this
    // builder disagree about the payload shape, and String({}) would paint
    // "[object Object]" into the shopper's bubble rather than failing quietly.
    var text = typeof template === "string" ? template : "";
    return text.replace(/\{\{\s*customer_name\s*\}\}/g, customerName || "there");
  }

  /* Campaign message merge tags (spec 12): {{customer_name}} + {{cart_total}}.
   * cart_total renders the formatted cart value when the shell fetched it,
   * else degrades to "your cart" so templates never show a raw tag. */
  function campaignText(template, opts) {
    var text = welcomeText(template, opts && opts.customerName);
    var totalText =
      opts && typeof opts.cartTotal === "number"
        ? formatPrice(opts.cartTotal, opts && opts.currency)
        : "your cart";
    return text.replace(/\{\{\s*cart_total\s*\}\}/g, totalText);
  }

  function digits(value) {
    return String(value || "").replace(/[^\d+]/g, "");
  }

  function contactHref(method) {
    var value = (method.countryCode || "") + (method.value || "");
    if (method.type === "whatsapp") return "https://wa.me/" + digits(value).replace(/^\+/, "");
    if (method.type === "phone") return "tel:" + digits(value);
    return "mailto:" + (method.value || "");
  }

  // ── launcher ─────────────────────────────────────────────────────────────
  /** Launcher button (style icon | label | icon_label, icon chat/help/custom). */
  function launcher(widget, callbacks) {
    var lc = ((widget.appearance || {}).launcher || {});
    var style = lc.style || "icon";
    var btn = el("button", "cw-launcher", {
      type: "button",
      "aria-label": lc.label || "Open chat",
      "aria-haspopup": "dialog",
    });
    if (style !== "icon") btn.classList.add("cw-launcher--pill");
    if (lc.bgColor) btn.style.background = lc.bgColor; // custom launcher bg (else brand CSS vars)

    var iconMarkup = null;
    if (style === "icon" || style === "icon_label") {
      if (lc.icon === "custom" && lc.customIconUrl) {
        var img = el("img", null, { src: lc.customIconUrl, alt: "" });
        btn.appendChild(img);
      } else {
        iconMarkup = ICONS[lc.icon === "help" ? "help" : "chat"];
        btn.appendChild(svg(el("span", null, { "aria-hidden": "true" }), iconMarkup));
      }
    }
    if (style === "label" || style === "icon_label") {
      var label = el("span");
      label.textContent = lc.label || "Chat with us";
      if (lc.labelColor) label.style.color = lc.labelColor; // custom label color (else white)
      btn.appendChild(label);
    }
    if (callbacks && callbacks.onToggle) btn.addEventListener("click", callbacks.onToggle);
    return btn;
  }

  // ── header ───────────────────────────────────────────────────────────────
  /** Panel header. state: {showBack}. cb: {onBack, onClose}. */
  function header(config, state, cb) {
    var head = el("div", "cw-head");
    var widget = config.widget;

    var back = el("button", "cw-back", { type: "button", "aria-label": "Back" });
    svg(back, ICONS.back);
    back.style.display = state.showBack ? "" : "none";
    if (cb && cb.onBack) back.addEventListener("click", cb.onBack);
    head.appendChild(back);

    var brand = el("div", "cw-brand");
    // No logo uploaded → no logo chip at all (no icon fallback).
    if (widget.header.logoUrl) {
      var logo = el("span", "cw-logo");
      logo.appendChild(el("img", null, { src: widget.header.logoUrl, alt: "" }));
      brand.appendChild(logo);
    }
    var names = el("div");
    var title = el("div", "cw-title");
    title.textContent = widget.header.name || "ChatConvert";
    var sub = el("div", "cw-sub");
    sub.textContent = widget.header.description || "";
    names.appendChild(title);
    names.appendChild(sub);
    brand.appendChild(names);
    head.appendChild(brand);

    var close = el("button", "cw-x", { type: "button", "aria-label": "Close chat" });
    svg(close, ICONS.close);
    if (cb && cb.onClose) close.addEventListener("click", cb.onClose);
    head.appendChild(close);

    return { el: head, backEl: back, titleEl: title };
  }

  // ── home screen ──────────────────────────────────────────────────────────
  /**
   * cb: {onOpenChat, onOpenTracking, onOpenFaq(faq), onContact(method)}.
   * Each block branches on its settings toggle; all off → empty state.
   */
  function homeScreen(config, state, cb) {
    var widget = config.widget;
    var home = el("div", "cw-home");
    home.style.display = "flex";
    home.style.flexDirection = "column";
    home.style.gap = "12px";
    var hasBlock = false;

    var showContactBlock =
      widget.liveChat || (widget.contactMethods.enabled && widget.contactMethods.items.length > 0);
    if (showContactBlock) {
      hasBlock = true;
      var blk = el("div", "cw-blk");
      var t = el("div", "cw-blk-t");
      t.textContent = "Contact us";
      blk.appendChild(t);

      if (widget.chatStatus && config.availability) {
        var status = el("div", "cw-status cw-status--" + config.availability.status);
        status.appendChild(el("span", "cw-d"));
        status.appendChild(document.createTextNode(config.availability.message || ""));
        blk.appendChild(status);
      }

      var actions = el("div", "cw-actions");
      if (widget.liveChat) {
        var chatNow = el("button", "cw-chatnow", { type: "button" });
        svg(chatNow, ICONS.send);
        chatNow.appendChild(document.createTextNode("Chat now"));
        if (cb && cb.onOpenChat) chatNow.addEventListener("click", cb.onOpenChat);
        actions.appendChild(chatNow);
      }
      if (widget.contactMethods.enabled) {
        widget.contactMethods.items
          .slice()
          .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
          .forEach(function (method) {
            var chip = el("a", "cw-cm cw-cm--" + method.type, {
              href: contactHref(method),
              "aria-label": method.type,
              target: method.type === "whatsapp" ? "_blank" : "_self",
              rel: "noopener",
            });
            svg(chip, ICONS[method.type] || ICONS.email);
            if (cb && cb.onContact) {
              chip.addEventListener("click", function () { cb.onContact(method); });
            }
            actions.appendChild(chip);
          });
      }
      blk.appendChild(actions);
      home.appendChild(blk);
    }

    if (widget.orderTracking) {
      hasBlock = true;
      var row = el("button", "cw-blk cw-row", { type: "button" });
      var left = el("div");
      var rt = el("div", "cw-blk-t");
      rt.textContent = "Order tracking";
      var rs = el("div", "cw-row-sub");
      rs.textContent = "Track your orders";
      left.appendChild(rt);
      left.appendChild(rs);
      row.appendChild(left);
      row.appendChild(svg(el("span"), ICONS.chev));
      if (cb && cb.onOpenTracking) row.addEventListener("click", cb.onOpenTracking);
      home.appendChild(row);
    }

    if (widget.faqs) {
      hasBlock = true;
      var faqBlk = el("div", "cw-blk");
      var search = el("div", "cw-search");
      var input = el("input", null, { type: "search", placeholder: "Search for help", "aria-label": "Search for help" });
      search.appendChild(input);
      search.appendChild(svg(el("span"), ICONS.search));
      faqBlk.appendChild(search);

      var list = el("div", "cw-faq-list");
      var renderList = function (faqs) {
        list.textContent = "";
        faqs.forEach(function (faq) {
          var item = el("button", "cw-faq", { type: "button" });
          var q = el("span");
          q.textContent = faq.question;
          item.appendChild(q);
          item.appendChild(svg(el("span"), ICONS.chev));
          if (cb && cb.onOpenFaq) {
            item.addEventListener("click", function () { cb.onOpenFaq(faq); });
          }
          list.appendChild(item);
        });
        if (faqs.length === 0) {
          var none = el("div", "cw-row-sub");
          none.textContent = "No matching questions.";
          list.appendChild(none);
        }
      };
      var featured = (config.featuredFaqs || []).slice();
      if (featured.length > 0) {
        renderList(featured);
      } else {
        var noneYet = el("div", "cw-row-sub");
        noneYet.textContent = "No featured questions yet.";
        list.appendChild(noneYet);
      }
      // The search listener is registered even with zero featured FAQs — it
      // used to live inside the `featured.length > 0` branch, so a shop that
      // published FAQs without featuring any showed a dead search box (QA
      // D14). The server search covers ALL published FAQs.
      var clientFilter = function (q) {
        return featured.filter(function (f) { return f.question.toLowerCase().indexOf(q) !== -1; });
      };
      var searchSeq = 0;
      var searchTimer = null;
      input.addEventListener("input", function () {
        var q = input.value.trim().toLowerCase();
        if (searchTimer) clearTimeout(searchTimer);
        if (!q) {
          searchSeq++;
          if (featured.length > 0) renderList(featured);
          else {
            list.innerHTML = "";
            var empty = el("div", "cw-row-sub");
            empty.textContent = "No featured questions yet.";
            list.appendChild(empty);
          }
          return;
        }
        // Instant client filter over featured, then (debounced) the server
        // search across ALL published FAQs replaces it when it lands.
        renderList(clientFilter(q));
        if (!cb || !cb.onFaqSearch) return;
        var seq = ++searchSeq;
        searchTimer = setTimeout(function () {
          cb.onFaqSearch(q).then(function (faqs) {
            if (seq !== searchSeq || !faqs) return; // stale or failed → keep client results
            renderList(faqs);
          });
        }, 250);
      });
      faqBlk.appendChild(list);
      home.appendChild(faqBlk);
    }

    if (!hasBlock) {
      var empty = el("div", "cw-empty");
      empty.textContent = "Enable a feature to see it here.";
      home.appendChild(empty);
    }
    return home;
  }

  /** FAQ answer view (merchant-authored HTML from admin — trusted content). */
  function faqAnswer(faq) {
    var blk = el("div", "cw-blk");
    var t = el("div", "cw-blk-t");
    t.textContent = faq.question;
    blk.appendChild(t);
    if (faq.category) {
      var c = el("div", "cw-faq-cat");
      c.textContent = faq.category;
      blk.appendChild(c);
    }
    var body = el("div", "cw-faq-answer");
    body.innerHTML = faq.answerHtml || "";
    blk.appendChild(body);
    return blk;
  }

  // ── chat screen pieces ───────────────────────────────────────────────────
  /**
   * kind: "user" (shopper), "bot" (ai/agent), "sys". content is plain text.
   * label (optional): small author caption above the bubble (e.g. "Team").
   */
  function messageBubble(kind, content, label) {
    var row = el("div", "cw-msg cw-msg--" + (kind === "user" ? "in" : kind === "sys" ? "sys" : "out"));
    if (kind === "bot") {
      row.appendChild(avatar());
    }
    var bubble = el("div", "cw-bubble" + (kind === "user" ? " cw-bubble--user" : kind === "sys" ? " cw-bubble--sys" : ""));
    // The shopper's own words go in verbatim; a reply gets its links and bold
    // rendered (see setRichText).
    if (kind === "user") setText(bubble, content);
    else setRichText(bubble, content);
    appendWithLabel(row, bubble, kind === "bot" ? botLabel(label) : label);
    return { el: row, bubbleEl: bubble };
  }

  /** Bubble + optional author caption (store name / "Team") above it. */
  function appendWithLabel(row, bubble, label) {
    if (label) {
      var wrap = el("div", "cw-msg-wrap");
      var meta = el("div", "cw-msg-meta");
      meta.textContent = label;
      wrap.appendChild(meta);
      wrap.appendChild(bubble);
      row.appendChild(wrap);
    } else {
      row.appendChild(bubble);
    }
  }

  /** Canned bubble whose body is merchant-authored HTML (starter answers). */
  function htmlBubble(html) {
    var row = el("div", "cw-msg cw-msg--out");
    row.appendChild(avatar());
    var bubble = el("div", "cw-bubble");
    bubble.innerHTML = html || "";
    appendWithLabel(row, bubble, botLabel(null));
    return { el: row, bubbleEl: bubble };
  }

  function typingIndicator() {
    var row = el("div", "cw-msg cw-msg--out", { "aria-label": "Assistant is typing" });
    row.appendChild(avatar());
    var dots = el("div", "cw-bubble cw-typing");
    dots.appendChild(el("span"));
    dots.appendChild(el("span"));
    dots.appendChild(el("span"));
    row.appendChild(dots);
    return row;
  }

  /**
   * Buttons that open a screen of the widget itself (order tracking, contact,
   * help), chosen by the agent from what the shop has switched on.
   *
   * Replaces the agent describing storefront navigation it cannot see — it
   * once told a shopper to "click the Track navigation", which does not exist:
   * order tracking lives in this panel. cb.onAction(action).
   */
  function actionChips(actions, cb) {
    var wrap = el("div", "cw-actions-row");
    actions.forEach(function (action) {
      if (!action || !action.key) return;
      var chip = el("button", "cw-chip cw-chip--action", { type: "button" });
      // The label is written by the server, never by the model.
      chip.textContent = action.label || "Open";
      if (cb && cb.onAction) {
        chip.addEventListener("click", function () { cb.onAction(action); });
      }
      wrap.appendChild(chip);
    });
    return wrap;
  }

  /** Starter chips. cb.onStarter(starter). */
  function starterChips(starters, cb) {
    var wrap = el("div", "cw-starters");
    starters
      .slice()
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .forEach(function (starter) {
        if (!starter.question) return;
        var chip = el("button", "cw-chip", { type: "button" });
        chip.textContent = ((starter.emoji || "") + " " + starter.question).trim();
        if (cb && cb.onStarter) {
          chip.addEventListener("click", function () { cb.onStarter(starter); });
        }
        wrap.appendChild(chip);
      });
    return wrap;
  }

  /** Product cards row. cb: {onView(card), onAdd(card)}. */
  function productCards(cards, currency, cb) {
    var wrap = el("div", "cw-cards", { role: "list" });
    cards.forEach(function (card) {
      var item = el("div", "cw-card", { role: "listitem" });
      if (card.imageUrl) {
        item.appendChild(el("img", "cw-card-img", { src: card.imageUrl, alt: card.title, loading: "lazy" }));
      } else {
        item.appendChild(el("div", "cw-card-img"));
      }
      var body = el("div", "cw-card-body");
      var t = el("div", "cw-card-t");
      t.textContent = card.title;
      var p = el("div", "cw-card-p");
      p.textContent = formatPrice(card.price, currency);
      body.appendChild(t);
      body.appendChild(p);

      var actions = el("div", "cw-card-actions");
      var view = el("a", "cw-btn cw-btn--ghost", { href: "/products/" + card.handle });
      view.textContent = "View";
      if (cb && cb.onView) {
        view.addEventListener("click", function () { cb.onView(card); });
      }
      var add = el("button", "cw-btn cw-btn--primary", { type: "button" });
      add.textContent = "Add to cart";
      if (cb && cb.onAdd) {
        // The add is a network round trip. Without a pending state the button
        // sat idle until the drawer opened, which reads as "nothing happened"
        // — so shoppers clicked again and added the item twice.
        var busy = false;
        var setPending = function (on) {
          if (on === busy) return;
          busy = on;
          add.disabled = on;
          add.setAttribute("aria-busy", on ? "true" : "false");
          if (on) {
            add.textContent = "";
            add.appendChild(el("span", "cw-spin", { "aria-hidden": "true" }));
            add.appendChild(document.createTextNode("Adding…"));
          } else {
            add.textContent = "Add to cart";
          }
        };
        add.addEventListener("click", function () {
          if (busy) return;
          setPending(true);
          var done = false;
          var release = function () {
            if (done) return;
            done = true;
            setPending(false);
          };
          var result = cb.onAdd(card, { release: release });
          // A handler that navigates away never settles; one that returns a
          // promise releases the button when the cart call finishes.
          if (result && typeof result.then === "function") result.then(release, release);
        });
      }
      actions.appendChild(view);
      actions.appendChild(add);
      body.appendChild(actions);
      item.appendChild(body);
      wrap.appendChild(item);
    });
    return wrap;
  }

  /** Message input bar. cb.onSend(text).
   *  The field is a textarea, not an input, so a long message grows the box
   *  instead of scrolling sideways — up to COMPOSER_MAX_ROWS lines, then it
   *  scrolls. (The Shift+Enter branch below was already written but was dead
   *  on an <input>, which cannot hold a newline.) */
  var COMPOSER_MAX_ROWS = 3;
  function inputBar(cb) {
    var bar = el("div", "cw-input");
    var input = el("textarea", "cw-composer", {
      rows: "1",
      placeholder: "Type your message…",
      "aria-label": "Type your message",
      maxlength: "2000",
    });
    var send = el("button", "cw-send", { type: "button", "aria-label": "Send message" });
    svg(send, ICONS.send);
    // Height is measured from the LIVE computed style rather than a constant:
    // the merchant's theme font and the 16px mobile override both change the
    // line height, so a hard-coded px cap would be wrong on half of stores.
    function autoGrow() {
      input.style.height = "auto";
      // The bar is created display:none and only shown on the chat screen; a
      // hidden textarea measures 0, which would lock in a collapsed height.
      // Leave the CSS one-row height alone and let the next keystroke size it.
      if (!input.scrollHeight) {
        input.style.height = "";
        return;
      }
      var cs = window.getComputedStyle(input);
      var line = parseFloat(cs.lineHeight);
      if (!line) line = parseFloat(cs.fontSize) * 1.45 || 18;
      // scrollHeight covers content + padding; border-box height adds borders.
      var chrome =
        (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      var max = Math.ceil(line * COMPOSER_MAX_ROWS + pad + chrome);
      var full = input.scrollHeight + chrome;
      input.style.height = Math.min(full, max) + "px";
      input.style.overflowY = full > max ? "auto" : "hidden";
    }
    function submit() {
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      autoGrow();
      if (cb && cb.onSend) cb.onSend(text);
    }
    send.addEventListener("click", submit);
    input.addEventListener("input", autoGrow);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    bar.appendChild(input);
    bar.appendChild(send);
    // The first measurement has to wait until the bar is in the document —
    // getComputedStyle on a detached node reports no line-height.
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(autoGrow);
    return { el: bar, inputEl: input, sendEl: send, autoGrow: autoGrow };
  }

  // ── order tracking screen ────────────────────────────────────────────────
  /** cb.onTrack({tab, value, contactMethod, contact}).
   *  Default mode → order-number form only; custom/integration modes add the
   *  Tracking-number tab (config.orderTracking.mode, spec 16). */
  function trackingScreen(config, state, cb) {
    var mode = (config && config.orderTracking && config.orderTracking.mode) || "default";
    var withTrackingTab = mode !== "default";

    var screen = el("div", "cw-tracking");
    screen.style.display = "flex";
    screen.style.flexDirection = "column";
    screen.style.gap = "14px";

    // The form swaps out for the result card once a lookup succeeds.
    var form = el("div", "cw-ot-formwrap");
    form.style.display = "flex";
    form.style.flexDirection = "column";
    form.style.gap = "14px";

    var tabOrder = el("button", null, { type: "button", role: "tab", "aria-selected": "true" });
    tabOrder.textContent = "Order number";
    var tabTracking = el("button", null, { type: "button", role: "tab", "aria-selected": "false" });
    tabTracking.textContent = "Tracking number";
    if (withTrackingTab) {
      var tabs = el("div", "cw-tabs", { role: "tablist" });
      tabs.appendChild(tabOrder);
      tabs.appendChild(tabTracking);
      form.appendChild(tabs);
    }

    var lbl = el("div", "cw-lbl");
    lbl.textContent = "Order number";
    var numInput = el("input", "cw-inp", { type: "text", placeholder: "e.g. 1001", "aria-label": "Order number" });
    var numWrap = el("div");
    numWrap.appendChild(lbl);
    numWrap.appendChild(numInput);
    form.appendChild(numWrap);

    var radios = el("div", "cw-radios", { role: "radiogroup", "aria-label": "Contact method" });
    var current = { tab: "order", method: "email" };
    function radio(value, label, checked) {
      var wrap = el("label", "cw-radio");
      var input = el("input", null, { type: "radio", name: "cw-ot-method", value: value });
      input.checked = checked;
      input.addEventListener("change", function () {
        current.method = value;
        contactInput.value = ""; // an email is never a valid phone (and vice versa)
        contactInput.placeholder = value === "phone" ? "+1 555 000 0000" : "example@gmail.com";
        contactInput.setAttribute("aria-label", value === "phone" ? "Phone number" : "Email address");
      });
      wrap.appendChild(input);
      wrap.appendChild(el("span", "cw-dot"));
      wrap.appendChild(document.createTextNode(label));
      return wrap;
    }
    var contactInput = el("input", "cw-inp", {
      type: "text",
      placeholder: "example@gmail.com",
      "aria-label": "Email address",
    });
    radios.appendChild(radio("email", "Email address", true));
    radios.appendChild(radio("phone", "Phone number", false));
    form.appendChild(radios);
    form.appendChild(contactInput);

    function selectTab(tab) {
      if (current.tab === tab) return; // re-clicking the active tab keeps input
      current.tab = tab;
      var isTracking = tab === "tracking";
      tabOrder.setAttribute("aria-selected", String(!isTracking));
      tabTracking.setAttribute("aria-selected", String(isTracking));
      lbl.textContent = isTracking ? "Tracking number" : "Order number";
      numInput.value = ""; // order and tracking numbers are different values
      numInput.placeholder = isTracking ? "e.g. AA12345" : "e.g. 1001";
      numInput.setAttribute("aria-label", lbl.textContent);
      radios.style.display = isTracking ? "none" : "flex";
      contactInput.style.display = isTracking ? "none" : "";
      err.style.display = "none";
      clearResults();
    }
    tabOrder.addEventListener("click", function () { selectTab("order"); });
    tabTracking.addEventListener("click", function () { selectTab("tracking"); });

    var err = el("div", "cw-err");
    err.style.display = "none";
    form.appendChild(err);
    numInput.addEventListener("input", function () { err.style.display = "none"; });
    contactInput.addEventListener("input", function () { err.style.display = "none"; });

    var track = el("button", "cw-track", { type: "button" });
    track.textContent = "Track";

    // In-widget results (order-number lookups render status cards here).
    var results = el("div", "cw-ot-results");
    results.style.display = "none";

    function clearResults() {
      results.textContent = "";
      results.style.display = "none";
    }

    var api = {
      loading: function (on) {
        track.disabled = !!on;
        track.textContent = on ? "Tracking…" : "Track";
      },
      fail: function (text) {
        clearResults();
        form.style.display = "flex";
        err.textContent = text;
        err.style.display = "";
      },
      show: function (node) {
        err.style.display = "none";
        api.loading(false); // reset the button for when the form returns
        form.style.display = "none";
        results.textContent = "";
        results.appendChild(node);
        var again = el("button", "cw-ot-again", { type: "button" });
        again.textContent = "Track another order";
        again.addEventListener("click", function () {
          clearResults();
          form.style.display = "flex";
          numInput.focus();
        });
        results.appendChild(again);
        results.style.display = "flex";
      },
    };

    track.addEventListener("click", function () {
      var value = numInput.value.trim();
      if (!value) {
        err.textContent = current.tab === "tracking"
          ? "Please enter your tracking number."
          : "Please enter your order number.";
        err.style.display = "";
        numInput.focus();
        return;
      }
      var contact = contactInput.value.trim();
      if (current.tab === "order") {
        if (current.method === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
          err.textContent = "Please enter a valid email address.";
          err.style.display = "";
          contactInput.focus();
          return;
        }
        if (current.method === "phone" && contact.replace(/\D/g, "").length < 10) {
          err.textContent = "Please enter a valid phone number.";
          err.style.display = "";
          contactInput.focus();
          return;
        }
      }
      err.style.display = "none";
      if (cb && cb.onTrack) {
        cb.onTrack(
          { tab: current.tab, value: value, contactMethod: current.method, contact: contact },
          api,
        );
      }
    });
    form.appendChild(track);
    screen.appendChild(form);
    screen.appendChild(results);
    return screen;
  }

  // ── order status result (spec 05 delta: in-widget lookup, no login) ──────
  function fmtDate(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    var mm = String(d.getMonth() + 1);
    var dd = String(d.getDate());
    if (mm.length < 2) mm = "0" + mm;
    if (dd.length < 2) dd = "0" + dd;
    return mm + "/" + dd + "/" + d.getFullYear();
  }

  function statusLabel(status) {
    if (!status) return "";
    var s = String(status).toLowerCase().replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function statusChip(status) {
    var chip = el("span", "cw-ot-chip");
    var label = statusLabel(status) || "—";
    chip.textContent = label;
    var l = label.toLowerCase();
    if (l === "fulfilled" || l === "marked as fulfilled" || l === "delivered") {
      chip.className += " cw-ot-chip--ok";
    }
    return chip;
  }

  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    var hh = String(d.getHours());
    var mi = String(d.getMinutes());
    if (hh.length < 2) hh = "0" + hh;
    if (mi.length < 2) mi = "0" + mi;
    return fmtDate(iso) + " " + hh + ":" + mi;
  }

  function addGridRow(grid, label, value) {
    var l = el("div", "cw-ot-l");
    l.textContent = label;
    var v = el("div", "cw-ot-v");
    if (typeof value === "string") v.textContent = value;
    else v.appendChild(value);
    grid.appendChild(l);
    grid.appendChild(v);
  }

  // 17Track main statuses → shopper-friendly labels (integration mode).
  var SHIPMENT_LABELS = {
    NotFound: "No updates yet",
    InfoReceived: "Info received",
    InTransit: "In transit",
    Expired: "Expired",
    AvailableForPickup: "Available for pickup",
    OutForDelivery: "Out for delivery",
    DeliveryFailure: "Delivery failure",
    Delivered: "Delivered",
    Exception: "Exception",
  };

  function shipmentChip(status) {
    var chip = el("span", "cw-ot-chip");
    chip.textContent = SHIPMENT_LABELS[status] || statusLabel(status) || "No updates yet";
    if (status === "Delivered") chip.className += " cw-ot-chip--ok";
    else if (status === "DeliveryFailure" || status === "Exception" || status === "Expired") chip.className += " cw-ot-chip--warn";
    else if (status === "InTransit" || status === "OutForDelivery" || status === "AvailableForPickup") chip.className += " cw-ot-chip--info";
    return chip;
  }

  /** order: /order-track response payload. config: widget config (currency fallback). */
  function orderStatusCard(order, config) {
    var wrap = el("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "12px";

    var head = el("div", "cw-ot-card");
    var headrow = el("div", "cw-ot-headrow");
    var name = el("div", "cw-ot-name");
    name.textContent = "Order " + order.name;
    headrow.appendChild(name);
    headrow.appendChild(statusChip(order.status));
    var total = el("div", "cw-ot-total");
    total.textContent = formatPrice(order.total, order.currency || (config && config.currency) || "USD");
    headrow.appendChild(total);
    head.appendChild(headrow);
    var sub = el("div", "cw-ot-sub");
    sub.textContent =
      order.itemsCount + " item" + (order.itemsCount === 1 ? "" : "s") + " • " + fmtDate(order.createdAt);
    head.appendChild(sub);
    wrap.appendChild(head);

    // One card per fulfillment; unfulfilled orders get a single card with the
    // order-level status and N/A tracking rows (same layout as the design).
    var fulfillments = order.fulfillments && order.fulfillments.length ? order.fulfillments : [null];
    fulfillments.forEach(function (f, idx) {
      var card = el("div", "cw-ot-card");

      var thumbs = el("div", "cw-ot-thumbs");
      (order.items || []).slice(0, 4).forEach(function (item) {
        var t = el("div", "cw-ot-thumb");
        if (item.image) t.appendChild(el("img", null, { src: item.image, alt: item.title || "" }));
        if (item.quantity > 0) {
          var q = el("span", "cw-ot-qty");
          q.textContent = String(item.quantity);
          t.appendChild(q);
        }
        thumbs.appendChild(t);
      });
      card.appendChild(thumbs);

      var chipRow = el("div");
      chipRow.appendChild(statusChip(f ? f.status : order.status));
      card.appendChild(chipRow);

      var updated = el("div", "cw-ot-muted");
      updated.textContent = "Last updated: " + fmtDate(f ? f.updatedAt : order.createdAt);
      card.appendChild(updated);

      card.appendChild(el("div", "cw-ot-divider"));

      var title = el("div", "cw-ot-title");
      title.textContent = "Tracking information";
      card.appendChild(title);

      var grid = el("div", "cw-ot-grid");
      var carrier =
        (f && f.company) || (order.shipment && order.shipment.carrier) || "N/A";
      addGridRow(grid, "Shipping carrier:", carrier);
      if (f && f.trackingNumber && f.trackingUrl) {
        var link = el("a", null, { href: f.trackingUrl, target: "_blank", rel: "noopener" });
        link.textContent = f.trackingNumber;
        addGridRow(grid, "Tracking number:", link);
      } else {
        addGridRow(grid, "Tracking number:", (f && f.trackingNumber) || "N/A");
      }
      addGridRow(grid, "Fulfilled date:", f ? fmtDate(f.createdAt) : "N/A");
      card.appendChild(grid);

      // Real-time provider status (integration mode) on the first card.
      if (idx === 0 && order.shipment) {
        card.appendChild(el("div", "cw-ot-divider"));
        var st = el("div", "cw-ot-title");
        st.textContent = "Shipment status";
        card.appendChild(st);
        var chipRow2 = el("div");
        chipRow2.appendChild(shipmentChip(order.shipment.status));
        card.appendChild(chipRow2);
        var le = order.shipment.latestEvent;
        if (le) {
          var evd = el("div", "cw-ot-v");
          evd.textContent = le.description + (le.location ? " — " + le.location : "");
          card.appendChild(evd);
          if (le.time) {
            var evt = el("div", "cw-ot-muted");
            evt.textContent = fmtDateTime(le.time);
            card.appendChild(evt);
          }
        }
      }

      wrap.appendChild(card);
    });

    return wrap;
  }

  /** Bare tracking-number result (integration mode): real-time provider
   *  status card. shipment: /order-track {trackingNumber} response payload. */
  function shipmentCard(number, shipment) {
    var wrap = el("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "12px";

    var card = el("div", "cw-ot-card");
    var headrow = el("div", "cw-ot-headrow");
    var name = el("div", "cw-ot-name");
    name.textContent = number;
    headrow.appendChild(name);
    headrow.appendChild(shipmentChip(shipment.status));
    card.appendChild(headrow);

    var grid = el("div", "cw-ot-grid");
    addGridRow(grid, "Shipping carrier:", shipment.carrier || "N/A");
    addGridRow(
      grid,
      "Last update:",
      shipment.latestEvent && shipment.latestEvent.time
        ? fmtDateTime(shipment.latestEvent.time)
        : "N/A",
    );
    card.appendChild(grid);

    if (shipment.events && shipment.events.length) {
      card.appendChild(el("div", "cw-ot-divider"));
      var title = el("div", "cw-ot-title");
      title.textContent = "Recent updates";
      card.appendChild(title);
      var list = el("div", "cw-ot-events");
      shipment.events.forEach(function (e) {
        var row = el("div", "cw-ot-ev");
        var desc = el("div", "cw-ot-v");
        desc.textContent = e.description + (e.location ? " — " + e.location : "");
        row.appendChild(desc);
        if (e.time) {
          var time = el("div", "cw-ot-muted");
          time.textContent = fmtDateTime(e.time);
          row.appendChild(time);
        }
        list.appendChild(row);
      });
      card.appendChild(list);
    } else {
      var none = el("div", "cw-ot-muted");
      none.textContent = "No tracking events yet — check back soon.";
      card.appendChild(none);
    }

    wrap.appendChild(card);
    return wrap;
  }

  // ── pre-chat form ────────────────────────────────────────────────────────
  /**
   * modes guest/anonymous/both. state: {skippable} (both mode → skip allowed).
   * cb: {onSubmit({email,name,phone,optIn}), onSkip}.
   */
  function prechatForm(config, state, cb) {
    var prechat = config.widget.prechat;
    var form = el("form", "cw-form", { novalidate: "novalidate" });

    if (prechat.description) {
      var desc = el("div", "cw-form-desc");
      desc.textContent = prechat.description;
      form.appendChild(desc);
    }

    var inputs = {};
    var fieldDefs = { email: "Email address", name: "Name", phone: "Phone number" };
    var fields = prechat.fields && prechat.fields.length ? prechat.fields : [{ key: "email", required: true }];
    fields.forEach(function (f) {
      var wrap = el("div", "cw-field");
      var label = el("label");
      label.textContent = fieldDefs[f.key] + (f.required ? "" : " (optional)");
      var input = el("input", "cw-inp", {
        type: f.key === "email" ? "email" : f.key === "phone" ? "tel" : "text",
        name: f.key,
        placeholder: fieldDefs[f.key],
      });
      if (f.required) input.setAttribute("required", "required");
      wrap.appendChild(label);
      wrap.appendChild(input);
      form.appendChild(wrap);
      inputs[f.key] = { input: input, required: !!f.required };
    });

    var optInInput = null;
    if (prechat.marketingOptIn) {
      var check = el("label", "cw-check");
      optInInput = el("input", null, { type: "checkbox" });
      check.appendChild(optInInput);
      var ct = el("span");
      ct.textContent = "Keep me updated with news and offers";
      check.appendChild(ct);
      form.appendChild(check);
    }

    if (prechat.disclaimer && prechat.disclaimer.enabled) {
      var disc = el("div", "cw-disclaimer");
      disc.innerHTML = prechat.disclaimer.html || ""; // merchant-authored
      form.appendChild(disc);
    }

    var err = el("div", "cw-err");
    err.style.display = "none";
    form.appendChild(err);

    var submit = el("button", "cw-chatnow", { type: "submit" });
    submit.style.width = "100%";
    submit.textContent = "Start chat";
    form.appendChild(submit);

    if (state && state.skippable) {
      var skip = el("button", "cw-skip", { type: "button" });
      skip.textContent = "Continue without sharing";
      if (cb && cb.onSkip) skip.addEventListener("click", cb.onSkip);
      form.appendChild(skip);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var data = { optIn: !!(optInInput && optInInput.checked) };
      var problem = null;
      Object.keys(inputs).forEach(function (key) {
        var value = inputs[key].input.value.trim();
        if (inputs[key].required && !value) problem = fieldDefs[key] + " is required.";
        data[key] = value || undefined;
      });
      if (!problem && inputs.email) {
        var email = data.email || "";
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          problem = "Please enter a valid email address.";
        }
      }
      if (problem) {
        err.textContent = problem;
        err.style.display = "";
        return;
      }
      err.style.display = "none";
      if (cb && cb.onSubmit) cb.onSubmit(data);
    });

    return form;
  }

  // ── handover leave-a-message form (spec 10) ──────────────────────────────
  /**
   * formCfg: {fields:[{key,required}], replyTime, formMessage, postSubmitMessage}
   * (the HandoverFrameData.form payload). cb.onSubmit(values, {fail(text)}).
   * The formMessage itself arrives as a normal message frame — this renders
   * only the fields + expected-reply-time note.
   */
  function handoverForm(formCfg, cb) {
    var LABELS = {
      email: "Email address",
      issue: "How can we help?",
      orderNumber: "Order number",
      phone: "Phone number",
    };
    var TYPES = { email: "email", phone: "tel" };
    var REPLY = {
      "24h": "within 24 hours",
      "12h": "within 12 hours",
      "48h": "within 48 hours",
      same_day: "the same day",
    };
    var form = el("form", "cw-form", { novalidate: "novalidate" });

    if (formCfg.replyTime && REPLY[formCfg.replyTime]) {
      var note = el("div", "cw-form-desc");
      note.textContent = "We usually reply " + REPLY[formCfg.replyTime] + ".";
      form.appendChild(note);
    }

    var inputs = {};
    (formCfg.fields || []).forEach(function (f) {
      var wrap = el("div", "cw-field");
      var inputId = "cw-hf-" + f.key + "-" + Math.random().toString(36).slice(2, 7);
      var label = el("label");
      label.htmlFor = inputId;
      label.textContent = (LABELS[f.key] || f.key) + (f.required ? "" : " (optional)");
      var input;
      if (f.key === "issue") {
        input = el("textarea", "cw-inp", {
          name: f.key,
          id: inputId,
          rows: "3",
          maxlength: "2000",
          placeholder: "Tell us what you need help with",
        });
      } else {
        input = el("input", "cw-inp", {
          type: TYPES[f.key] || "text",
          name: f.key,
          id: inputId,
          placeholder: LABELS[f.key] || f.key,
        });
      }
      wrap.appendChild(label);
      wrap.appendChild(input);
      form.appendChild(wrap);
      inputs[f.key] = { input: input, required: !!f.required };
    });

    var err = el("div", "cw-err", { role: "alert", "aria-live": "polite" });
    err.style.display = "none";
    form.appendChild(err);

    var submit = el("button", "cw-chatnow", { type: "submit" });
    submit.style.width = "100%";
    submit.textContent = "Send message";
    form.appendChild(submit);

    function fail(text) {
      err.textContent = text;
      err.style.display = "";
      submit.disabled = false;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var values = {};
      var problem = null;
      Object.keys(inputs).forEach(function (key) {
        var value = inputs[key].input.value.trim();
        if (inputs[key].required && !value) problem = (LABELS[key] || key) + " is required.";
        if (value) values[key] = value;
      });
      if (!problem && inputs.email) {
        var email = values.email || "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          problem = "Please enter a valid email address.";
        }
      }
      if (problem) return fail(problem);
      err.style.display = "none";
      submit.disabled = true;
      if (cb && cb.onSubmit) cb.onSubmit(values, { fail: fail });
    });

    return form;
  }

  // ── satisfaction survey ──────────────────────────────────────────────────
  /** survey: settings.survey {format, intro, thanks}. cb.onRate(rating 1-5). */
  function surveyPrompt(survey, cb) {
    var blk = el("div", "cw-blk cw-survey");
    var intro = el("div", "cw-blk-t");
    intro.textContent = survey.intro || "How was your experience?";
    blk.appendChild(intro);

    var isEmoji = survey.format === "emoji";
    var scale = isEmoji ? ["😡", "😕", "😐", "🙂", "🤩"] : ["★", "★", "★", "★", "★"];
    var row = el("div", "cw-stars", { role: "radiogroup", "aria-label": "Rate your experience" });
    scale.forEach(function (glyph, i) {
      // Star glyphs are CSS-colorable (yellow); emoji rely on grayscale.
      var b = el("button", isEmoji ? "cw-star cw-star-emoji" : "cw-star", {
        type: "button",
        role: "radio",
        "aria-checked": "false",
        "aria-label": i + 1 + " out of 5",
      });
      b.textContent = glyph;
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(row.children, function (child, j) {
          child.setAttribute("aria-checked", String(j <= i));
        });
        if (cb && cb.onRate) cb.onRate(i + 1);
        intro.textContent = survey.thanks || "Thank you for your feedback!";
        row.style.pointerEvents = "none";
      });
      row.appendChild(b);
    });
    blk.appendChild(row);
    return blk;
  }

  // ── proactive campaign bubble (spec 12) ──────────────────────────────────
  /* One builder for every proactive-chat message type. Shared verbatim by the
   * storefront shell and the admin "Message Preview" card, so what a merchant
   * approves in the editor is byte-for-byte what a shopper sees.
   *
   * campaign — the lean widget shape from campaigns.server.ts:
   *   { id, templateType, message: {...}, appearance: {...}, products: [] }
   * opts     — { currency, customerName, cartTotal, anchor, preview }
   *            anchor = the page's product (Smart Product Page chips + the
   *            {{ option }} merge tag); preview:true disables network actions.
   * cb       — { onDismiss, onCta(api, seed), onView(card, api),
   *              onLead(values, api), onSelectVariant(option) }
   *   api.confirm(text) swaps the body for a confirmation and drops the
   *   actions; api.showLead() advances the discount flow to the lead form.
   */

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Merge tags inside the merchant's rich text. The HTML itself was allow-list
   * sanitized server-side, but the SUBSTITUTED values are shopper data — they
   * are escaped here so a customer named `<b>` can't inject markup. */
  function campaignHtml(html, opts) {
    opts = opts || {};
    var name = escapeHtml(opts.customerName || "there");
    var total =
      typeof opts.cartTotal === "number"
        ? escapeHtml(formatPrice(opts.cartTotal, opts.currency))
        : "your cart";
    // Same guard as welcomeText — never stringify a non-string into markup.
    return (typeof html === "string" ? html : "")
      .replace(/\{\{\s*customer_name\s*\}\}/g, name)
      .replace(/\{\{\s*cart_total\s*\}\}/g, total);
  }

  /** {{ option }} → the anchor product's first variant-option name ("Size"). */
  function floaterText(template, opts) {
    var optionName = (opts && opts.anchor && opts.anchor.optionName) || "option";
    return campaignText(String(template || "").replace(/\{\{\s*option\s*\}\}/g, optionName), opts);
  }

  /** Per-campaign colors ride as custom properties so the CSS stays static. */
  function applyBubbleTheme(node, look) {
    look = look || {};
    node.style.setProperty("--cwp-bg", look.background || "#ffffff");
    node.style.setProperty("--cwp-ink", look.textColor || "#1a1a1f");
    node.style.setProperty("--cwp-btn", look.buttonBackground || "#1a1a1f");
    node.style.setProperty("--cwp-btn-ink", look.buttonLabelColor || "#ffffff");
  }

  var SPARK =
    '<svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 1.5l1.6 4.6 4.6 1.6-4.6 1.6L10 14l-1.6-4.7L3.8 7.7l4.6-1.6L10 1.5Zm5.6 9.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></svg>';

  /** Headline pill that overlaps the bubble's top edge. */
  function campaignBadge(text) {
    var badge = el("span", "cw-pa-badge");
    var mark = el("span", "cw-pa-badge-i");
    svg(mark, SPARK);
    badge.appendChild(mark);
    var label = el("span");
    label.textContent = text;
    badge.appendChild(label);
    return badge;
  }

  /** Compact product row: thumb | title + price (+ optional extra block). */
  function campaignProductRow(card, currency, extra) {
    var row = el("div", "cw-pa-prod");
    if (card.imageUrl) {
      row.appendChild(el("img", "cw-pa-prod-img", { src: card.imageUrl, alt: "", loading: "lazy" }));
    } else {
      row.appendChild(el("div", "cw-pa-prod-img"));
    }
    var body = el("div", "cw-pa-prod-body");
    var title = el("div", "cw-pa-prod-t");
    title.textContent = card.title;
    body.appendChild(title);
    if (extra) {
      body.appendChild(extra);
    } else {
      var price = el("div", "cw-pa-prod-p");
      price.textContent = formatPrice(card.price, currency);
      body.appendChild(price);
    }
    row.appendChild(body);
    return row;
  }

  /* Shopper-facing label for the recommendation source. Mirrors the editor's
   * radio labels so the merchant recognises the bubble they configured. */
  var RECOMMEND_LABELS = {
    best_sellers: "Recommend best sellers",
    new_arrivals: "Recommend new arrivals",
    similar: "Recommend similar products",
    complementary: "Recommend complementary products",
    custom: "Recommended for you",
  };

  function campaignBubble(campaign, opts, cb) {
    cb = cb || {};
    opts = opts || {};
    campaign = campaign || {};
    var m = campaign.message || {};
    var kind = m.kind || "text";
    var currency = opts.currency;

    var wrap = el("div", "cw-proactive cw-pa--" + kind, {
      role: "dialog",
      "aria-label": "Message from the store",
    });
    applyBubbleTheme(wrap, campaign.appearance);

    var x = el("button", "cw-pa-x", { type: "button", "aria-label": "Dismiss message" });
    svg(x, ICONS.close);
    x.addEventListener("click", function (e) {
      e.stopPropagation();
      if (cb.onDismiss) cb.onDismiss();
    });
    wrap.appendChild(x);

    // Everything below the badge lives in `body` so api.confirm() can replace
    // the whole flow in one go without disturbing the dismiss button.
    var body = el("div", "cw-pa-body");
    wrap.appendChild(body);

    var api = {
      confirm: function (text) {
        body.textContent = "";
        var line = el("div", "cw-pa-msg");
        setText(line, text);
        body.appendChild(line);
        var badge = wrap.querySelector(".cw-pa-badge");
        if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      },
      showLead: function () {
        renderLead();
      },
    };

    function richText(html) {
      var node = el("div", "cw-pa-msg");
      // Server-sanitized allow-list HTML (sanitize.server.ts), same trust
      // boundary as FAQ answers — see htmlBubble().
      node.innerHTML = campaignHtml(html, opts);
      return node;
    }

    function actionsRow() {
      return el("div", "cw-pa-actions");
    }

    function solidButton(text, onClick) {
      var btn = el("button", "cw-pa-btn cw-pa-btn--solid", { type: "button" });
      btn.textContent = text;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        onClick();
      });
      return btn;
    }

    function ghostButton(text, onClick) {
      var btn = el("button", "cw-pa-btn cw-pa-btn--ghost", { type: "button" });
      btn.textContent = text;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        onClick();
      });
      return btn;
    }

    // ── text ────────────────────────────────────────────────────────────────
    function renderText() {
      body.appendChild(richText(m.bodyHtml));
      // Quick question mode drops the merchant's copy in favour of the
      // chatbox's own conversation starters, tapped straight into the chat.
      var chips = opts.starters || [];
      if (m.contentMode === "quick_question" && chips.length) {
        var row = el("div", "cw-pa-chips");
        chips.slice(0, 3).forEach(function (chip) {
          var b = el("button", "cw-pa-chip", { type: "button" });
          b.textContent = chip.label || chip;
          b.addEventListener("click", function (e) {
            e.stopPropagation();
            if (cb.onCta) cb.onCta(api, chip.label || chip);
          });
          row.appendChild(b);
        });
        body.appendChild(row);
      } else {
        // No button in the design — the whole bubble opens the chat.
        wrap.className += " cw-pa--tappable";
        wrap.addEventListener("click", function () {
          if (cb.onCta) cb.onCta(api);
        });
      }
    }

    // ── product recommendation ──────────────────────────────────────────────
    function renderRecommendation() {
      wrap.appendChild(campaignBadge(RECOMMEND_LABELS[m.recommendation] || RECOMMEND_LABELS.custom));
      body.appendChild(richText(m.bodyHtml));
      var cards = campaign.products || [];
      if (cards.length === 0) {
        // Nothing in stock to show — the copy alone still opens the chat.
        wrap.className += " cw-pa--tappable";
        wrap.addEventListener("click", function () {
          if (cb.onCta) cb.onCta(api);
        });
        return;
      }
      cards.slice(0, 3).forEach(function (card) {
        body.appendChild(campaignProductRow(card, currency));
      });
      var first = cards[0];
      var actions = actionsRow();
      if (m.secondaryButtonText) {
        actions.appendChild(
          ghostButton(m.secondaryButtonText, function () {
            if (cb.onView) cb.onView(first, api);
          }),
        );
      }
      actions.appendChild(
        solidButton(m.primaryButtonText || "Ask about it", function () {
          if (cb.onCta) cb.onCta(api);
        }),
      );
      body.appendChild(actions);
    }

    // ── Smart Product Page floater ──────────────────────────────────────────
    function renderFloater() {
      wrap.appendChild(campaignBadge(floaterText(m.floaterMessage, opts)));
      var sub = el("div", "cw-pa-msg");
      setText(sub, campaignText(m.subtitle, opts));
      body.appendChild(sub);

      var anchor = opts.anchor;
      if (anchor) {
        var chips = el("div", "cw-pa-variants");
        var values = anchor.options || [];
        var selected = values.length > 1 ? values[Math.floor(values.length / 2)] : values[0];
        values.forEach(function (option) {
          var chip = el("button", "cw-pa-variant", { type: "button" });
          chip.textContent = option.value;
          if (!option.available) chip.className += " cw-pa-variant--out";
          if (selected && option.value === selected.value) chip.className += " is-on";
          chip.addEventListener("click", function (e) {
            e.stopPropagation();
            var current = chips.querySelector(".is-on");
            if (current) current.className = current.className.replace(" is-on", "");
            chip.className += " is-on";
            selected = option;
            if (cb.onSelectVariant) cb.onSelectVariant(option);
          });
          chips.appendChild(chip);
        });
        var block = el("div");
        block.appendChild(chips);
        if (values.length > 1) {
          var hint = el("div", "cw-pa-rec");
          hint.textContent = "★ Recommended";
          block.appendChild(hint);
        }
        body.appendChild(campaignProductRow(anchor, currency, block));
      }

      var cta = solidButton(m.ctaText || "Ask about it", function () {
        if (cb.onCta) cb.onCta(api);
      });
      cta.className += " cw-pa-btn--block";
      body.appendChild(cta);
    }

    // ── discount / newsletter ───────────────────────────────────────────────
    function renderDiscount() {
      body.textContent = "";
      body.appendChild(richText(m.bodyHtml));
      if (m.usageInstruction) {
        var note = el("div", "cw-pa-note");
        setText(note, m.usageInstruction);
        body.appendChild(note);
      }
      var cta = solidButton(m.triggerButtonText || "Yes, sure!", function () {
        // With lead capture on, the first tap only advances to the form — the
        // click is counted server-side when the form is submitted, and calling
        // onCta here would open the chat panel over the form we just drew.
        if (m.lead) renderLead();
        else if (cb.onCta) cb.onCta(api);
      });
      cta.className += " cw-pa-btn--block";
      body.appendChild(cta);
    }

    function renderLead() {
      var lead = m.lead || {};
      body.textContent = "";
      var intro = el("div", "cw-pa-msg");
      setText(intro, lead.introduction || "Subscribe to get hot deals, exclusive updates and rewards.");
      body.appendChild(intro);

      var form = el("form", "cw-pa-form");
      var email = el("input", "cw-pa-input", {
        type: "email",
        required: "required",
        placeholder: "Email address",
        "aria-label": "Email address",
      });
      form.appendChild(email);
      var name = null;
      if (lead.askName) {
        name = el("input", "cw-pa-input", { type: "text", placeholder: "Name", "aria-label": "Name" });
        form.appendChild(name);
      }
      var phone = null;
      if (lead.askPhone) {
        phone = el("input", "cw-pa-input", { type: "tel", placeholder: "Phone", "aria-label": "Phone" });
        form.appendChild(phone);
      }
      var submit = el("button", "cw-pa-btn cw-pa-btn--solid cw-pa-btn--block", { type: "submit" });
      submit.textContent = "Subscribe";
      form.appendChild(submit);
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (!email.value) return;
        submit.disabled = true;
        if (cb.onLead) {
          cb.onLead(
            {
              email: email.value,
              name: name ? name.value : "",
              phone: phone ? phone.value : "",
            },
            api,
          );
        } else {
          // Preview: no network — show the configured success copy.
          api.confirm(lead.successMessage || "Thank you for subscribing!");
        }
      });
      body.appendChild(form);
    }

    if (kind === "product_recommendation") renderRecommendation();
    else if (kind === "floater") renderFloater();
    else if (kind === "discount") renderDiscount();
    else renderText();

    return { el: wrap, confirm: api.confirm, showLead: api.showLead };
  }

  // ── footer ───────────────────────────────────────────────────────────────
  function footer(showBranding) {
    var foot = el("div", "cw-foot");
    foot.textContent = "Powered by ChatConvert";
    if (!showBranding) foot.style.display = "none";
    return foot;
  }

  window.ChatConvertRenderer = {
    icons: ICONS,
    el: el,
    setText: setText,
    setRichText: setRichText,
    actionChips: actionChips,
    themeVars: themeVars,
    applyTheme: applyTheme,
    formatPrice: formatPrice,
    welcomeText: welcomeText,
    contactHref: contactHref,
    launcher: launcher,
    header: header,
    homeScreen: homeScreen,
    faqAnswer: faqAnswer,
    messageBubble: messageBubble,
    htmlBubble: htmlBubble,
    typingIndicator: typingIndicator,
    starterChips: starterChips,
    productCards: productCards,
    inputBar: inputBar,
    trackingScreen: trackingScreen,
    orderStatusCard: orderStatusCard,
    shipmentCard: shipmentCard,
    setAvatar: setAvatar,
    prechatForm: prechatForm,
    handoverForm: handoverForm,
    surveyPrompt: surveyPrompt,
    campaignBubble: campaignBubble,
    footer: footer,
  };
})();
