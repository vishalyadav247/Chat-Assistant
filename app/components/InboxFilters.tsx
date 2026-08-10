import { FILTERS, FILTER_ORDER, unreadOpenCount } from "./InboxShared";
import type { FilterKey, InboxRow } from "./InboxShared";

// Filters rail (design inbox.html left column). Counts are computed from the
// server-loaded rows; the "All" badge is the unread-open count in red — that
// badge doubles as the v1 handover/new-message notification surface.

export function InboxFilters({
  rows,
  filter,
  onSelect,
}: {
  rows: InboxRow[];
  filter: FilterKey;
  onSelect: (key: FilterKey) => void;
}) {
  const unread = unreadOpenCount(rows);
  return (
    <div className="cin-col cin-filcol">
      <div className="cin-fil-title">Inbox</div>
      <div className="cin-fil-grp">Conversations</div>
      {FILTER_ORDER.map((key) => {
        const def = FILTERS[key];
        const count = rows.filter(def.test).length;
        const active = key === filter;
        return (
          <button
            key={key}
            type="button"
            className={`cin-fil${active ? " active" : ""}`}
            onClick={() => onSelect(key)}
          >
            <span className="cin-fil-l">{def.label}</span>
            {key === "all" && unread > 0 ? (
              <span className="cin-fil-c red">{unread}</span>
            ) : count > 0 ? (
              <span className="cin-fil-c">{count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
