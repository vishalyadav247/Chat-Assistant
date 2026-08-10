import { useEffect, useState } from "react";
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

function browsedPages(pageContext: unknown): string[] {
  if (!pageContext || typeof pageContext !== "object") return [];
  const ctx = pageContext as { url?: unknown; pages?: unknown };
  if (Array.isArray(ctx.pages)) return ctx.pages.filter((p): p is string => typeof p === "string");
  return typeof ctx.url === "string" && ctx.url ? [ctx.url] : [];
}

export function InboxDetails({
  active,
  cartViewEnabled,
  currency,
  onBlock,
  onDelete,
}: {
  active: InboxDetail | null;
  cartViewEnabled: boolean;
  currency: string;
  onBlock: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const activeId = active?.id ?? null;
  useEffect(() => setConfirmDelete(false), [activeId]);

  if (!active) {
    return <div className="cin-col cin-details" />;
  }

  const pages = browsedPages(active.pageContext);
  const cart = cartLines(active.pageContext);
  const fmt = (value: number) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
    } catch {
      return `${currency} ${value.toFixed(2)}`;
    }
  };

  return (
    <div className="cin-col cin-details">
      <div className="cin-dscroll">
        <div className="cin-dtitle">Conversation details</div>

        <div className="cin-dcard">
          <div className="cin-cf">{active.contact?.name || "Customer name"}</div>
          <div className="cin-cf">{active.contact?.email || "Email"}</div>
          <div className="cin-cf last">{active.contact?.phone || "Phone number"}</div>
        </div>

        <div className="cin-dcard">
          <span className="cin-dlabel">Assignee</span>
          <div className="cin-assignee">
            <span className="cin-an">Unassigned</span>
            <button type="button" className="cin-assign" disabled title="Team coming soon">
              Assign
            </button>
          </div>
        </div>

        <div className="cin-dcard rows">
          <div className="cin-accrow">
            <span className="cin-at">Visitor device</span>
            <span className="cin-av2">No info</span>
          </div>
          <div className="cin-accrow">
            <span className="cin-at">Recent orders</span>
            <span className="cin-av2">No info</span>
          </div>
          {pages.length > 0 ? (
            <details className="cin-accrow acc">
              <summary>
                <span className="cin-at">Browsed pages</span>
                <span className="cin-av2">{pages.length}</span>
              </summary>
              {pages.map((page) => (
                <div key={page} className="cin-page-url">
                  {page}
                </div>
              ))}
            </details>
          ) : (
            <div className="cin-accrow">
              <span className="cin-at">Browsed pages</span>
              <span className="cin-av2">No info</span>
            </div>
          )}
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
                  {fmt(cart.reduce((sum, l) => sum + (l.price ?? 0) * (l.quantity ?? 1), 0))}
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
                <s-icon
                  key={i}
                  type={i < (active.rating ?? 0) ? "star-filled" : "star"}
                  size="small"
                />
              ))}
              <span className="cin-cf inlin">({active.rating}/5)</span>
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
