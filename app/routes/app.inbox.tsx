import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import { hasFeature } from "../lib/billing/plans.server";
import {
  blockConversation,
  deleteConversation,
  getConversationDetail,
  listConversations,
  markRead,
  sendAgentReply,
  setResolved,
  setStarred,
} from "../lib/inbox/inbox.server";
import { InboxDetails } from "../components/InboxDetails";
import { BRAND } from "../components/ui/tokens";
import { assigneeOptions, isValidAssignee, parseNotifyPrefs } from "../lib/team/team.server";
import { playChime, useInboxLive } from "../lib/ui/inbox-live";
import { useIsMobile } from "../lib/ui/use-mobile";
import { OpenInWebButton } from "../components/web/OpenInWebButton";
import { InboxFilters } from "../components/InboxFilters";
import { InboxList } from "../components/InboxList";
import { InboxThread } from "../components/InboxThread";
import { FILTERS, displayName, unreadOpenCount } from "../components/InboxShared";
import type { FilterKey, InboxRow } from "../components/InboxShared";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";

// Inbox workspace (spec 10, design inbox.html): 4 columns —
// Filters | List | Thread | Details — with human reply into the shopper's
// widget (delivered via the proxy.messages 5s poll). Realtime: the
// /app/inbox-events change feed (spec 18) triggers loader revalidation; a slow
// 30s poll remains as a fallback. Same page on both surfaces (admin + web).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "inbox" });
  const { shopId } = access;

  const conversations = await listConversations(shopId);

  const url = new URL(request.url);
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

  const [shop, assignees] = await Promise.all([
    db.shop.findUnique({
      where: { id: shopId },
      select: { plan: true, currency: true, name: true },
    }),
    assigneeOptions(shopId),
  ]);

  return {
    conversations,
    active,
    cartViewEnabled: hasFeature(shop?.plan ?? "free", "inbox_cart_view"),
    currency: shop?.currency ?? "USD",
    // Assignable people: the owner + the team roster (spec 18 TeamMember table).
    assignees,
    // Web surface: chime on new activity when the member wants it.
    live: {
      surface: access.surface,
      sound: access.member ? parseNotifyPrefs(access.member.notifyPrefs, access.member.role).sound : false,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "inbox" });
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
      return { ok: await sendAgentReply(shopId, conversationId, content), intent };
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
  const [filter, setFilter] = useState<FilterKey>(() => {
    if (data.active && searchParams.get("c") === data.active.id) {
      if (data.active.blocked) return "blocked";
      return data.active.status === "resolved" ? "resolved" : "open";
    }
    return "all";
  });
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState("");

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

  // Fill the viewport: size the workspace from its rendered top edge down to
  // the bottom of the iframe (the CSS 130px offset is only a pre-paint guess).
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    // No height floor: the page must NEVER grow its own scrollbar, whatever
    // the window/zoom. Columns scroll internally, so the grid can shrink to
    // exactly what fits. floor() guards fractional-zoom rounding.
    const apply = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      // visualViewport tracks the on-screen keyboard on phones, so the
      // composer stays visible while typing (innerHeight ignores it).
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      const h = Math.floor(viewportH - top - 16);
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

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.conversations.filter((row) => {
      if (!FILTERS[filter].test(row)) return false;
      if (unreadOnly && !row.unread) return false;
      if (q && !displayName(row.name).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.conversations, filter, unreadOnly, search]);

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
    <s-page heading={isMobile ? undefined : "Inbox"} inlineSize="large">
      <OpenInWebButton slot="secondary-actions" />
      <style dangerouslySetInnerHTML={{ __html: WORKSPACE_CSS }} />
      {/* Mobile (spec 19): one pane at a time, keyed off ?c= — no ?c= shows the
          list, an explicit selection shows the thread full-screen. */}
      <div
        className="cin-grid"
        ref={gridRef}
        data-view={explicitSelection ? "thread" : "list"}
      >
        <InboxFilters rows={data.conversations} filter={filter} onSelect={setFilter} />
        <InboxList
          title={FILTERS[filter].label}
          rows={visibleRows}
          activeId={activeId}
          unreadCount={unreadOpenCount(data.conversations)}
          unreadOnly={unreadOnly}
          onToggleUnread={() => setUnreadOnly((v) => !v)}
          search={search}
          onSearch={setSearch}
          onSelect={selectConversation}
          onOpenFilters={() => setFiltersOpen(true)}
        />
        <InboxThread
          active={active}
          busy={busy}
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
          cartViewEnabled={data.cartViewEnabled}
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
                rows={data.conversations}
                filter={filter}
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
                cartViewEnabled={data.cartViewEnabled}
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

.cin-filcol{padding:10px 8px;overflow-y:auto;}
/* Mobile filter slide-over (Chatty reference inbox_nav.png): the same rail
   panel, opened from the list header's filter button. */
.cin-filbtn{display:none;width:38px;height:38px;border-radius:11px;background:#fbfbfc;box-shadow:inset 0 0 0 1px #dcdce1;color:#2b2b30;align-items:center;justify-content:center;flex:none;}
.cin-filbtn:active{background:#f1f1f4;}
.cin-fov{position:fixed;inset:0;z-index:130;background:rgba(14,14,20,.45);display:flex;justify-content:flex-start;}
.cin-fov-panel{width:min(300px,85vw);height:100%;background:#fff;border-radius:0 18px 18px 0;overflow:hidden;box-shadow:0 0 50px rgba(0,0,0,.35);}
.cin-fov-panel .cin-filcol{display:flex;flex-direction:column;width:100%;height:100%;border:none;border-radius:0;box-shadow:none;padding-top:max(14px,env(safe-area-inset-top));}
.cin-fil-title{font-weight:750;color:#141417;font-size:14px;padding:6px 8px 4px;}
.cin-fil-grp{font-size:10.5px;font-weight:700;color:#9a9aa2;text-transform:uppercase;letter-spacing:.5px;padding:12px 8px 5px;}
.cin-fil{display:flex;align-items:center;gap:9px;height:33px;padding:0 8px;border-radius:8px;width:100%;font-size:12.5px;font-weight:550;text-align:left;}
.cin-fil:hover{background:#fbfbfc;}
.cin-fil.active{background:#f3f1fb;color:${BRAND.accent};font-weight:700;}
.cin-fil-l{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cin-fil-c{font-size:11px;font-weight:700;color:#6b6b73;}
.cin-fil.active .cin-fil-c{color:${BRAND.accent};}
.cin-fil-c.red{color:#fff;background:#f43f5e;border-radius:10px;padding:1px 3px;min-width:18px;text-align:center;}

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
.cin-msgs{flex:1;overflow-y:auto;padding:18px 18px 22px;display:flex;flex-direction:column;gap:8px;}
.cin-msgs > span{display:contents;}
.cin-mtime{align-self:center;font-size:11px;color:#9a9aa2;margin:6px 0;}
.cin-mline{display:flex;align-items:flex-end;gap:9px;max-width:min(76%,640px);}
.cin-mline.in{align-self:flex-start;}
.cin-mline.out{align-self:flex-end;flex-direction:row-reverse;}
.cin-mpa{width:28px;height:28px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:linear-gradient(135deg,#f472b6,#a78bfa);}
.cin-mpa.bot{background:${BRAND.gradient};}
.cin-mwrap{display:flex;flex-direction:column;min-width:0;}
.cin-mmeta{font-size:11px;color:#9a9aa2;margin-bottom:4px;}
.cin-mline.out .cin-mmeta{text-align:right;}
.cin-bubble{padding:9px 13px;border-radius:14px;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:break-word;}
.cin-bubble.in{background:#fff;color:#2b2b30;box-shadow:0 1px 2px rgba(20,20,25,.05),inset 0 0 0 1px #e9e9ec;border-bottom-left-radius:5px;}
.cin-bubble.out{background:${BRAND.gradient};color:#fff;border-bottom-right-radius:5px;}
.cin-seen{align-self:flex-end;font-size:10.5px;color:#9a9aa2;margin-top:2px;}
.cin-sys{align-self:center;font-size:11.5px;color:#9a9aa2;background:#fff;box-shadow:0 1px 2px rgba(20,20,25,.06);border-radius:20px;padding:5px 12px;margin:8px auto;display:table;}
.cin-composer{flex:none;background:#fff;border:1px solid #dcdce1;border-radius:7px;margin:6px 6px 10px;padding:10px 12px;box-shadow:0 2px 10px rgba(20,20,25,.05);}
.cin-comp-input{width:100%;min-height:38px;max-height:90px;font-size:13px;color:#2b2b30;outline:none;border:none;resize:vertical;font-family:inherit;line-height:1.5;}
.cin-comp-input::placeholder{color:#9a9aa2;}
.cin-comp-bar{display:flex;align-items:center;gap:2px;margin-top:8px;padding-top:8px;box-shadow:inset 0 1px 0 #e9e9ec;}
.cin-emoji{width:30px;height:30px;border-radius:8px;font-size:15px;display:flex;align-items:center;justify-content:center;}
.cin-emoji:hover{background:#fbfbfc;}
.cin-send{margin-left:auto;background:${BRAND.gradient};color:#fff;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(109,59,245,.35);font-size:14px;}
.cin-send:disabled{opacity:.4;box-shadow:none;}

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
.cin-cart-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.cin-upgrade{display:inline-flex;align-items:center;gap:5px;background:#fbe6a2;color:#8a5a00;font-size:11px;font-weight:750;border-radius:20px;padding:3px 9px;}
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

@media (max-width:1240px){.cin-grid{grid-template-columns:150px 260px 1fr;}.cin-details{display:none;}.cin-infobtn{display:flex;}}
@media (max-width:1040px){.cin-grid{grid-template-columns:260px 1fr;}.cin-filcol{display:none;}}
@media (max-width:768px){
  /* One pane at a time (data-view from ?c=): list view = full-screen list;
     thread view = full-screen thread with a back button. */
  .cin-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:10px;}
  .cin-grid[data-view="list"] .cin-threadcol{display:none;}
  .cin-grid[data-view="thread"] .cin-listcol{display:none;}
  .cin-col{border-radius:14px;}

  /* List header (Chatty layout): [filter button] [active-filter title] …
     [Unread toggle], search full-width below; roomy 44px-avatar rows. */
  .cin-filbtn{display:flex;}
  .cin-list-top{padding:10px 12px;}
  .cin-list-head{justify-content:flex-start;gap:10px;margin-bottom:10px;}
  .cin-list-title{font-size:15px;}
  .cin-unread-toggle{margin-left:auto;}
  .cin-lsearch{height:38px;border-radius:12px;}
  .cin-conv{padding:13px 14px;gap:12px;}
  .cin-cav{width:44px;height:44px;border-radius:14px;font-size:13px;}
  .cin-cname{font-size:14px;}
  .cin-cprev{font-size:12.5px;}

  /* Thread: 52px header, ellipsized name, comfy touch targets. */
  .cin-back{display:flex;}
  .cin-th-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;font-size:15px;}
  .cin-th-head{gap:8px;padding:9px 12px;min-height:52px;box-sizing:border-box;}
  .cin-star,.cin-kebab{width:36px;height:36px;}
  .cin-msgs{padding:14px 12px 18px;}
  .cin-mline{max-width:85%;}

  /* Composer: rounded card, circular gradient send, home-bar safe area.
     16px inputs stop iOS focus-zoom. */
  .cin-composer{border-radius:16px;margin:8px 8px calc(8px + env(safe-area-inset-bottom, 0px));padding:10px 12px;}
  .cin-comp-input,.cin-lsearch{font-size:16px;}
  .cin-send{width:40px;height:40px;border-radius:50%;}
  .cin-emoji{width:34px;height:34px;}

  .cin-dov-panel{width:min(400px,100vw);}
}
`;
