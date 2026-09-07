import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import { hasFeature, requiredPlanName } from "../lib/billing/plans.server";
import {
  blockConversation,
  deleteConversation,
  getConversationDetail,
  getInboxCounts,
  INBOX_FILTER_KEYS,
  listConversations,
  markRead,
  sendAgentReply,
  setResolved,
  setStarred,
} from "../lib/inbox/inbox.server";
import type { InboxFilterKey } from "../lib/inbox/inbox.server";
import { recentOrdersForContact } from "../lib/inbox/recent-orders.server";
import { InboxDetails } from "../components/InboxDetails";
import { BRAND } from "../components/ui/tokens";
import { assigneeOptions, isValidAssignee, parseNotifyPrefs } from "../lib/team/team.server";
import { loadShopSettings } from "../lib/settings/save.server";
import { loadWidgetSettings } from "../lib/widget/settings-save.server";
import { resolveChatAvatar } from "../lib/widget/chat-avatar.server";
import { playChime, useInboxLive } from "../lib/ui/inbox-live";
import { useIsMobile } from "../lib/ui/use-mobile";
import { OpenInWebButton } from "../components/web/OpenInWebButton";
import { InboxFilters } from "../components/InboxFilters";
import { InboxList } from "../components/InboxList";
import { CHAT_CARD_CSS } from "../components/ChatProductCards";
import { InboxThread } from "../components/InboxThread";
import { FILTERS, displayName } from "../components/InboxShared";
import type { FilterKey, InboxRow } from "../components/InboxShared";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";
import { installFullBleedPage } from "../lib/ui/spage-fullbleed";
import { APP_NAME } from "./app";

// Inbox workspace (spec 10, design inbox.html): 4 columns —
// Filters | List | Thread | Details — with human reply into the shopper's
// widget (delivered via the proxy.messages 5s poll). Realtime: the
// /app/inbox-events change feed (spec 18) triggers loader revalidation; a slow
// 30s poll remains as a fallback. Same page on both surfaces (admin + web).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "inbox" });
  const { shopId } = access;

  // Rail selection, search term and the Unread toggle live in the URL so the
  // DATABASE applies them. Filtering the loaded page in the browser instead
  // meant each tab only ever showed the part of its category that happened to
  // fall inside the newest page of conversations.
  const url = new URL(request.url);
  const rawFilter = url.searchParams.get("filter");
  let filter: InboxFilterKey = (INBOX_FILTER_KEYS as readonly string[]).includes(rawFilter ?? "")
    ? (rawFilter as InboxFilterKey)
    : "all";
  const search = (url.searchParams.get("q") ?? "").slice(0, 100);
  const unreadOnly = url.searchParams.get("unread") === "1";

  const [initialRows, counts] = await Promise.all([
    listConversations(shopId, { filter, search, unreadOnly }),
    getInboxCounts(shopId),
  ]);
  let conversations = initialRows;

  const requested = url.searchParams.get("c");
  // A deep link (?c=) to a conversation older than the first page must still
  // open it — getConversationDetail is shop-scoped, so the id alone is safe.
  const activeId =
    requested ||
    (conversations.find((c) => !c.blocked)?.id ?? conversations[0]?.id ?? null);
  let active = activeId ? await getConversationDetail(shopId, activeId) : null;
  if (!active && requested) {
    const fallbackId = conversations.find((c) => !c.blocked)?.id ?? conversations[0]?.id ?? null;
    active = fallbackId ? await getConversationDetail(shopId, fallbackId) : null;
  }
  // A deep link straight to a BLOCKED conversation (dashboard live feed, an
  // email link) is the one case "all" cannot show, because every tab but
  // "Blocked" excludes blocked rows. Land on the tab the thread actually lives
  // in so the rail agrees with what is on screen. Only when the merchant has
  // not chosen a tab themselves, and only for blocked — every other status is
  // already inside "all".
  if (!rawFilter && requested && active?.blocked) {
    filter = "blocked";
    conversations = await listConversations(shopId, { filter, search, unreadOnly });
  }

  const [shop, assignees, widget, shopSettings] = await Promise.all([
    db.shop.findUnique({
      where: { id: shopId },
      select: { plan: true, currency: true, name: true },
    }),
    assigneeOptions(shopId),
    loadWidgetSettings(shopId),
    loadShopSettings(shopId),
  ]);
  // Same resolver the storefront config and the chatbox preview use
  // (chat-avatar.server.ts), so an agent sees the identity on AI replies that
  // the shopper actually saw — store branding or the chosen team member.
  const botAvatar = await resolveChatAvatar(
    shopId,
    widget,
    shopSettings.storeInfo,
    shop?.name || "Store",
  );

  // Drives the upgrade prompt only. The cart data itself is withheld inside
  // getConversationDetail, so this flag being wrong cannot leak anything.
  const cartViewEnabled = hasFeature(shop?.plan ?? "free", "inbox_cart_view");

  // Recent orders for the details pane. Opportunistic: no Shopify session, an
  // anonymous visitor, or a Shopify hiccup all degrade to an empty list rather
  // than failing the page.
  const recentOrders = await recentOrdersForContact(
    await access.getAdminOptional(),
    active?.contact ?? null,
    access.shopDomain,
  );

  return {
    conversations,
    // Exact totals over every conversation, not just the loaded page.
    counts,
    filter,
    search,
    unreadOnly,
    active,
    recentOrders,
    cartViewEnabled,
    // Tier that unlocks the live-cart panel (live matrix); null when allowed.
    cartViewPlan: cartViewEnabled ? null : requiredPlanName("inbox_cart_view"),
    currency: shop?.currency ?? "USD",
    // Product-card links in the thread point at the real storefront page.
    shopDomain: access.shopDomain,
    // Assignable people: the owner + the team roster (spec 18 TeamMember table).
    assignees,
    // Identity shown on AI bubbles, mirroring the storefront widget.
    botAvatar,
    // Web surface: chime on new activity when the member wants it.
    live: {
      surface: access.surface,
      sound: access.member ? parseNotifyPrefs(access.member.notifyPrefs, access.member.role).sound : false,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "inbox" });
  const { shopId } = access;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const conversationId = String(formData.get("conversationId") ?? "");
  if (!conversationId) return { ok: false, intent };

  switch (intent) {
    case "send": {
      const content = String(formData.get("content") ?? "")
        .trim()
        .slice(0, 2000);
      if (!content) return { ok: false, intent };
      return {
        ok: await sendAgentReply(shopId, conversationId, content, access.member?.id ?? null),
        intent,
      };
    }
    case "resolve":
      return { ok: await setResolved(shopId, conversationId, true), intent };
    case "reopen":
      return { ok: await setResolved(shopId, conversationId, false), intent };
    case "star":
      return {
        ok: await setStarred(shopId, conversationId, formData.get("starred") === "1"),
        intent,
      };
    case "read":
      return { ok: await markRead(shopId, conversationId), intent };
    case "block":
      return { ok: await blockConversation(shopId, conversationId), intent };
    case "delete":
      return { ok: await deleteConversation(shopId, conversationId), intent };
    case "assign": {
      const assigneeId = String(formData.get("assigneeId") ?? "");
      // "" = unassign; otherwise the id must be the owner or a roster member.
      if (assigneeId && !(await isValidAssignee(shopId, assigneeId))) {
        return { ok: false, intent };
      }
      const result = await db.conversation.updateMany({
        where: { id: conversationId, shopId },
        data: { assigneeId: assigneeId || null },
      });
      return { ok: result.count > 0, intent };
    }
    default:
      return { ok: false, intent };
  }
};

export default function InboxPage() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const isMobile = useIsMobile();
  const opFetcher = useFetcher<typeof action>();
  const sendFetcher = useFetcher<typeof action>();

  // Deep links (dashboard live feed → ?c=...) land on the tab the chat itself
  // belongs to, so the rail reflects what's on screen instead of "All".
  // Rail selection, Unread toggle and search are URL state, because the DATABASE
  // applies them — filtering the loaded page in the browser showed each tab only
  // the slice of its category that fell inside the newest page. The loader is
  // the single source of truth; these mirror what it decided.
  const filter = data.filter as FilterKey;
  const unreadOnly = data.unreadOnly;

  /** Patch the query string; dropping ?c= so the loader picks a thread that
   *  exists in the new result set instead of stranding the old selection. */
  const setParams = (patch: Record<string, string | null>, keepActive = false) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        if (!keepActive) next.delete("c");
        return next;
      },
      { preventScrollReset: true, replace: true },
    );
  };

  const setFilter = (key: FilterKey) => setParams({ filter: key });

  // The search box stays local so typing is instant, and is pushed into the URL
  // (and therefore the query) on a short debounce.
  const [search, setSearch] = useState(data.search);
  const committedSearch = data.search;
  useEffect(() => {
    if (search === committedSearch) return;
    const id = setTimeout(() => setParams({ q: search || null }), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setParams identity is unstable
  }, [search, committedSearch]);
  // A revalidation that changes the committed term (back/forward, deep link)
  // must win over stale local text.
  useEffect(() => setSearch(committedSearch), [committedSearch]);

  const active = data.active;
  const activeId = active?.id ?? null;

  // Details slide-over (spec 19): the Details column is display-hidden below
  // 1241px, so an info button in the thread header opens the same component
  // as a right-hand overlay there. Closed on Escape, backdrop, X, or when the
  // active conversation changes (e.g. after delete).
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => setDetailsOpen(false), [activeId]);
  // Mobile filter panel (Chatty reference inbox_nav.png): the same
  // <InboxFilters> rail slides in from the left.
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    if (!detailsOpen && !filtersOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetailsOpen(false);
        setFiltersOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen, filtersOpen]);

  // s-page keeps its gutter inside a shadow root, so page CSS can't reach it;
  // this is the one route that goes edge to edge on a phone (spec 20).
  useEffect(() => installFullBleedPage(), []);

  // Fill the viewport: size the workspace from its rendered top edge down to
  // the bottom of the iframe (the CSS 130px offset is only a pre-paint guess).
  const gridRef = useRef<HTMLDivElement>(null);
  // Read inside the fit (which is mounted once) without re-running the effect.
  const mobileRef = useRef(isMobile);
  mobileRef.current = isMobile;
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    // No height floor: the page must NEVER grow its own scrollbar, whatever
    // the window/zoom. Columns scroll internally, so the grid can shrink to
    // exactly what fits. floor() guards fractional-zoom rounding.
    const apply = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      // Where the VISIBLE area ends, in the same coordinates as `top`.
      // A phone keyboard shrinks the visual viewport and — on browsers that
      // don't honour interactive-widget=resizes-content (iOS) — also scrolls
      // it down inside an unchanged layout viewport. Adding offsetTop is what
      // keeps the composer pinned to the visible bottom instead of the
      // workspace collapsing into a band in the middle of the page.
      const vv = window.visualViewport;
      const visibleBottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
      // Phones give the workspace the whole screen (its own safe-area margin
      // sits inside the composer); pointer devices keep the 16px breather.
      const slack = mobileRef.current ? 0 : 16;
      const h = Math.floor(visibleBottom - top - slack);
      el.style.height = `${Math.max(0, h)}px`;
      // Second pass: whatever still overflows (s-page bottom padding, borders)
      // comes off the grid so the page never grows a scrollbar.
      const overflow = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      if (overflow > 0) el.style.height = `${Math.max(0, h - overflow)}px`;
    };
    // Kill switch: while the workspace is mounted the document itself never
    // scrolls — the fit above makes everything fit, this guarantees it.
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    apply();
    window.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("resize", apply);
    // s-* web components upgrade after mount and can shift the layout; re-fit
    // whenever the body's size settles (stable size → observer goes quiet).
    const ro = new ResizeObserver(apply);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("resize", apply);
      ro.disconnect();
      document.documentElement.style.overflow = prevOverflow;
    };
  }, []);

  // Live change feed (spec 18): revalidate on every `changed` frame. The web
  // surface also badges the tab title and (optionally) chimes.
  const baseTitle = useRef<string | null>(null);
  useInboxLive((frame) => {
    if (frame.type === "changed") {
      if (revalidator.state === "idle") revalidator.revalidate();
      if (data.live.surface === "web" && data.live.sound && document.visibilityState !== "visible") playChime();
    }
    if (data.live.surface === "web" && typeof frame.unread === "number") {
      if (baseTitle.current === null) baseTitle.current = document.title.replace(/^\(\d+\)\s*/, "");
      document.title = frame.unread > 0 ? `(${frame.unread}) ${baseTitle.current}` : baseTitle.current;
    }
  });
  // Fallback poll (slow) in case the stream is blocked by a proxy — only while visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [revalidator]);

  // Toasts + post-delete cleanup.
  const processed = useRef<unknown>(null);
  useEffect(() => {
    if (opFetcher.state !== "idle" || !opFetcher.data || processed.current === opFetcher.data)
      return;
    processed.current = opFetcher.data;
    const { ok, intent } = opFetcher.data;
    if (intent === "delete" && ok) {
      shopify.toast.show("Conversation deleted");
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("c");
          return next;
        },
        { preventScrollReset: true },
      );
    } else if (intent === "block") {
      shopify.toast.show(ok ? "Visitor blocked" : "Couldn't block visitor");
    } else if (!ok && intent !== "read") {
      shopify.toast.show("Something went wrong");
    }
  }, [opFetcher.state, opFetcher.data, shopify, setSearchParams]);

  // A reply that the server rejected (conversation deleted by a teammate,
  // visitor blocked) must not vanish silently.
  const processedSend = useRef<unknown>(null);
  useEffect(() => {
    if (sendFetcher.state !== "idle" || !sendFetcher.data || processedSend.current === sendFetcher.data)
      return;
    processedSend.current = sendFetcher.data;
    if (sendFetcher.data.intent === "send" && !sendFetcher.data.ok) {
      shopify.toast.show("Couldn't send the reply — the conversation may have been closed or deleted", {
        isError: true,
      });
    }
  }, [sendFetcher.state, sendFetcher.data, shopify]);

  // The rows ARE the answer — the database already applied filter, search and
  // the Unread toggle. The only client-side work left is optimistic narrowing
  // while the search debounce is still in flight, and that is only sound when
  // the typed term EXTENDS the committed one: then the true result is a subset
  // of what is on screen. Deleting characters widens the result set, which no
  // amount of client filtering can reconstruct — so we wait for the server.
  const visibleRows = useMemo(() => {
    const typed = search.trim().toLowerCase();
    const committed = committedSearch.trim().toLowerCase();
    if (typed === committed || !typed.startsWith(committed)) return data.conversations;
    return data.conversations.filter((row) =>
      displayName(row.name).toLowerCase().includes(typed),
    );
  }, [data.conversations, search, committedSearch]);

  // Viewing a thread marks it read — but ONLY when the merchant explicitly
  // chose it (clicked a row, or arrived via a dashboard ?c= deep link). The
  // loader also auto-selects the newest thread as a default; marking that one
  // read would silently swallow unread chats the merchant never looked at.
  const explicitSelection = activeId !== null && searchParams.get("c") === activeId;
  const activeUnread = data.conversations.some((r) => r.id === activeId && r.unread);
  useEffect(() => {
    if (explicitSelection && activeUnread) {
      opFetcher.submit({ intent: "read", conversationId: activeId }, { method: "post" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opFetcher identity is unstable
  }, [explicitSelection, activeId, activeUnread]);

  const selectConversation = (row: InboxRow) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("c", row.id);
        return next;
      },
      { preventScrollReset: true },
    );
  };

  const op = (intent: string, extra?: Record<string, string>) => {
    if (!activeId) return;
    opFetcher.submit({ intent, conversationId: activeId, ...extra }, { method: "post" });
  };

  const busy = sendFetcher.state !== "idle" || opFetcher.state !== "idle";

  return (
    // Mobile drops the page heading — the shell top bar + filter chips give
    // the context, and the workspace gets the reclaimed height (spec 20).
    <s-page heading={isMobile ? undefined : APP_NAME} inlineSize="large">
      <OpenInWebButton slot="secondary-actions" />
      <style dangerouslySetInnerHTML={{ __html: WORKSPACE_CSS }} />
      {/* Mobile (spec 19): one pane at a time, keyed off ?c= — no ?c= shows the
          list, an explicit selection shows the thread full-screen. */}
      <div
        className="cin-grid"
        ref={gridRef}
        data-view={explicitSelection ? "thread" : "list"}
      >
        <InboxFilters counts={data.counts} filter={filter} onSelect={setFilter} />
        <InboxList
          title={FILTERS[filter].label}
          rows={visibleRows}
          activeId={activeId}
          unreadCount={data.counts.unreadOpen}
          unreadOnly={unreadOnly}
          onToggleUnread={() => setParams({ unread: unreadOnly ? null : "1" })}
          search={search}
          onSearch={setSearch}
          onSelect={selectConversation}
          onOpenFilters={() => setFiltersOpen(true)}
          filtered={filter !== "all"}
        />
        <InboxThread
          active={active}
          busy={busy}
          botAvatar={data.botAvatar}
          team={data.assignees}
          currency={data.currency}
          shopDomain={data.shopDomain}
          onBack={() =>
            setSearchParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                next.delete("c");
                return next;
              },
              { preventScrollReset: true },
            )
          }
          onShowDetails={() => setDetailsOpen(true)}
          onStar={() => op("star", { starred: active?.starred ? "0" : "1" })}
          onResolveToggle={() => op(active?.status === "resolved" ? "reopen" : "resolve")}
          onSend={(content) => {
            if (!activeId) return;
            sendFetcher.submit(
              { intent: "send", conversationId: activeId, content },
              { method: "post" },
            );
          }}
          onBlock={() => op("block")}
          onDelete={() => op("delete")}
        />
        <InboxDetails
          active={active}
          recentOrders={data.recentOrders}
          cartViewEnabled={data.cartViewEnabled}
          cartViewPlan={data.cartViewPlan}
          currency={data.currency}
          assignees={data.assignees}
          onAssign={(assigneeId) =>
            activeId &&
            opFetcher.submit(
              { intent: "assign", conversationId: activeId, assigneeId },
              { method: "post" },
            )
          }
          onBlock={() => op("block")}
          onDelete={() => op("delete")}
        />
        {/* Phones only (CSS-gated): the filter tabs as a bar under the list,
            in place of the trigger + overlay. Hidden in thread view. */}
        <InboxFilters variant="bar" counts={data.counts} filter={filter} onSelect={setFilter} />
        {filtersOpen ? (
          <div
            className="cin-fov"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setFiltersOpen(false);
            }}
          >
            <div className="cin-fov-panel" role="dialog" aria-modal="true" aria-label="Conversation filters">
              <InboxFilters
                variant="sheet"
                counts={data.counts}
                filter={filter}
                onClose={() => setFiltersOpen(false)}
                onSelect={(key) => {
                  setFilter(key);
                  setFiltersOpen(false);
                }}
              />
            </div>
          </div>
        ) : null}
        {detailsOpen && active ? (
          <div
            className="cin-dov"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setDetailsOpen(false);
            }}
          >
            <div className="cin-dov-panel" role="dialog" aria-modal="true" aria-label="Conversation details">
              <button
                type="button"
                className="cin-dov-close"
                aria-label="Close details"
                onClick={() => setDetailsOpen(false)}
              >
                <s-icon type="x" />
              </button>
              <InboxDetails
                active={active}
                recentOrders={data.recentOrders}
                cartViewEnabled={data.cartViewEnabled}
                cartViewPlan={data.cartViewPlan}
                currency={data.currency}
                assignees={data.assignees}
                onAssign={(assigneeId) =>
                  opFetcher.submit(
                    { intent: "assign", conversationId: active.id, assigneeId },
                    { method: "post" },
                  )
                }
                onBlock={() => op("block")}
                onDelete={() => op("delete")}
              />
            </div>
          </div>
        ) : null}
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

// ── Workspace styles (adapted from design inbox.html; cin- prefixed) ────────

const WORKSPACE_CSS = `
.cin-grid{display:grid;grid-template-columns:190px 320px minmax(0,1fr) 300px;gap:4px;height:calc(100vh - 130px);height:calc(100dvh - 130px);font-size:13px;color:#2b2b30;}
.cin-col{min-height:0;display:flex;flex-direction:column;background:#fff;border:1px solid #e9e9ec;border-radius:7px;box-shadow:0 1px 2px rgba(20,20,25,.06);overflow:hidden;}
/* Column scrollbars: invisible at rest (the workspace reads as one clean
   surface), slim thumb fades in only while hovering that column. */
.cin-grid *{scrollbar-width:thin;scrollbar-color:transparent transparent;}
.cin-grid *:hover{scrollbar-color:#c9c9d2 transparent;}
.cin-grid ::-webkit-scrollbar{width:8px;height:8px;}
.cin-grid ::-webkit-scrollbar-track{background:transparent;}
.cin-grid ::-webkit-scrollbar-thumb{background:transparent;border-radius:8px;}
.cin-grid :hover::-webkit-scrollbar-thumb{background:#c9c9d2;}
.cin-grid ::-webkit-scrollbar-thumb:hover{background:#adadb8;}
.cin-grid button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit;}
.cin-grid button:disabled{cursor:default;}

/* Filter rail ─────────────────────────────────────────────────────────────
   This is the workspace's primary navigation, so it is built as a navigation
   surface rather than another white data card: a faintly tinted gradient
   column, a branded header, and one coloured glyph per tab so the seven rows
   can be scanned instead of read. The selected tab is a frosted brand pill
   (translucent gradient + blur + accent bar) — the one glassmorphic moment,
   spent on the single element whose job is to say "you are here". Everything
   else stays opaque: chat rows and counts need contrast, not translucency. */
.cin-filcol{padding:0 0 8px;overflow-y:auto;background:linear-gradient(180deg,#fcfcfe 0%,#f5f4fb 100%);border-color:#e6e4ee;}
.cin-fil-head{flex:none;position:sticky;top:0;z-index:2;display:flex;flex-direction:column;padding:12px 13px 11px;background:rgba(252,252,254,.82);-webkit-backdrop-filter:blur(10px) saturate(150%);backdrop-filter:blur(10px) saturate(150%);box-shadow:inset 0 -1px 0 rgba(20,20,25,.07);}
.cin-fil-title{font-weight:750;color:#141417;font-size:13.5px;line-height:1.2;}
.cin-fil-sub{font-size:10.5px;font-weight:600;color:#8b8b96;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cin-fil-grp{font-size:10px;font-weight:750;color:#9a9aa2;text-transform:uppercase;letter-spacing:.6px;padding:13px 13px 6px;}
.cin-fil{position:relative;flex:none;display:flex;align-items:center;gap:9px;min-height:34px;margin:1px 7px;padding:0 8px;border-radius:10px;font-size:12.5px;font-weight:600;text-align:left;transition:background .14s ease,box-shadow .14s ease,transform .12s ease;}
.cin-fil:hover{background:rgba(255,255,255,.92);box-shadow:0 1px 3px rgba(20,20,25,.07),inset 0 0 0 1px rgba(20,20,25,.05);}
.cin-fil:active{transform:scale(.985);}
.cin-fil.active{background:linear-gradient(135deg,rgba(109,59,245,.15),rgba(59,130,246,.09));-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);color:${BRAND.accent};font-weight:750;box-shadow:inset 0 0 0 1px rgba(109,59,245,.2),0 4px 12px rgba(109,59,245,.14);}
.cin-fil-ic{width:24px;height:24px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;color:#6b6b73;background:#f0f0f5;box-shadow:inset 0 0 0 1px rgba(20,20,25,.05);transition:background .14s ease,color .14s ease,box-shadow .14s ease;}
.cin-fil[data-k="open"] .cin-fil-ic{color:#2563eb;background:#e4edff;}
.cin-fil[data-k="resolved"] .cin-fil-ic{color:#0c8f5a;background:#d9f6e9;}
.cin-fil[data-k="unassigned"] .cin-fil-ic{color:#0e7490;background:#d8f1f7;}
.cin-fil[data-k="handover"] .cin-fil-ic{color:#c2410c;background:#ffe6da;}
.cin-fil[data-k="starred"] .cin-fil-ic{color:#b7791f;background:#fdf3d4;}
.cin-fil[data-k="blocked"] .cin-fil-ic{color:#be123c;background:#ffe1e7;}
/* Last, so it wins over the per-tab tints above at equal specificity. */
.cin-fil.active .cin-fil-ic{background:${BRAND.gradient};color:#fff;box-shadow:0 2px 6px rgba(109,59,245,.35);}
.cin-fil-l{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cin-fil-c{font-size:11px;font-weight:750;color:#6b6b73;background:rgba(20,20,25,.055);border-radius:20px;min-width:20px;padding:2px 6px;text-align:center;}
.cin-fil.active .cin-fil-c{color:#fff;background:${BRAND.accent};}
.cin-fil-c.red{color:#fff;background:#f43f5e;border-radius:10px;padding:1px 3px;min-width:18px;text-align:center;}

/* Filter trigger + slide-over (Chatty reference inbox_nav.png): below 1041px
   the rail column is gone, so this button IS the filter feature — it gets the
   same brand pill treatment plus a dot whenever a non-default tab is active,
   so a filtered list can never be mistaken for an empty one. */
.cin-filbtn{position:relative;display:none;width:38px;height:38px;border-radius:12px;background:linear-gradient(180deg,#fff,#f6f5fb);box-shadow:inset 0 0 0 1px #dedce7,0 1px 2px rgba(20,20,25,.06);color:#4a4a53;align-items:center;justify-content:center;flex:none;transition:background .14s ease,box-shadow .14s ease,transform .12s ease;}
.cin-filbtn:hover{box-shadow:inset 0 0 0 1px #cfcddb,0 2px 6px rgba(20,20,25,.09);}
.cin-filbtn:active{transform:scale(.94);}
.cin-filbtn.on{color:${BRAND.accent};background:linear-gradient(135deg,rgba(109,59,245,.15),rgba(59,130,246,.09));box-shadow:inset 0 0 0 1px rgba(109,59,245,.28),0 3px 10px rgba(109,59,245,.16);}
.cin-filbtn.on::after{content:"";position:absolute;top:4px;right:4px;width:8px;height:8px;border-radius:50%;background:${BRAND.gradient};box-shadow:0 0 0 2px #fff;}
/* Phone filter bar — declared here, switched on only in the ≤768px block. */
.cin-fbar{display:none;}

/* Bottom sheet, NOT a left drawer: the web shell's nav drawer already slides
   in from the left, and two identical left panels on one screen read as the
   same control. A sheet rising from the bottom is a different gesture, sits
   under the thumb, and is short enough that the conversation list stays
   visible behind it. Above 768px it becomes a centred dialog instead. */
.cin-fov{position:fixed;inset:0;z-index:130;background:rgba(14,14,20,.42);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:flex;align-items:flex-end;justify-content:center;}
.cin-fov-panel{width:100%;max-height:min(78dvh,520px);background:rgba(252,252,254,.96);-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);border-radius:22px 22px 0 0;overflow:hidden;box-shadow:0 -10px 44px rgba(0,0,0,.3);animation:cinSheetIn .2s cubic-bezier(.22,.9,.3,1);}
.cin-fsheet{display:flex;flex-direction:column;min-height:0;height:100%;padding:0 12px calc(14px + env(safe-area-inset-bottom,0px));}
.cin-fsheet-grab{flex:none;width:38px;height:4px;border-radius:4px;background:#d3d1de;margin:9px auto 3px;}
.cin-fsheet-head{flex:none;display:flex;align-items:center;gap:8px;padding:6px 2px 10px;}
.cin-fsheet-head .cin-fil-title{flex:1;font-size:14.5px;}
.cin-fsheet-x{width:32px;height:32px;border-radius:9px;color:#6b6b73;display:flex;align-items:center;justify-content:center;flex:none;}
.cin-fsheet-x:hover{background:rgba(20,20,25,.06);}
/* Two columns: seven tabs fit without scrolling on a phone, so the sheet
   never grows tall enough to feel like a full-screen takeover. */
.cin-fsheet-grid{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:1px 1px 2px;}
.cin-fsheet-grid .cin-fil{margin:0;min-height:48px;padding:0 10px;border-radius:13px;background:#fff;box-shadow:inset 0 0 0 1px #e6e4ee;}
.cin-fsheet-grid .cin-fil:hover{background:#fbfbfc;box-shadow:inset 0 0 0 1px #d7d4e4;}
.cin-fsheet-grid .cin-fil.active{background:linear-gradient(135deg,rgba(109,59,245,.15),rgba(59,130,246,.09));box-shadow:inset 0 0 0 1.5px rgba(109,59,245,.35),0 4px 12px rgba(109,59,245,.14);}
@keyframes cinSheetIn{from{transform:translateY(100%);}to{transform:none;}}
/* Tablets and narrow desktop windows: a bottom sheet at 900px wide looks
   stranded, so the same panel centres as a dialog. */
@media (min-width:769px){
  .cin-fov{align-items:center;}
  .cin-fov-panel{width:min(460px,92vw);border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.32);animation-name:cinDialogIn;}
  .cin-fsheet{padding:0 14px 14px;}
  .cin-fsheet-grab{display:none;}
  .cin-fsheet-head{padding:14px 2px 12px;}
}
@keyframes cinDialogIn{from{transform:translateY(12px) scale(.97);opacity:0;}to{transform:none;opacity:1;}}
@media (prefers-reduced-motion:reduce){
  .cin-fil,.cin-filbtn,.cin-fil-ic{transition:none;}
  .cin-fov-panel{animation:none;}
}

.cin-list-top{padding:12px 12px 10px;box-shadow:inset 0 -1px 0 #e9e9ec;flex:none;}
.cin-list-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;}
.cin-list-title{font-weight:750;color:#141417;font-size:14px;}
.cin-unread-toggle{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:#6b6b73;}
.cin-switch{width:34px;height:20px;border-radius:20px;background:#dcdce1;position:relative;transition:.15s;flex:none;display:inline-block;}
.cin-switch.on{background:${BRAND.accent};}
.cin-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:.15s;}
.cin-switch.on::after{left:16px;}
.cin-lsearch{box-sizing:border-box;width:100%;background:#fbfbfc;box-shadow:inset 0 0 0 1px #dcdce1;border:none;border-radius:9px;height:34px;padding:0 11px;font-family:inherit;font-size:12.5px;color:#2b2b30;outline:none;}
.cin-lsearch:focus{box-shadow:inset 0 0 0 1px ${BRAND.accent};}
.cin-conv-scroll{flex:1;overflow-y:auto;}
.cin-list-empty{padding:30px;text-align:center;color:#6b6b73;font-size:12.5px;}
.cin-conv{display:flex;gap:11px;padding:12px 13px;box-shadow:inset 0 -1px 0 #e9e9ec;width:100%;text-align:left;position:relative;}
.cin-conv:hover{background:#fbfbfc;}
.cin-conv.active{background:#f3f1fb;}
.cin-conv.unread{background:#fff8ec;}
.cin-cav{width:38px;height:38px;border-radius:11px;flex:none;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;}
.cin-cbody{flex:1;min-width:0;display:block;}
.cin-ctop{display:flex;align-items:center;gap:8px;}
.cin-cname{font-weight:700;color:#141417;font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px;}
.cin-tinystar{color:#f59e0b;display:inline-flex;align-items:center;}
.cin-ctime{font-size:11px;color:#9a9aa2;white-space:nowrap;}
.cin-cdot{width:7px;height:7px;border-radius:50%;background:#3b82f6;flex:none;}
.cin-cprev{display:block;font-size:12px;color:#6b6b73;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;}
.cin-tags{display:flex;gap:5px;margin-top:5px;}
.cin-tag{display:inline-flex;align-items:center;font-size:10px;font-weight:700;border-radius:6px;padding:1px 6px;}
.cin-tag.chan{color:#6b6b73;background:#fbfbfc;box-shadow:inset 0 0 0 1px #e9e9ec;}
.cin-tag.hand{color:#8a5a00;background:#fdecc8;}
.cin-tag.proc{color:#1d4ed8;background:#e0edff;}

.cin-threadcol{background:#f3f1fb;}
.cin-thread-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#6b6b73;font-size:12.5px;}
.cin-th-head{flex:none;padding:8px 16px;background:#fff;box-shadow:inset 0 -1px 0 #e9e9ec;display:flex;align-items:center;gap:11px;}
.cin-back{display:none;width:34px;height:34px;margin-left:-8px;border-radius:9px;color:#2b2b30;align-items:center;justify-content:center;flex:none;}
.cin-back:hover{background:#fbfbfc;}
.cin-infobtn{display:none;width:32px;height:32px;border-radius:8px;color:#6b6b73;align-items:center;justify-content:center;flex:none;}
.cin-infobtn:hover{background:#e9e9ec;}
.cin-th-name{font-weight:750;color:#141417;font-size:14px;}
.cin-th-tag{font-size:11px;font-weight:600;color:#6b6b73;background:#fbfbfc;box-shadow:inset 0 0 0 1px #dcdce1;border-radius:7px;padding:3px 8px;}
.cin-sp{flex:1;}
.cin-star{width:32px;height:32px;border-radius:8px;font-size:17px;color:#c9c9d0;display:flex;align-items:center;justify-content:center;}
.cin-star:hover,.cin-star.on{color:#f59e0b;}
.cin-resolve{font-size:12.5px;font-weight:650;border-radius:9px;padding:5px 10px;background:#fff;color:#2b2b30;box-shadow:inset 0 0 0 1px #dcdce1;}
.cin-resolve:hover{background:#e9e9ec;}
.cin-resolve.done{background:#d7f8e6;color:#0c5132;box-shadow:none;display: flex;gap: 10px;}
.cin-kebab-wrap{position:relative;}
.cin-kebab{width:30px;height:26px;border-radius:9px;color:#6b6b73;font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;}
.cin-kebab:hover{background:#e9e9ec;}
.cin-menu{position:absolute;right:0;top:36px;z-index:20;background:#fff;border:1px solid #e9e9ec;border-radius:10px;box-shadow:0 6px 20px rgba(20,20,25,.12);display:flex;flex-direction:column;min-width:170px;padding:4px;}
.cin-menu button{text-align:left;padding:8px 10px;border-radius:7px;font-size:12.5px;font-weight:600;}
.cin-menu button:hover{background:#fbfbfc;}
.cin-menu button.del{color:#e11d48;}
.cin-msgs{flex:1;min-height:0;overflow-y:auto;padding:18px 18px 22px;display:flex;flex-direction:column;gap:8px;}
.cin-msgs > span{display:contents;}
.cin-mtime{align-self:center;font-size:11px;color:#9a9aa2;margin:6px 0;}
.cin-mline{display:flex;align-items:flex-end;gap:9px;max-width:min(76%,640px);}
.cin-mline.in{align-self:flex-start;}
.cin-mline.out{align-self:flex-end;flex-direction:row-reverse;}
.cin-mpa{width:28px;height:28px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:linear-gradient(135deg,#f472b6,#a78bfa);}
.cin-mpa.bot{background:${BRAND.gradient};}
/* Store logo variant of the AI avatar — same circle, image fills it. */
.cin-mpa.img{overflow:hidden;background:#fff;box-shadow:inset 0 0 0 1px #e9e9ec;}
.cin-mpa.img img{width:100%;height:100%;object-fit:cover;display:block;}
.cin-mwrap{display:flex;flex-direction:column;min-width:0;}
.cin-mmeta{font-size:11px;color:#9a9aa2;margin-bottom:4px;}
.cin-mline.out .cin-mmeta{text-align:right;}
.cin-bubble{padding:9px 13px;border-radius:14px;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:break-word;}
.cin-bubble.in{background:#fff;color:#2b2b30;box-shadow:0 1px 2px rgba(20,20,25,.05),inset 0 0 0 1px #e9e9ec;border-bottom-left-radius:5px;}
.cin-bubble.out{background:${BRAND.gradient};color:#fff;border-bottom-right-radius:5px;}
.cin-seen{align-self:flex-end;font-size:10.5px;color:#9a9aa2;margin-top:2px;}
${CHAT_CARD_CSS}
.cin-sys{align-self:center;font-size:11.5px;color:#9a9aa2;background:#fff;box-shadow:0 1px 2px rgba(20,20,25,.06);border-radius:20px;padding:5px 12px;margin:8px auto;display:table;}
.cin-composer{flex:none;background:#fff;border:1px solid #dcdce1;border-radius:7px;margin:6px 6px 10px;padding:10px 12px;box-shadow:0 2px 10px rgba(20,20,25,.05);}
.cin-comp-input{width:100%;min-height:38px;font-size:13px;color:#2b2b30;outline:none;border:none;resize:none;overflow-y:hidden;font-family:inherit;line-height:1.5;display:block;}
.cin-comp-input::placeholder{color:#9a9aa2;}
/* The composer inherits the .cin-grid slim scrollbar above, but that only
   reveals the thumb on :hover — this box is scrolled by TYPING, when the
   pointer is usually elsewhere. Reveal it on focus too (widget composer
   does the same). */
.cin-comp-input:focus{scrollbar-color:#c9c9d2 transparent;}
.cin-comp-input:focus::-webkit-scrollbar-thumb{background:#c9c9d2;}
.cin-comp-input::-webkit-scrollbar-thumb:hover{background:#adadb8;}
/* Layout-neutral wrapper on pointer devices — the phone rules turn it into
   the rounded input pill. */
.cin-comp-pill{display:block;}
.cin-emoji-btn{display:none;}
.cin-comp-bar{display:flex;align-items:center;gap:2px;margin-top:8px;padding-top:8px;box-shadow:inset 0 1px 0 #e9e9ec;}
.cin-emoji{width:30px;height:30px;border-radius:8px;font-size:15px;display:flex;align-items:center;justify-content:center;}
.cin-emoji:hover{background:#fbfbfc;}
button.cin-send{margin-left:auto;background:${BRAND.gradient};color:#fff;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(109,59,245,.35);font-size:14px;}
button.cin-send:disabled{opacity:.4;box-shadow:none;}

.cin-details{background:#f7f7f9;}
.cin-dscroll{flex:1;min-height:0;overflow-y:auto;padding:9px;display:flex;flex-direction:column;gap:12px;}
.cin-dhead{flex:none;padding:14px 13px;background:#fff;box-shadow:inset 0 -1px 0 #e9e9ec;font-weight:750;color:#141417;font-size:14px;}
.cin-dtitle{font-weight:750;color:#141417;font-size:13.5px;}
.cin-dtitle.sm{font-size:13px;}
.cin-dcard{background:#fff;border-radius:12px;box-shadow:inset 0 0 0 1px #e9e9ec;padding:13px;}
.cin-dcard.rows{padding:4px 13px;}
.cin-dlabel{font-size:11px;font-weight:700;color:#9a9aa2;text-transform:uppercase;letter-spacing:.5px;}
.cin-cf{font-size:12.5px;color:#9a9aa2;margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;}
.cin-cf.last{margin-bottom:0;}
.cin-cf.inlin{display:inline;margin-left:6px;}
.cin-assignee{display:flex;align-items:center;gap:8px;margin-top:8px;}
.cin-an{flex:1;color:#2b2b30;font-weight:600;font-size:12.5px;}
.cin-assign{color:${BRAND.accent};font-weight:700;font-size:12.5px;opacity:.5;}
.cin-assign-select{font:inherit;font-size:12.5px;font-weight:600;color:#2b2b30;background:#fbfbfc;border:1px solid #dcdce1;border-radius:8px;padding:6px 8px;width:100%;cursor:pointer;}
.cin-accrow{display:flex;align-items:center;gap:8px;padding:11px 0;box-shadow:inset 0 -1px 0 #e9e9ec;font-size:12.5px;}
.cin-accrow:last-child{box-shadow:none;}
.cin-accrow.acc{display:block;}
.cin-accrow.acc summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;}
.cin-accrow.acc summary::-webkit-details-marker{display:none;}
.cin-acc-arrow{flex:none;color:#9a9aa2;transition:transform .15s ease;}
.cin-accrow.acc[open] summary .cin-acc-arrow{transform:rotate(90deg);}
.cin-acc-body{padding:7px 0 2px;font-size:12.5px;color:#6b6b73;}
.cin-at{flex:1;font-weight:650;color:#141417;}
.cin-av2{color:#6b6b73;}
.cin-page-url{font-size:11.5px;color:#6b6b73;padding:0 0 6px;word-break:break-all;}
.cin-page-url:last-child{padding-bottom:0;}
/* Recent orders: number · date/status on one line, total right-aligned. Opens
   the merchant own admin, so target=_top escapes the embedded iframe. */
.cin-order{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:baseline;padding:5px 0;text-decoration:none;color:inherit;border-bottom:1px solid #f0eff4;}
.cin-order:last-child{border-bottom:none;}
.cin-order:hover .cin-order-n{text-decoration:underline;}
.cin-order-n{font-size:12px;font-weight:600;color:#2b2b30;}
.cin-order-m{font-size:11.5px;color:#6b6b73;}
.cin-order-t{font-size:12px;font-weight:600;color:#2b2b30;justify-self:end;}
.cin-cart-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.cin-cart-item{display:flex;align-items:center;gap:11px;padding:6px 0;}
.cin-cart-info{flex:1;min-width:0;display:block;}
.cin-cart-name{display:block;font-weight:650;color:#141417;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cin-cart-var{display:block;color:#6b6b73;font-size:11.5px;margin-top:2px;}
.cin-cart-price{font-weight:700;color:#141417;font-size:12.5px;white-space:nowrap;}
.cin-cart-total{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;box-shadow:inset 0 1px 0 #e9e9ec;font-size:12.5px;color:#6b6b73;font-weight:600;}
.cin-rating{margin-top:8px;display:flex;align-items:center;gap:3px;}
.cin-rating-note{margin-left:7px;font-size:12px;font-weight:650;color:#6b6b73;}
.cin-dfoot{display:flex;gap:10px;flex:none;padding:11px 9px;background:#f7f7f9;box-shadow:0 -1px 0 #e9e9ec;}
.cin-fb{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;height:36px;border-radius:10px;font-weight:700;font-size:12.5px;background:#fbfbfc;box-shadow:inset 0 0 0 1px #dcdce1;color:#2b2b30;}
.cin-fb:hover{background:#e9e9ec;}
.cin-fb.del{color:#e11d48;}

/* Details slide-over (spec 19): reuses <InboxDetails> as a right-hand overlay
   wherever the Details column is display-hidden (<1241px). Rendered inside
   .cin-grid so the shared button/scrollbar resets apply. */
.cin-dov{position:fixed;inset:0;z-index:130;background:rgba(20,20,25,.5);display:flex;justify-content:flex-end;}
.cin-dov-panel{position:relative;width:min(360px,92vw);height:100%;}
.cin-dov-panel .cin-details{display:flex;width:100%;height:100%;border-radius:0;border:none;}
.cin-dov-close{position:absolute;top:8px;right:9px;z-index:5;width:32px;height:32px;border-radius:8px;color:#6b6b73;display:flex;align-items:center;justify-content:center;background:#fff;}
.cin-dov-close:hover{background:#e9e9ec;}

/* Touch devices (phones AND tablets): the thread-header controls are the
   agent's main actions, so they get real 40px targets instead of the 30-34px
   mouse sizes. Pointer-gated, so desktop is untouched. */
@media (pointer: coarse){
  .cin-back,.cin-infobtn,.cin-star{width:40px;height:40px;}
  .cin-kebab{width:40px;height:34px;}
  .cin-filbtn{min-width:40px;min-height:40px;}
  .cin-fil{min-height:44px;margin:2px 8px;padding:0 9px;font-size:13.5px;}
  .cin-fil-ic{width:28px;height:28px;border-radius:9px;}
}
@media (max-width:1240px){.cin-grid{grid-template-columns:150px 260px 1fr;}.cin-details{display:none;}.cin-infobtn{display:flex;}}
/* The rail folds into the slide-over here, so the trigger has to appear in the
   same breakpoint that removes it — otherwise tablets lose filtering entirely. */
@media (max-width:1040px){.cin-grid{grid-template-columns:260px 1fr;}.cin-filcol{display:none;}.cin-filbtn{display:flex;}}
@media (max-width:768px){
  /* One pane at a time (data-view from ?c=): list view = full-screen list;
     thread view = full-screen thread with a back button. */
  /* Full-bleed workspace: the shell's page gutter is removed for this page
     (app-mobile.css), so the list, the thread and the filter bar all run edge
     to edge — a phone screen has no room for a card inset around a surface
     that already fills it, and the bottom bar only reads as a bar when it
     touches both edges. */
  .cin-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:0;}
  .cin-grid[data-view="list"] .cin-threadcol{display:none;}
  .cin-grid[data-view="thread"] .cin-listcol{display:none;}
  .cin-col{border-radius:0;border:none;box-shadow:none;}

  /* Header keeps the search and nothing else — the title was a restatement of
     the active filter chip, and the filter/unread controls now live at the
     bottom. Everything between the two is the conversation list, scrolling. */
  .cin-list-head{display:none;}

  /* List header (Chatty layout): [filter button] [active-filter title] …
     [Unread toggle], search full-width below; roomy 44px-avatar rows. */
  /* Filters move out of the header and overlay entirely: a scrollable strip
     pinned under the list, always visible, one tap to switch. Cheaper than a
     sheet (no open/close) and it shows the current tab without being asked.
     Thread view hides it — that pane needs every pixel for the composer. */
  .cin-filbtn{display:none;}
  .cin-grid[data-view="list"] .cin-fbar{display:flex;}
  /* Five equal slots, no horizontal scrolling: a strip you have to drag hides
     the state you are trying to read and is a poor target one-handed. Fixed
     slots also let the bar sit flush to both screen edges. */
  .cin-fbar{position:relative;align-items:stretch;gap:0;flex:none;padding:0 0 env(safe-area-inset-bottom,0px);background:#fff;box-shadow:inset 0 1px 0 #e9e9ec;}
  .cin-fbar .cin-fil{position:relative;flex:1 1 0;min-width:0;flex-direction:column;justify-content:center;gap:3px;margin:0;min-height:56px;padding:8px 2px 7px;border-radius:0;background:none;box-shadow:none;font-size:10px;font-weight:650;color:#6b6b73;}
  .cin-fbar .cin-fil:hover{background:none;box-shadow:none;}
  .cin-fbar .cin-fil-ic{width:25px;height:25px;border-radius:8px;}
  .cin-fbar .cin-fil-l{flex:none;max-width:100%;font-size:10px;line-height:1;}
  /* Count rides the glyph as a superscript — a vertical tab has no room for it
     on the label line, and it must stay visible when the tab is inactive. */
  .cin-fbar .cin-fil-c{position:absolute;top:5px;left:50%;margin-left:5px;min-width:16px;height:16px;padding:0 4px;font-size:9.5px;line-height:16px;border-radius:16px;background:#e9e9ee;color:#4a4a53;box-shadow:0 0 0 2px #fff;}
  /* Active: brand glyph chip, accent label, and a short bar on the top edge —
     the tab-bar equivalent of the rail's left accent. */
  .cin-fbar .cin-fil.active{background:none;box-shadow:none;color:${BRAND.accent};font-weight:750;}
  .cin-fbar .cin-fil.active .cin-fil-ic{background:${BRAND.gradient};color:#fff;box-shadow:0 2px 6px rgba(109,59,245,.35);}
  .cin-fbar .cin-fil.active .cin-fil-c{background:${BRAND.accent};color:#fff;}

  /* "More" opens upward, anchored to its own slot — a popover, not another
     full-width sheet, so the list stays readable behind it. */
  .cin-fmore-wrap{position:relative;flex:1 1 0;min-width:0;display:flex;}
  .cin-fmore-wrap .cin-fil{flex:1 1 auto;}
  .cin-fmore{position:absolute;bottom:calc(100% + 6px);right:6px;z-index:20;min-width:196px;padding:6px;display:flex;flex-direction:column;gap:2px;background:#fff;border-radius:15px;box-shadow:0 -8px 30px rgba(20,20,25,.2),inset 0 0 0 1px #e9e9ec;animation:cinMoreIn .15s ease-out;}
  .cin-fmore .cin-fil{flex:none;flex-direction:row;justify-content:flex-start;gap:9px;min-height:44px;padding:0 9px;border-radius:11px;font-size:13px;font-weight:600;color:#2b2b30;}
  .cin-fmore .cin-fil-l{flex:1;font-size:13px;text-align:left;overflow:hidden;text-overflow:ellipsis;}
  .cin-fmore .cin-fil-c{position:static;margin:0;box-shadow:none;font-size:11px;height:auto;line-height:1.5;}
  .cin-fmore-scrim{position:fixed;inset:0;z-index:15;background:transparent;}
  @keyframes cinMoreIn{from{transform:translateY(6px);opacity:0;}to{transform:none;opacity:1;}}

  /* The header is one full-bleed row: search on the left, Unread on the
     right. Unread is a modifier, not a filter — it composes with whichever tab
     is selected — so it belongs next to the search box that also narrows the
     list, not in the tab bar where it would read as an eighth filter.
     Achieved with flex order so the desktop DOM is untouched. */
  .cin-list-top{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#fff;box-shadow:inset 0 -1px 0 #e9e9ec;}
  .cin-list-head{order:2;flex:none;display:flex;align-items:center;margin:0;justify-content:flex-end;}
  .cin-list-title{display:none;}
  .cin-unread-toggle{margin:0;padding:0 4px;font-size:12px;gap:6px;}
  /* The search is the only bordered thing in the row: the field reads as a
     field, while the row itself stays flush to both screen edges. */
  .cin-lsearch{order:1;flex:1;min-width:0;height:46px;border-radius:13px;padding:0 13px;font-size:16px;background:#fbfbfc;box-shadow:inset 0 0 0 1px #dcdce1;}
  .cin-lsearch:focus{background:#fff;box-shadow:inset 0 0 0 1.5px ${BRAND.accent};}
  .cin-conv{padding:13px 14px;gap:12px;}
  .cin-cav{width:44px;height:44px;border-radius:14px;font-size:13px;}
  .cin-cname{font-size:14px;}
  .cin-cprev{font-size:12.5px;}

  /* Thread: the header sits flush against the top edge and the message list
     starts immediately under it — a phone thread has no room for a gutter
     above the first bubble, and the day divider already provides the break. */
  .cin-back{display:flex;}
  .cin-th-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;font-size:15px;}
  .cin-th-head{gap:8px;padding:6px 10px;min-height:48px;box-sizing:border-box;}
  .cin-star,.cin-kebab{width:36px;height:36px;}
  .cin-msgs{padding:0 12px 12px;}
  .cin-mline{max-width:85%;}
  /* Phone reading size: 13px is a desktop density that a thread held at arm's
     length can't carry. */
  .cin-bubble{font-size:15px;line-height:1.5;padding:9px 13px;}
  .cin-mmeta{font-size:11.5px;}

  /* Composer, messaging-app shape: a rounded pill holding the emoji button
     and the field, with a round Send beside it. The desktop two-row bar cost
     ~46px of a screen that has none to spare, and the six-emoji strip sat
     under the field where a thumb reaching for Send kept hitting it.
     display:contents on the bar promotes Send to a sibling of the pill, so the
     row is built from the same markup the desktop uses — no branch. 16px input
     stops the iOS focus-zoom; the growth cap keeps a long reply from eating
     the thread. */
  .cin-composer{position:relative;display:flex;align-items:flex-end;gap:8px;background:transparent;border:none;box-shadow:none;border-radius:0;margin:0;padding:7px 8px calc(7px + env(safe-area-inset-bottom, 0px));}
  .cin-comp-pill{flex:1;min-width:0;display:flex;align-items:flex-end;gap:4px;background:#fff;border-radius:5px;box-shadow:inset 0 0 0 1px #dcdce1;padding:3px 12px 3px 3px;}
  .cin-comp-pill:focus-within{box-shadow:inset 0 0 0 1.5px ${BRAND.accent};}
  .cin-emoji-btn{display:flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;border-radius:5px;font-size:23px;line-height:1;}
  .cin-emoji-btn:active{background:#f1f1f4;}
  .cin-comp-input,.cin-lsearch{font-size:16px;}
  /* One line to start (line-height + padding only — no min-height floor to
     inflate it), then the autosize effect grows it to the 3-row cap. */
  .cin-comp-input{min-height:0;max-height:120px;padding:8px 0;font-size:17px;line-height:1.45;}
  /* The strip leaves the flow: its Send becomes a sibling of the pill and its
     six emoji move into the popover above. */
  .cin-comp-bar{display:contents;}
  .cin-emoji{display:none;}
  button.cin-send{width:46px;height:46px;border-radius:5px;font-size:15px;flex:none;margin-left:0;}
  /* Six per row, spanning the composer width — a grid, not a strip, so the
     fuller set stays reachable without scrolling. */
  .cin-epop{position:absolute;bottom:calc(100% - 2px);left:8px;right:8px;z-index:20;display:grid;grid-template-columns:repeat(6,1fr);gap:2px;padding:6px;background:#fff;border-radius:10px;box-shadow:0 -6px 26px rgba(20,20,25,.2),inset 0 0 0 1px #e9e9ec;animation:cinEpopIn .15s ease-out;}
  .cin-epop .cin-emoji{display:flex;width:auto;height:42px;border-radius:6px;font-size:23px;}
  /* Emoji-only message: no bubble, just the glyphs at display size. */
  .cin-bubble.emo{background:none;color:inherit;box-shadow:none;padding:2px 0;font-size:34px;line-height:1.2;}
  .cin-epop-scrim{position:fixed;inset:0;z-index:15;background:transparent;}
  @keyframes cinEpopIn{from{transform:translateY(6px);opacity:0;}to{transform:none;opacity:1;}}

  .cin-dov-panel{width:min(400px,100vw);}
}
`;
