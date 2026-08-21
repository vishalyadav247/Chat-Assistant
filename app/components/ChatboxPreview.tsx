import { useEffect, useRef, useState } from "react";
import type { WidgetSettingsData } from "../lib/settings/schemas";
import { useIsMobile } from "../lib/ui/use-mobile";

// Live preview (spec 06) with parity BY CONSTRUCTION: it injects the exact
// storefront assets (extensions/chat-widget/assets/widget-renderer.js + .css,
// delivered as raw strings via the chatbox loader) and renders every screen
// through window.ChatConvertRenderer — the same builders chat-widget.js uses.
// Same settings JSON in → same DOM out; the preview cannot drift from the
// storefront widget.

export interface PreviewFaq {
  id: string;
  question: string;
  answerHtml: string;
  category: string | null;
}

export type ChatboxTab = "general" | "chatpage" | "appearance";

type Screen = "home" | "chat" | "tracking" | "faq";

// Minimal typing for the framework-free renderer (see widget-renderer.js).
interface Renderer {
  el: (tag: string, className?: string | null, attrs?: Record<string, string>) => HTMLElement;
  applyTheme: (node: HTMLElement, appearance: WidgetSettingsData["appearance"]) => void;
  welcomeText: (template: string, customerName?: string) => string;
  launcher: (widget: WidgetSettingsData, cb: { onToggle?: () => void }) => HTMLElement;
  header: (
    config: unknown,
    state: { showBack: boolean },
    cb: { onBack?: () => void; onClose?: () => void },
  ) => { el: HTMLElement };
  homeScreen: (
    config: unknown,
    state: unknown,
    cb: {
      onOpenChat?: () => void;
      onOpenTracking?: () => void;
      onOpenFaq?: (faq: PreviewFaq) => void;
    },
  ) => HTMLElement;
  faqAnswer: (faq: PreviewFaq) => HTMLElement;
  messageBubble: (kind: string, content: string) => { el: HTMLElement };
  starterChips: (
    starters: WidgetSettingsData["starters"]["items"],
    cb: unknown,
  ) => HTMLElement;
  inputBar: (cb: unknown) => { el: HTMLElement };
  trackingScreen: (config: unknown, state: unknown, cb: unknown) => HTMLElement;
  prechatForm: (config: unknown, state: { skippable: boolean }, cb: unknown) => HTMLElement;
  surveyPrompt: (
    survey: { format: string; intro: string; thanks: string },
    cb: unknown,
  ) => HTMLElement;
  footer: (showBranding: boolean) => HTMLElement;
  /** Bot identity on message bubbles (null → default chat icon, no caption). */
  setAvatar?: (identity: { url: string | null; name: string } | null) => void;
}

declare global {
  interface Window {
    ChatConvertRenderer?: Renderer;
  }
}

const STYLE_ID = "chatconvert-preview-widget-css";
const SCRIPT_ID = "chatconvert-preview-renderer-js";

// Admin-only layout overrides: un-fix the widget (it renders inside the
// preview column, not the viewport) — visual styling stays 100% storefront CSS.
const PREVIEW_CSS = `
.ccpv .cw-root{position:static;inset:auto;z-index:auto;width:100%;}
.ccpv .cw-panel{width:100%;max-width:none;}
.ccpv .cw-body{max-height:560px;}
.ccpv .cw-launcher{margin-top:14px;}
/* The storefront CSS takes the panel full-screen (position:fixed;inset:0)
   below 480px. That is right on a shop, but inside the admin preview it would
   cover the settings being edited — keep it inside its card on phones too. */
@media (max-width: 480px){
.ccpv .cw-panel{position:static;inset:auto;width:100%;max-width:none;border-radius:18px;margin:0 0 12px;min-height:min(520px,68dvh);max-height:min(560px,68dvh);}
.ccpv .cw-pos-top_right .cw-panel,.ccpv .cw-pos-top_left .cw-panel{margin:12px 0 0;}
.ccpv .cw-body{max-height:none;}
}
`;

function ensureAssets(rendererJs: string, widgetCss: string): boolean {
  if (typeof document === "undefined") return false;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = widgetCss + PREVIEW_CSS;
    document.head.appendChild(style);
  }
  if (!window.ChatConvertRenderer && !document.getElementById(SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.textContent = rendererJs; // executes synchronously on append
    document.head.appendChild(script);
  }
  return Boolean(window.ChatConvertRenderer);
}

export function ChatboxPreview(props: {
  settings: WidgetSettingsData;
  tab: ChatboxTab;
  availability: { status: string; message: string };
  featuredFaqs: PreviewFaq[];
  rendererJs: string;
  widgetCss: string;
  currency: string;
  /** Survey copy/format from shop settings — rendered via the storefront's own
   *  surveyPrompt builder when the chat page's survey toggle is on. */
  survey: { format: string; intro: string; thanks: string };
  /** Order-tracking mode from shop settings — "default" shows only the
   *  order-number form; other modes add the Tracking-number tab. */
  orderTrackingMode: "default" | "custom" | "integration";
  /** Store information (Settings → General) — the "Store branding" chat
   *  avatar (logo or name initials) + author caption on bot messages. */
  storeInfo: { logoUrl: string | null; name: string };
}) {
  const { settings, tab, availability, featuredFaqs } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>("home");
  const [faq, setFaq] = useState<PreviewFaq | null>(null);
  const [minimized, setMinimized] = useState(false);
  // Phones (spec 20): the preview column sits under the settings, so an
  // auto-opened panel buries the form the merchant came to edit. Collapse it
  // to just the launcher and let them open it deliberately. Desktop keeps the
  // always-open panel.
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  useEffect(() => {
    setReady(ensureAssets(props.rendererJs, props.widgetCss));
  }, [props.rendererJs, props.widgetCss]);

  // Runs on mount (desktop: no-op) and whenever the viewport crosses the
  // breakpoint — not on every render, so an opened panel stays open.
  useEffect(() => {
    setMinimized(isMobile);
  }, [isMobile]);

  // Design behavior: switching to the Chat page tab auto-shows the chat
  // screen; other tabs return to home. Restores a minimized panel (desktop).
  useEffect(() => {
    setScreen(tab === "chatpage" ? "chat" : "home");
    setMinimized(isMobileRef.current);
  }, [tab]);

  useEffect(() => {
    const container = containerRef.current;
    const R = typeof window !== "undefined" ? window.ChatConvertRenderer : undefined;
    if (!ready || !container || !R) return;

    const chatFocus = settings.chatFocusMode && settings.liveChat;
    const offline = availability.status !== "online";
    // Same welcome-template pick as chat-widget.js prepareChat().
    const template =
      offline && settings.offlineMessageEnabled && settings.offlineMessage
        ? settings.offlineMessage
        : settings.welcomeMessage;

    // Open enforcement mode: the preview honors the merchant's toggle directly
    // (the storefront additionally gates via hasFeature in widget config).
    const showBranding = !settings.appearance.removeBranding;

    const config = {
      widget: settings,
      availability,
      featuredFaqs,
      welcomeMessage: settings.welcomeMessage,
      currency: props.currency,
      showBranding,
      // Same shape as the storefront widget config (customUrl not needed here —
      // the preview never navigates).
      orderTracking: { mode: props.orderTrackingMode, customUrl: "" },
    };

    // Same rule as config.server.ts: store branding → Settings → General
    // store logo/name (NOT the chatbox header logo); else default chat icon.
    R.setAvatar?.(
      settings.avatarMode === "store_branding"
        ? { url: props.storeInfo.logoUrl, name: props.storeInfo.name }
        : null,
    );

    container.textContent = "";
    const root = R.el("div", `cw-root cw-pos-${settings.appearance.launcher.position}`);
    R.applyTheme(root, settings.appearance);

    if (!minimized) {
      const panel = R.el("div", "cw-panel");

      const showBack = screen !== "home" && !(screen === "chat" && chatFocus);
      const head = R.header(config, { showBack }, {
        onBack: () => setScreen("home"),
        onClose: () => setMinimized(true), // X → minimize to launcher
      });
      panel.appendChild(head.el);

      const body = R.el("div", "cw-body");
      if (screen === "home") {
        body.appendChild(
          R.homeScreen(config, {}, {
            onOpenChat: () => setScreen("chat"),
            onOpenTracking: () => setScreen("tracking"),
            onOpenFaq: (opened) => {
              setFaq(opened);
              setScreen("faq");
            },
          }),
        );
      } else if (screen === "chat") {
        const wrap = R.el("div");
        wrap.style.display = "flex";
        wrap.style.flexDirection = "column";
        wrap.style.gap = "12px";
        wrap.style.flex = "1"; // fill the body so starter chips pin to the bottom

        // No customer name in preview → {{customer_name}} renders "there".
        wrap.appendChild(R.messageBubble("bot", R.welcomeText(template, "")).el);
        // Pre-chat form: the preview always shows it while it's enabled (on
        // the storefront, "both" mode may delay it N messages) so merchants
        // can see what they're configuring. Rendered before the starter chips.
        if (settings.prechat.mode === "guest") {
          wrap.appendChild(R.prechatForm(config, { skippable: false }, {}));
        } else if (settings.prechat.mode === "both") {
          wrap.appendChild(R.prechatForm(config, { skippable: true }, {}));
        }
        if (settings.starters.enabled && settings.starters.items.length > 0) {
          wrap.appendChild(R.starterChips(settings.starters.items, {}));
        }
        // "Display satisfaction survey" on → show the survey exactly as the
        // storefront renders it at conversation end (same builder, same CSS).
        if (settings.survey) {
          wrap.appendChild(R.surveyPrompt(props.survey, {}));
        }
        body.appendChild(wrap);
      } else if (screen === "tracking") {
        body.appendChild(R.trackingScreen(config, {}, {}));
      } else if (screen === "faq" && faq) {
        body.appendChild(R.faqAnswer(faq));
      }
      panel.appendChild(body);

      if (screen === "chat") panel.appendChild(R.inputBar({}).el);
      panel.appendChild(R.footer(showBranding));
      root.appendChild(panel);
    }

    // Launcher stays visible below the panel (per the design prototype) so
    // Appearance edits are always previewable; clicking it restores the panel.
    const launcher = R.launcher(settings, {
      onToggle: () => {
        // On phones the launcher toggles (open ⇄ collapse), like the
        // storefront; on desktop it only restores, as before.
        if (!minimized) {
          if (isMobileRef.current) setMinimized(true);
          return;
        }
        setMinimized(false);
        setScreen(chatFocus ? "chat" : "home");
      },
    });
    root.appendChild(launcher);
    container.appendChild(root);
  }, [
    ready,
    settings,
    screen,
    faq,
    minimized,
    availability,
    featuredFaqs,
    props.currency,
    props.survey,
    props.orderTrackingMode,
    props.storeInfo,
  ]);

  return (
    <>
      {isMobile && minimized ? (
        <p style={{ margin: 0, fontSize: 13, color: "#6a6a72" }}>
          Tap the chat button to open the live preview.
        </p>
      ) : null}
      <div className="ccpv" ref={containerRef} />
    </>
  );
}
