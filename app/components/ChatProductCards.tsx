import { BRAND, INK, RADIUS } from "./ui/tokens";

// The product cards the AI recommended, as the MERCHANT sees them (inbox
// thread + Test AI console). The shopper's copy is built by the storefront
// renderer (widget-renderer.js productCards); this is a read-only mirror of it.
//
// Read-only is the point. The storefront card carries "Add to cart" because
// the shopper owns that decision; an agent reading a transcript does not, and
// a working buy button in the inbox would put items in someone else's cart.
// "View" stays, because "what did the AI actually show them?" is the question
// an agent opens the thread to answer.

export interface ChatProductCard {
  shopifyProductId: string;
  title: string;
  price: number;
  imageUrl: string | null;
  handle: string;
  variantId?: string | null;
}

/**
 * Storefront URL for a card. Cards store the handle rather than the resolved
 * onlineStoreUrl, so the link is rebuilt here; without a shop domain (Test AI,
 * where the console is not tied to a storefront origin) it stays relative.
 */
function productHref(handle: string, shopDomain?: string): string | null {
  if (!handle) return null;
  return shopDomain ? `https://${shopDomain}/products/${handle}` : `/products/${handle}`;
}

export function ChatProductCards(props: {
  cards: ChatProductCard[];
  currency: string;
  /** Storefront domain, for absolute product links from inside the admin. */
  shopDomain?: string;
  /** Cards sit under a merchant bubble (right-aligned column) when true. */
  align?: "start" | "end";
}) {
  if (!props.cards.length) return null;
  const money = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: props.currency || "USD",
    maximumFractionDigits: 2,
  });
  return (
    <div className={`cin-cards ${props.align === "end" ? "end" : "start"}`} role="list">
      {props.cards.map((card) => {
        const href = productHref(card.handle, props.shopDomain);
        return (
          <div className="cin-card" key={card.shopifyProductId} role="listitem">
            {card.imageUrl ? (
              <img className="cin-card-img" src={card.imageUrl} alt="" loading="lazy" />
            ) : (
              <div className="cin-card-img" aria-hidden="true" />
            )}
            <div className="cin-card-body">
              <div className="cin-card-t" title={card.title}>
                {card.title}
              </div>
              <div className="cin-card-p">{money.format(card.price)}</div>
              {href ? (
                <a
                  className="cin-card-link"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View product ↗
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Inline styles for the Test AI console, which has no cin-* stylesheet. */
//
// The row scrolls horizontally instead of wrapping, matching .cw-cards in the
// storefront widget: inside a chat bubble the column is far narrower than two
// cards, so wrapping stacked them one per line and buried the third recommend-
// ation below the fold. Same 6px hover-revealed scrollbar as the storefront.
//
// Alignment is `align-self`, NOT `justify-content: flex-end`. On an overflowing
// flex scroller, end-justification pushes the first cards past scrollLeft 0
// where no browser lets you scroll back to them — and AI messages render on the
// right ("out") side of the inbox thread, so that is the common case here.
// align-self shrink-to-fits when the cards fit and fills-then-scrolls when they
// do not, which is right in both directions.
export const CHAT_CARD_CSS = `
.cin-cards{display:flex;flex-wrap:nowrap;gap:8px;margin-top:6px;max-width:100%;overflow-x:auto;padding:2px 2px 6px;scrollbar-width:thin;scrollbar-color:transparent transparent;}
.cin-cards.start{align-self:flex-start;}
.cin-cards.end{align-self:flex-end;}
.cin-cards:hover{scrollbar-color:#c9c9d2 transparent;}
.cin-cards::-webkit-scrollbar{height:6px;}
.cin-cards::-webkit-scrollbar-track{background:transparent;}
.cin-cards::-webkit-scrollbar-thumb{background:transparent;border-radius:8px;}
.cin-cards:hover::-webkit-scrollbar-thumb{background:#c9c9d2;}
.cin-card{flex:none;width:148px;background:#fff;border-radius:${RADIUS.banner}px;overflow:hidden;box-shadow:0 1px 2px rgba(20,20,25,.05),inset 0 0 0 1px ${INK.borderSoft};}
.cin-card-img{display:block;width:100%;height:92px;object-fit:cover;background:#f1f1f4;border:0;}
.cin-card-body{padding:7px 9px 9px;display:flex;flex-direction:column;gap:2px;}
.cin-card-t{font-size:12px;font-weight:650;color:#2b2b30;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.cin-card-p{font-size:12px;font-weight:750;color:#1a1a1f;}
.cin-card-link{font-size:11.5px;font-weight:650;color:${BRAND.accent};text-decoration:none;margin-top:2px;}
.cin-card-link:hover{text-decoration:underline;}
`;
