import { useEffect, useRef, useState } from "react";
import { useDateTime } from "../lib/format/context";
import {
  authorLabel,
  avatarGradient,
  displayName,
  initials,
  StarIcon,
} from "./InboxShared";
import type { InboxDetail } from "./InboxShared";

// Thread column (design inbox.html): header (name, Anonymous tag, star,
// Resolve/Reopen, kebab), messages (day dividers, in/out bubbles, sys rows,
// Seen receipt) and the composer (Enter=send, Shift+Enter=newline, emoji
// strip, Send disabled until text).

const EMOJI = ["😀", "😅", "👍", "🙏", "❤️", "🎉"];

export function InboxThread({
  active,
  busy,
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
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const msgsRef = useRef<HTMLDivElement>(null);
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
                <span
                  className={`cin-mpa${out ? " bot" : ""}`}
                  style={out ? undefined : { background: avatarGradient(active.id) }}
                >
                  {out ? "CC" : initials(active.contact?.name || active.contact?.email || null)}
                </span>
                <span className="cin-mwrap">
                  <span className="cin-mmeta">
                    {authorLabel(m, active.contact?.name || active.contact?.email || null)} ·{" "}
                    {dt.time(m.createdAt)}
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
          className="cin-comp-input"
          placeholder="Type a reply…"
          rows={2}
          maxLength={2000}
          value={text}
          disabled={active.blocked}
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
