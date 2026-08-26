import { FILTERS, FILTER_ORDER } from "./InboxShared";
import type { FilterKey, InboxCounts } from "./InboxShared";

// Filters rail (design inbox.html left column). Counts come from the server as
// exact totals over ALL of the shop's conversations — counting the loaded rows
// instead would undercount every tab the moment a shop outgrows one page.
// Unread notification lives on the list column's Unread toggle (red bubble), so
// every tab badge here is a plain category count.

export function InboxFilters({
  counts,
  filter,
  onSelect,
}: {
  counts: InboxCounts;
  filter: FilterKey;
  onSelect: (key: FilterKey) => void;
}) {
  return (
    <div className="cin-col cin-filcol">
      <div className="cin-fil-title">Inbox</div>
      <div className="cin-fil-grp">Conversations</div>
      {FILTER_ORDER.map((key) => {
        const def = FILTERS[key];
        const count = counts[key];
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
