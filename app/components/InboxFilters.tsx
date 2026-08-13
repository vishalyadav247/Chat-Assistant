import { FILTERS, FILTER_ORDER } from "./InboxShared";
import type { FilterKey, InboxRow } from "./InboxShared";

// Filters rail (design inbox.html left column). Counts are computed from the
// server-loaded rows. Unread notification lives on the list column's Unread
// toggle (red bubble), so every tab badge here is a plain category count.

export function InboxFilters({
  rows,
  filter,
  onSelect,
}: {
  rows: InboxRow[];
  filter: FilterKey;
  onSelect: (key: FilterKey) => void;
}) {
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
            {count > 0 ? <span className="cin-fil-c">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
