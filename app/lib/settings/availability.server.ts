import type { AvailabilityData } from "./schemas";

// Availability engine (spec 16): resolves the shop's live chat status
// (online / offline / break / holiday) and the {{schedule}} merge value
// (next opening time) in the SHOP's timezone. Consumed by the widget status
// line (05), handover aiWhileWaiting=outside_hours (08/10), and settings UI (16).

export type ChatStatus = "online" | "offline" | "break" | "holiday";

export interface ResolvedAvailability {
  status: ChatStatus;
  message: string; // status message with {{schedule}} resolved
  withinWorkingHours: boolean;
}

interface ZonedNow {
  weekday: number; // 0=Sun .. 6=Sat
  minutes: number; // minutes since midnight local
  dateKey: string; // YYYY-MM-DD local
}

function zonedNow(timezone: string, now = new Date()): ZonedNow {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    weekday: weekdays.indexOf(parts.weekday as string),
    minutes: Number(parts.hour === "24" ? 0 : parts.hour) * 60 + Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function resolveAvailability(
  availability: AvailabilityData,
  timezone: string,
  agentOnline = false,
  now = new Date(),
): ResolvedAvailability {
  const zone = zonedNow(timezone, now);

  // Holiday check (date range inclusive, local date keys)
  if (availability.holidays.enabled) {
    const holiday = availability.holidays.items.find((h) => h.from <= zone.dateKey && zone.dateKey <= h.to);
    if (holiday) {
      const schedule = nextOpening(availability, timezone, now) ?? "soon";
      return { status: "holiday", message: fill(availability.messages.holiday, schedule), withinWorkingHours: false };
    }
  }

  const withinHours = isWithinWorkingHours(availability, zone);

  // Break check (only meaningful inside working hours)
  if (withinHours && availability.breaks.enabled) {
    const inBreak = availability.breaks.ranges.some(
      (r) => toMinutes(r.from) <= zone.minutes && zone.minutes < toMinutes(r.to),
    );
    if (inBreak) {
      const backAt = availability.breaks.ranges
        .filter((r) => toMinutes(r.from) <= zone.minutes && zone.minutes < toMinutes(r.to))
        .map((r) => formatTime(toMinutes(r.to)))[0];
      return { status: "break", message: fill(availability.messages.break, backAt ?? "soon"), withinWorkingHours: true };
    }
  }

  // Online-status display mode
  let online: boolean;
  switch (availability.onlineStatusMode) {
    case "working_hours_or_agent":
      online = withinHours || agentOnline;
      break;
    case "agent_during_hours":
      online = withinHours && agentOnline;
      break;
    case "working_hours":
    default:
      online = withinHours;
  }

  if (online) {
    return { status: "online", message: availability.messages.online, withinWorkingHours: withinHours };
  }
  const schedule = nextOpening(availability, timezone, now) ?? "soon";
  return { status: "offline", message: fill(availability.messages.offline, schedule), withinWorkingHours: withinHours };
}

export function isWithinWorkingHours(availability: AvailabilityData, zone: ZonedNow): boolean {
  if (availability.mode === "always") return true;
  const today = availability.days.find((d) => d.day === zone.weekday);
  if (!today?.enabled) return false;
  return toMinutes(today.from) <= zone.minutes && zone.minutes < toMinutes(today.to);
}

/** Human "{{schedule}}" value: "9 AM", "Monday 9 AM", or null if 24/7. */
export function nextOpening(availability: AvailabilityData, timezone: string, now = new Date()): string | null {
  if (availability.mode === "always") return null;
  const zone = zonedNow(timezone, now);

  for (let offset = 0; offset <= 7; offset++) {
    const weekday = (zone.weekday + offset) % 7;
    const day = availability.days.find((d) => d.day === weekday);
    if (!day?.enabled) continue;
    const openAt = toMinutes(day.from);
    if (offset === 0 && zone.minutes >= openAt) continue; // already past today's opening
    const time = formatTime(openAt);
    if (offset === 0) return time;
    if (offset === 1) return `tomorrow ${time}`;
    return `${DAY_NAMES[weekday]} ${time}`;
  }
  return null;
}

function fill(template: string, schedule: string): string {
  return template.replace(/\{\{\s*schedule\s*\}\}/g, schedule);
}
