import { useEffect, useRef, useState } from "react";
import { FILTERS, FILTER_ORDER, FilterIcon } from "./InboxShared";
import type { FilterKey, InboxCounts } from "./InboxShared";

// Filters (design inbox.html left column). Counts come from the server as
// exact totals over ALL of the shop's conversations — counting the loaded rows
// instead would undercount every tab the moment a shop outgrows one page.
//
// Three presentations of the same tabs:
//   rail  — the ≥1041px navigation column (coloured glyph per tab, frosted
//           brand pill for the active one; see WORKSPACE_CSS).
//   bar   — phones (≤768px): a fixed five-slot tab bar welded to the bottom
//           edge. No sideways scrolling — a strip you have to drag hides state
//           and is a poor target while the other hand holds the phone — so the
//           four everyday tabs are always on screen and the rest live behind
//           "More", which adopts the active filter's own glyph and label
//           whenever one of them is selected. (Unread is not a filter but a
//           modifier that composes with them, so it sits beside the search.)
//   sheet — tablets/narrow windows, a bottom sheet. Deliberately NOT a left
//           drawer: the web shell's nav drawer already owns that gesture and
//           two identical left panels on one screen read as one control.

/** Bar slots, in order. Everything else falls into the "More" popover. */
const BAR_PRIMARY: FilterKey[] = ["all", "open", "unassigned", "handover"];
const BAR_OVERFLOW: FilterKey[] = FILTER_ORDER.filter((k) => !BAR_PRIMARY.includes(k));

function MoreIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 8.5h14M5 15.5h14" />
      <path d="M9 8.5v0M15 15.5v0" strokeWidth="3.4" />
    </svg>
  );
}

export function InboxFilters({
  counts,
  filter,
  onSelect,
  variant = "rail",
  onClose,
}: {
  counts: InboxCounts;
  filter: FilterKey;
  onSelect: (key: FilterKey) => void;
  variant?: "rail" | "sheet" | "bar";
  onClose?: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  // Escape closes the "More" popover before the page's own Escape handlers see
  // it (they close the thread/details overlays, which would be a surprise).
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMoreOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [moreOpen]);

  const tab = (key: FilterKey) => {
    const count = counts[key];
    const active = key === filter;
    return (
      <button
        key={key}
        type="button"
        data-k={key}
        aria-pressed={active}
        className={`cin-fil${active ? " active" : ""}`}
        onClick={() => {
          onSelect(key);
          setMoreOpen(false);
        }}
      >
        <span className="cin-fil-ic" aria-hidden="true">
          <FilterIcon filter={key} />
        </span>
        <span className="cin-fil-l">{FILTERS[key].label}</span>
        {count > 0 ? <span className="cin-fil-c">{count}</span> : null}
      </button>
    );
  };

  const tabs = FILTER_ORDER.map(tab);

  if (variant === "bar") {
    // An overflow filter is selected: the More slot becomes that filter, so the
    // bar never shows "All" highlighted while the list is showing something else.
    const spilled = BAR_OVERFLOW.includes(filter) ? filter : null;
    const moreCount = spilled ? counts[spilled] : 0;
    return (
      <div className="cin-fbar" role="group" aria-label="Filter conversations">
        {moreOpen ? (
          <button
            type="button"
            className="cin-fmore-scrim"
            aria-label="Close filter menu"
            onClick={() => setMoreOpen(false)}
          />
        ) : null}
        {BAR_PRIMARY.map(tab)}
        <div className="cin-fmore-wrap" ref={moreRef}>
          {moreOpen ? (
            <div className="cin-fmore" role="menu" aria-label="More filters">
              {BAR_OVERFLOW.map(tab)}
            </div>
          ) : null}
          <button
            type="button"
            data-k={spilled ?? undefined}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            className={`cin-fil${spilled ? " active" : ""}${moreOpen ? " open" : ""}`}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <span className="cin-fil-ic" aria-hidden="true">
              {spilled ? <FilterIcon filter={spilled} /> : <MoreIcon />}
            </span>
            <span className="cin-fil-l">{spilled ? FILTERS[spilled].label : "More"}</span>
            {moreCount > 0 ? <span className="cin-fil-c">{moreCount}</span> : null}
          </button>
        </div>
      </div>
    );
  }

  if (variant === "sheet") {
    return (
      <div className="cin-fsheet">
        <span className="cin-fsheet-grab" aria-hidden="true" />
        <div className="cin-fsheet-head">
          <span className="cin-fil-title">Filter conversations</span>
          <button
            type="button"
            className="cin-fsheet-x"
            aria-label="Close filters"
            onClick={onClose}
          >
            <s-icon type="x" />
          </button>
        </div>
        <div className="cin-fsheet-grid">{tabs}</div>
      </div>
    );
  }

  return (
    <div className="cin-col cin-filcol">
      <div className="cin-fil-head">
        <span className="cin-fil-title">Inbox</span>
        <span className="cin-fil-sub">
          {counts.all} conversation{counts.all === 1 ? "" : "s"}
        </span>
      </div>
      <div className="cin-fil-grp">Conversations</div>
      {tabs}
    </div>
  );
}
