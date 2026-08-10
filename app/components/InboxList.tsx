import { avatarGradient, displayName, initials, relTime } from "./InboxShared";
import type { InboxRow } from "./InboxShared";

// List column (design inbox.html): title = filter label, unread-only toggle,
// client-side search by contact name, rows with avatar/★/time/unread dot/
// preview/tags. Empty state: "Nothing here yet."

export function InboxList({
  title,
  rows,
  activeId,
  unreadOnly,
  onToggleUnread,
  search,
  onSearch,
  onSelect,
}: {
  title: string;
  rows: InboxRow[];
  activeId: string | null;
  unreadOnly: boolean;
  onToggleUnread: () => void;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (row: InboxRow) => void;
}) {
  return (
    <div className="cin-col cin-listcol">
      <div className="cin-list-top">
        <div className="cin-list-head">
          <span className="cin-list-title">{title}</span>
          <button type="button" className="cin-unread-toggle" onClick={onToggleUnread}>
            Unread
            <span className={`cin-switch${unreadOnly ? " on" : ""}`} aria-hidden="true" />
          </button>
        </div>
        <input
          className="cin-lsearch"
          placeholder="Search by name"
          aria-label="Search conversations by name"
          value={search}
          onChange={(e) => onSearch(e.currentTarget.value)}
        />
      </div>
      <div className="cin-conv-scroll">
        {rows.length === 0 ? (
          <div className="cin-list-empty">Nothing here yet.</div>
        ) : (
          rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className={`cin-conv${row.id === activeId ? " active" : ""}${row.unread ? " unread" : ""}`}
              onClick={() => onSelect(row)}
            >
              <span className="cin-cav" style={{ background: avatarGradient(row.id) }}>
                {initials(row.name)}
              </span>
              <span className="cin-cbody">
                <span className="cin-ctop">
                  <span className="cin-cname">
                    {displayName(row.name)}
                    {row.starred ? (
                      <span className="cin-tinystar">
                        <s-icon type="star-filled" size="small" />
                      </span>
                    ) : null}
                  </span>
                  <span className="cin-ctime">{relTime(row.lastMessageAt)}</span>
                  {row.unread ? <span className="cin-cdot" /> : null}
                </span>
                <span className="cin-cprev">{row.preview || "No messages yet"}</span>
                <span className="cin-tags">
                  <span className="cin-tag chan">Online store</span>
                  {row.handover ? <span className="cin-tag hand">Handover</span> : null}
                  {row.mode === "ai" && row.status === "open" ? (
                    <span className="cin-tag proc">AI</span>
                  ) : null}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
