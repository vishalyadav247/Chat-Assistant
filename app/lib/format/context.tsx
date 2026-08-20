import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_DATETIME_PREFS,
  formatDate,
  formatDateTime,
  formatDayLabel,
  formatRelative,
  formatTime,
  type DateTimePrefs,
} from "./datetime";

// Shop-wide date/time preference for React trees (provided by app/routes/app.tsx
// on both surfaces). Components call `const dt = useDateTime()` and render
// `dt.date(iso)`, `dt.time(iso)`, `dt.dateTime(iso)`, `dt.relative(iso)`,
// `dt.dayLabel(iso)`.

export interface DateTimeApi {
  prefs: DateTimePrefs;
  date: (value: string | number | Date, opts?: { year?: boolean }) => string;
  time: (value: string | number | Date) => string;
  dateTime: (value: string | number | Date) => string;
  relative: (value: string | number | Date) => string;
  dayLabel: (value: string | number | Date) => string;
}

export function makeDateTimeApi(prefs: DateTimePrefs): DateTimeApi {
  return {
    prefs,
    date: (v, opts) => formatDate(v, prefs, opts),
    time: (v) => formatTime(v, prefs),
    dateTime: (v) => formatDateTime(v, prefs),
    relative: (v) => formatRelative(v, prefs),
    dayLabel: (v) => formatDayLabel(v, prefs),
  };
}

const DateTimeContext = createContext<DateTimeApi>(makeDateTimeApi(DEFAULT_DATETIME_PREFS));

export function DateTimeProvider({ prefs, children }: { prefs: DateTimePrefs; children: ReactNode }) {
  const api = useMemo(() => makeDateTimeApi(prefs), [prefs]);
  return <DateTimeContext.Provider value={api}>{children}</DateTimeContext.Provider>;
}

export function useDateTime(): DateTimeApi {
  return useContext(DateTimeContext);
}
