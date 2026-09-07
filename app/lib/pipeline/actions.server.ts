import { splitLeadingLine, type LeadingLineStream } from "./picks.server";
import type { WidgetSettingsData } from "../settings/schemas";

// In-widget actions the agent may offer.
//
// WHY (production transcript, ankastra.myshopify.com, 2026-09-04):
//
//     shopper: how can i track my previous orders
//     agent:   … Just click on the "Track" navigation …
//
// There is no "Track" navigation. The agent was describing the widget's own
// Order tracking screen, which lives INSIDE the chat panel — no link on the
// storefront can reach it, and AI bubbles render as plain text anyway, so even
// a real URL would have arrived dead. The shopper was told to click something
// that does not exist.
//
// The model does not get to invent a destination. It picks a key from a list
// of screens this shop actually has switched on, code renders the button, and
// the button calls the widget's existing deep-link handler (`#cc-track` and
// friends). Same contract as the buy lane's PICKS line: the model chooses
// among things code already decided are available.

export type ActionKey = "track_order" | "contact_team" | "browse_faq";

export interface ChatAction {
  key: ActionKey;
  /** Button caption. Code owns this — the model never writes shopper-facing UI. */
  label: string;
  /** Widget screen the deep-link handler opens (chat-widget.js DEEP_LINKS). */
  screen: "tracking" | "chat" | "home";
}

const CATALOG: Record<ActionKey, { label: string; screen: ChatAction["screen"]; hint: string }> = {
  track_order: {
    label: "Track my order",
    screen: "tracking",
    hint: "look up an order's status by order or tracking number",
  },
  contact_team: {
    label: "Contact the team",
    screen: "home",
    hint: "reach a human on the store's team",
  },
  browse_faq: {
    label: "Browse help articles",
    screen: "home",
    hint: "read the store's own help articles",
  },
};

/** The actions this shop has actually switched on. Order is the order the
 *  buttons appear in. */
export function availableActions(widget: WidgetSettingsData): ChatAction[] {
  const out: ChatAction[] = [];
  if (widget.orderTracking) out.push({ key: "track_order", ...pick("track_order") });
  // The contact block is both a switch and a list — offering it with the
  // switch on but nothing in it would open a screen with no way to contact anyone.
  if (widget.contactMethods?.enabled && widget.contactMethods.items.length > 0) {
    out.push({ key: "contact_team", ...pick("contact_team") });
  }
  if (widget.faqs) out.push({ key: "browse_faq", ...pick("browse_faq") });
  return out;
}

function pick(key: ActionKey): { label: string; screen: ChatAction["screen"] } {
  return { label: CATALOG[key].label, screen: CATALOG[key].screen };
}

/**
 * The prompt fragment telling the model what the widget can do for the shopper.
 *
 * The "never describe it as a link or a page" clause is the whole point: left
 * to itself the model narrates storefront navigation that does not exist.
 */
export function actionInstruction(actions: ChatAction[]): string {
  if (actions.length === 0) {
    // Still worth saying: with nothing to offer, the model must not invent one.
    return "You are replying inside a chat window, not on a web page. Never tell the shopper to click a link, a tab or a menu item, and never write a URL — you cannot see the store's navigation.";
  }
  const list = actions.map((a) => `${a.key} — ${CATALOG[a.key].hint}`).join("; ");
  // The first-line rule has to lead. Buried at the end of a prompt that already
  // says "answer in 1-3 sentences", the model went straight into prose and the
  // line never appeared (verified against the live catalogue 2026-09-04).
  return [
    "BEFORE anything else, write one line of exactly `ACTION: <key>` (example: `ACTION: track_order`), or `ACTION: none` when none applies. Write this line on EVERY reply, then your answer on the next line.",
    `The keys are: ${list}.`,
    "The shopper never sees that line — it is removed, and the key you name becomes a button under your reply. So point at it as the button below, and never tell the shopper to click a link, a tab or a menu item on the website, or write a URL: you cannot see the store's navigation and it will not match what you describe.",
  ].join(" ");
}

/** `ACTION: …`, tolerating the markdown the model sometimes wraps it in. */
const ACTION_LINE = /^[\s*#>_-]*actions?\b[\s*_]*(?:[:=-]+[\s*_]*)?(.*)$/i;
const ACTION_SEPARATOR = /^[\s*#>_-]*actions?\b[\s*_]*[:=-]/i;
const NONE_BODY = /^(none|nothing|no|n\/a|nil|null|-)?[.!]?$/i;

/**
 * Parse one line of model output into action keys.
 *
 * `null` means "not an action line" — leave the text alone. An empty array
 * means the model explicitly declined, which is the common case and must be
 * distinguishable from "no line at all" so the line still gets stripped.
 * Unknown keys are dropped rather than trusted: like the PICKS ids, a key
 * outside the allow-list is a model mistake, not a new feature.
 */
export function parseActionLine(line: string, allowed: ChatAction[]): ActionKey[] | null {
  const trimmed = line.trim();
  const match = ACTION_LINE.exec(trimmed);
  if (!match) return null;
  // Strip the markdown the model wraps things in — but NOT the underscore,
  // which is part of every key. Borrowing parsePicksLine's stripper verbatim
  // turned `track_order` into `trackorder`, which matched nothing, so the line
  // was consumed and no button ever appeared.
  const body = match[1].replace(/[*`[\]()]/g, "").trim();
  const separated = ACTION_SEPARATOR.test(trimmed);
  if (NONE_BODY.test(body)) return separated || body.length > 0 ? [] : null;
  // Without a separator, only a bare key list counts — prose that happens to
  // start with "Action" must survive untouched.
  if (!separated && !/^[a-z_,;\s]+$/i.test(body)) return null;
  const allowedKeys = new Set(allowed.map((a) => a.key));
  const keys: ActionKey[] = [];
  for (const raw of body.split(/[,;/\s]+/)) {
    const key = raw.trim().toLowerCase() as ActionKey;
    if (allowedKeys.has(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export interface ActionStream extends LeadingLineStream<ActionKey[]> {
  /** The chosen actions, resolved against the allow-list. Empty until the
   *  text stream has been consumed. */
  actions(): ChatAction[];
}

/** Strip a leading `ACTION:` line off a reply stream and keep what it named. */
export function splitActionStream(
  source: AsyncIterable<string>,
  allowed: ChatAction[],
): ActionStream {
  const split = splitLeadingLine(source, (line) => parseActionLine(line, allowed));
  return {
    text: split.text,
    result: () => split.result(),
    actions: () => {
      const keys = split.result().parsed ?? [];
      return keys
        .map((key) => allowed.find((a) => a.key === key))
        .filter((a): a is ChatAction => Boolean(a));
    },
  };
}
