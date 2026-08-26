import { useEffect, useRef, useState } from "react";
import { useDateTime } from "../lib/format/context";
import { useIsMobile } from "../lib/ui/use-mobile";
import {
  authorLabel,
  avatarGradient,
  displayName,
  initials,
  StarIcon,
} from "./InboxShared";
import type { InboxDetail, InboxMessage } from "./InboxShared";

// Thread column (design inbox.html): header (name, Anonymous tag, star,
// Resolve/Reopen, kebab), messages (day dividers, in/out bubbles, sys rows,
// Seen receipt) and the composer (Enter=send, Shift+Enter=newline, emoji
// strip, Send disabled until text).

const EMOJI = ["😀", "😅", "👍", "🙏", "❤️", "🎉"];

/** Composer stops growing here and scrolls instead. */
const COMPOSER_MAX_ROWS = 3;

export function InboxThread({
  active,
  busy,
  botAvatar,
  team,
  onBack,
  onShowDetails,
  onStar,
  onResolveToggle,
  onSend,
  onBlock,
  onDelete,
}: {
  active: InboxDetail | null;
  busy: boolean;
  /** Identity the shopper sees on AI replies (Chatbox → avatar mode). */
  botAvatar: { url: string | null; name: string };
  /** Team roster (id → display name) for attributing human replies. */
  team: Array<{ id: string; name: string }>;
  /** Mobile only (spec 19): clears ?c= to return to the conversation list. */
  onBack: () => void;
  /** Opens the details slide-over where the Details column is hidden (<1241px). */
  onShowDetails: () => void;
  onStar: () => void;
  onResolveToggle: () => void;
  onSend: (content: string) => void;
  onBlock: () => void;
  onDelete: () => void;
}) {
  const dt = useDateTime();
  // Phones get a one-row composer (spec 20) — every pixel it doesn't take is
  // conversation the agent can read.
  const isMobile = useIsMobile();
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeId = active?.id ?? null;

  // Reset composer + pin scroll to the newest message per conversation/update.
  useEffect(() => {
    setText("");
    setMenuOpen(false);
    setConfirmDelete(false);
  }, [activeId]);
  const messageCount = active?.messages.length ?? 0;
  useEffect(() => {
    const node = msgsRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [activeId, messageCount]);

  // Keep the newest message pinned when the pane itself resizes — the JS
  // height fit runs after mount, and on phones the on-screen keyboard shrinks
  // the workspace every time the composer is focused. Without this the last
  // bubble ends up clipped behind the composer.
  useEffect(() => {
    const node = msgsRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeId]);

  // Composer grows with the reply up to COMPOSER_MAX_ROWS lines, then scrolls
  // — same behaviour as the storefront composer (widget-renderer inputBar).
  // The cap is derived from the computed line height rather than a px
  // constant because the mobile media query bumps this field to 16px.
  useEffect(() => {
    const ta = composerRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (!ta.scrollHeight) {
      ta.style.height = "";
      return;
    }
    const cs = getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
    const chrome =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const max = Math.ceil(line * COMPOSER_MAX_ROWS + pad + chrome);
    const full = ta.scrollHeight + chrome;
    ta.style.height = `${Math.min(full, max)}px`;
    ta.style.overflowY = full > max ? "auto" : "hidden";
  }, [text, activeId, isMobile]);

  if (!active) {
    return (
      <div className="cin-col cin-threadcol">
        <div className="cin-thread-empty">Nothing here yet.</div>
      </div>
    );
  }

  const resolved = active.status === "resolved";
  const name = displayName(active.contact?.name || active.contact?.email || null);
  const lastSeenId = [...active.messages]
    .reverse()
    .find((m) => m.role === "out" && m.author === "agent" && m.seenAt)?.id;

  const send = () => {
    const content = text.trim();
    if (!content || busy) return;
    onSend(content);
    setText("");
  };

  // id → display name, for attributing each human reply to its sender.
  const teamNames = new Map(team.map((t) => [t.id, t.name]));

  let lastDay = "";

  return (
    <div className="cin-col cin-threadcol">
      <div className="cin-th-head">
        <button
          type="button"
          className="cin-back"
          aria-label="Back to conversations"
          onClick={onBack}
        >
          <s-icon type="arrow-left" />
        </button>
        <span className="cin-th-name">{name}</span>
        {!active.contact ? <span className="cin-th-tag">Anonymous</span> : null}
        <span className="cin-sp" />
        <button
          type="button"
          className="cin-infobtn"
          aria-label="Conversation details"
          onClick={onShowDetails}
        >
          <s-icon type="info" />
        </button>
        <button
          type="button"
          className={`cin-star${active.starred ? " on" : ""}`}
          aria-label={active.starred ? "Unstar conversation" : "Star conversation"}
          onClick={onStar}
        >
          <StarIcon filled={active.starred} size={17} />
        </button>
        <button
          type="button"
          className={`cin-resolve${resolved ? " done" : ""}`}
          onClick={onResolveToggle}
          disabled={busy}
        >
          {resolved ? (
            <>
              <s-icon type="check" size="small" /> Resolved
            </>
          ) : (
            "Resolve"
          )}
        </button>
        <span className="cin-kebab-wrap">
          <button
            type="button"
            className="cin-kebab"
            aria-label="Conversation actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <span className="cin-menu">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onBlock();
                }}
                disabled={active.blocked}
              >
                {active.blocked ? "Blocked" : "Block visitor"}
              </button>
              <button
                type="button"
                className="del"
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  setMenuOpen(false);
                  setConfirmDelete(false);
                  onDelete();
                }}
              >
                {confirmDelete ? "Confirm delete?" : "Delete conversation"}
              </button>
            </span>
          ) : null}
        </span>
      </div>

      <div className="cin-msgs" ref={msgsRef}>
        {active.messages.map((m) => {
          const day = dt.dayLabel(m.createdAt);
          const divider =
            day !== lastDay ? (
              <div className="cin-mtime" key={`day-${m.id}`}>
                {day}
              </div>
            ) : null;
          lastDay = day;

          if (m.role === "sys") {
            return (
              <span key={m.id}>
                {divider}
                <div className="cin-sys">{m.content}</div>
              </span>
            );
          }
          const out = m.role === "out";
          return (
            <span key={m.id}>
              {divider}
              <div className={`cin-mline ${out ? "out" : "in"}`}>
                <MessageAvatar
                  message={m}
                  conversationId={active.id}
                  contactName={active.contact?.name || active.contact?.email || null}
                  botAvatar={botAvatar}
                  teamNames={teamNames}
                />
                <span className="cin-mwrap">
                  <span className="cin-mmeta">
                    {authorLabel(
                      m,
                      active.contact?.name || active.contact?.email || null,
                      teamNames,
                      botAvatar.name,
                    )}{" "}
                    · {dt.time(m.createdAt)}
                  </span>
                  <span className={`cin-bubble ${out ? "out" : "in"}`}>{m.content}</span>
                </span>
              </div>
              {m.id === lastSeenId ? <div className="cin-seen">Seen</div> : null}
            </span>
          );
        })}
      </div>

      <div className="cin-composer">
        <textarea
          ref={composerRef}
          className="cin-comp-input"
          aria-label="Type a reply"
          placeholder="Type a reply…"
          rows={isMobile ? 1 : 2}
          maxLength={2000}
          value={text}
          disabled={active.blocked}
          onFocus={() => {
            if (!isMobile) return;
            // Opening the keyboard makes the browser scroll the focused field
            // into view, which drags the whole fixed-height workspace up and
            // crops the thread header. Undo that once the keyboard has settled
            // and keep the newest message in sight.
            window.setTimeout(() => {
              window.scrollTo(0, 0);
              const node = msgsRef.current;
              if (node) node.scrollTop = node.scrollHeight;
            }, 300);
          }}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="cin-comp-bar">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="cin-emoji"
              aria-label={`Insert ${emoji}`}
              disabled={active.blocked}
              onClick={() => setText((t) => t + emoji)}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            className="cin-send"
            aria-label="Send reply"
            disabled={!text.trim() || busy || active.blocked}
            onClick={send}
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}

/** Each bubble carries its real sender: the shopper's initials, the store
 *  identity the shopper sees on AI replies (logo or name initials), or the
 *  team member who typed it. Replies sent before members were recorded — and
 *  those sent from the Shopify admin — fall back to the store identity. */
function MessageAvatar({
  message,
  conversationId,
  contactName,
  botAvatar,
  teamNames,
}: {
  message: InboxMessage;
  conversationId: string;
  contactName: string | null;
  botAvatar: { url: string | null; name: string };
  teamNames: Map<string, string>;
}) {
  if (message.role !== "out") {
    return (
      <span className="cin-mpa" style={{ background: avatarGradient(conversationId) }} title={displayName(contactName)}>
        {initials(contactName)}
      </span>
    );
  }
  const memberName = message.authorMemberId ? teamNames.get(message.authorMemberId) : undefined;
  if (message.author === "agent" && memberName) {
    return (
      <span className="cin-mpa agent" style={{ background: avatarGradient(message.authorMemberId!) }} title={memberName}>
        {initials(memberName)}
      </span>
    );
  }
  if (botAvatar.url) {
    return (
      <span className="cin-mpa bot img" title={botAvatar.name}>
        <img src={botAvatar.url} alt="" />
      </span>
    );
  }
  return (
    <span className="cin-mpa bot" title={botAvatar.name}>
      {initials(botAvatar.name)}
    </span>
  );
}
