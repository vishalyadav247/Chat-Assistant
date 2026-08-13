import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { InboxDetail } from "./InboxShared";

// Details column (design inbox.html): customer card, Assignee (v1 single-user
// — Assign disabled, "Team coming soon"), meta accordions, Shopping cart card
// (plan-gated "inbox_cart_view"), Satisfaction survey, footer Block/Delete.

interface CartLine {
  title?: string;
  variant?: string;
  quantity?: number;
  price?: number;
}

function cartLines(pageContext: unknown): CartLine[] {
  if (!pageContext || typeof pageContext !== "object") return [];
  const cart = (pageContext as { cart?: { items?: CartLine[] } }).cart;
  return Array.isArray(cart?.items) ? cart.items : [];
}

/** Cart total from the snapshot (reflects theme discounts); null → compute. */
function cartTotal(pageContext: unknown): number | null {
  if (!pageContext || typeof pageContext !== "object") return null;
  const cart = (pageContext as { cart?: { totalValue?: unknown } }).cart;
  return typeof cart?.totalValue === "number" ? cart.totalValue : null;
}

function browsedPages(pageContext: unknown): string[] {
  if (!pageContext || typeof pageContext !== "object") return [];
  const ctx = pageContext as { url?: unknown; pages?: unknown };
  // Dedupe here too — histories stored before the merge deduped globally can
  // still contain repeat visits to the same URL.
  if (Array.isArray(ctx.pages)) {
    return [...new Set(ctx.pages.filter((p): p is string => typeof p === "string"))];
  }
  return typeof ctx.url === "string" && ctx.url ? [ctx.url] : [];
}

function deviceInfo(pageContext: unknown): string | null {
  if (!pageContext || typeof pageContext !== "object") return null;
  const device = (pageContext as { device?: unknown }).device;
  return typeof device === "string" && device ? device : null;
}

/** Collapsed meta row — label + chevron; content only shows when opened. */
function DetailAccordion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="cin-accrow acc">
      <summary>
        <span className="cin-at">{label}</span>
        <svg className="cin-acc-arrow" width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M7 4.5 13 10l-6 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="cin-acc-body">{children}</div>
    </details>
  );
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.57l-5.9 3.1 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z"
        fill={filled ? "#FBBF24" : "none"}
        stroke={filled ? "#F59E0B" : "#C9C9D0"}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function InboxDetails({
  active,
  cartViewEnabled,
  currency,
  assignees,
  onAssign,
  onBlock,
  onDelete,
}: {
  active: InboxDetail | null;
  cartViewEnabled: boolean;
  currency: string;
  assignees: { id: string; name: string }[];
  onAssign: (assigneeId: string) => void;
  onBlock: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const activeId = active?.id ?? null;
  useEffect(() => setConfirmDelete(false), [activeId]);

  if (!active) {
    return (
      <div className="cin-col cin-details">
        <div className="cin-dhead">Conversation details</div>
      </div>
    );
  }

  const pages = browsedPages(active.pageContext);
  const cart = cartLines(active.pageContext);
  const device = deviceInfo(active.pageContext);
  const fmt = (value: number) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
    } catch {
      return `${currency} ${value.toFixed(2)}`;
    }
  };

  return (
    <div className="cin-col cin-details">
      {/* Fixed header — stays put while the cards below scroll, matching the
          list/thread column headers. */}
      <div className="cin-dhead">Conversation details</div>
      <div className="cin-dscroll">
        <div className="cin-dcard">
          <div className="cin-cf">{active.contact?.name || "Customer name"}</div>
          <div className="cin-cf">{active.contact?.email || "Email"}</div>
          <div className="cin-cf last">{active.contact?.phone || "Phone number"}</div>
        </div>

        <div className="cin-dcard">
          <span className="cin-dlabel">Assignee</span>
          <div className="cin-assignee">
            <select
              className="cin-assign-select"
              aria-label="Assign conversation"
              value={active.assigneeId ?? ""}
              onChange={(e) => onAssign(e.currentTarget.value)}
            >
              <option value="">Unassigned</option>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="cin-dcard rows">
          <DetailAccordion label="Visitor device">{device ?? "No info"}</DetailAccordion>
          <DetailAccordion label="Recent orders">No info</DetailAccordion>
          <DetailAccordion
            label={pages.length > 0 ? `Browsed pages (${pages.length})` : "Browsed pages"}
          >
            {pages.length > 0
              ? pages.map((page) => (
                  <div key={page} className="cin-page-url">
                    {page}
                  </div>
                ))
              : "No info"}
          </DetailAccordion>
        </div>

        <div className="cin-dcard">
          <div className="cin-cart-head">
            <span className="cin-dtitle sm">Shopping cart</span>
            {!cartViewEnabled ? <span className="cin-upgrade">👑 Upgrade</span> : null}
          </div>
          {!cartViewEnabled ? (
            <div className="cin-cf last">Upgrade your plan to see the visitor&apos;s live cart.</div>
          ) : cart.length === 0 ? (
            <div className="cin-cf last">No cart data yet.</div>
          ) : (
            <>
              {cart.map((line, i) => (
                <div key={i} className="cin-cart-item">
                  <span className="cin-cart-info">
                    <span className="cin-cart-name">{line.title || "Item"}</span>
                    {line.variant ? <span className="cin-cart-var">{line.variant}</span> : null}
                  </span>
                  <span className="cin-cart-price">
                    {typeof line.price === "number" ? fmt(line.price) : ""}
                  </span>
                </div>
              ))}
              <div className="cin-cart-total">
                <span>Cart total</span>
                <span className="cin-cart-price">
                  {fmt(
                    cartTotal(active.pageContext) ??
                      cart.reduce((sum, l) => sum + (l.price ?? 0) * (l.quantity ?? 1), 0),
                  )}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="cin-dcard">
          <span className="cin-dlabel">Satisfaction survey</span>
          {active.rating ? (
            <div className="cin-rating" aria-label={`Rated ${active.rating} out of 5`}>
              {Array.from({ length: 5 }, (_, i) => (
                <Star key={i} filled={i < (active.rating ?? 0)} />
              ))}
              <span className="cin-rating-note">{active.rating}/5</span>
            </div>
          ) : (
            <div className="cin-cf last">Visitor has not rated yet</div>
          )}
        </div>
      </div>

      <div className="cin-dfoot">
        <button type="button" className="cin-fb" onClick={onBlock} disabled={active.blocked}>
          {active.blocked ? "Blocked" : "Block"}
        </button>
        <button
          type="button"
          className="cin-fb del"
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            setConfirmDelete(false);
            onDelete();
          }}
        >
          {confirmDelete ? "Confirm?" : "Delete"}
        </button>
      </div>
    </div>
  );
}
