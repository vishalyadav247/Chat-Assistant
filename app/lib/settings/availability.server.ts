import db from "../../db.server";
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
  if (isHolidayOn(availability, zone.dateKey)) {
    const schedule = nextOpening(availability, timezone, now) ?? "soon";
    return { status: "holiday", message: fill(availability.messages.holiday, schedule), withinWorkingHours: false };
  }

  const withinHours = isWithinWorkingHours(availability, zone);

  // Break check (only meaningful inside working hours)
  if (withinHours && availability.breaks.enabled) {
    const active = availability.breaks.ranges.filter((r) => inTimeRange(r.from, r.to, zone.minutes));
    if (active.length > 0) {
      const backAt = formatTime(toMinutes(active[0].to));
      return { status: "break", message: fill(availability.messages.break, backAt), withinWorkingHours: true };
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

/** True when `minutes` falls in [from, to); a `to` earlier than `from` spans
 *  midnight (e.g. 22:00 → 02:00). */
export function inTimeRange(from: string, to: string, minutes: number): boolean {
  const start = toMinutes(from);
  const end = toMinutes(to);
  if (start === end) return false;
  return start < end
    ? start <= minutes && minutes < end
    : minutes >= start || minutes < end;
}

export function isWithinWorkingHours(availability: AvailabilityData, zone: ZonedNow): boolean {
  if (availability.mode === "always") return true;
  const today = availability.days.find((d) => d.day === zone.weekday);
  if (today?.enabled && inTimeRange(today.from, today.to, zone.minutes)) return true;
  // Overnight hours from the previous weekday still cover the early morning.
  const yesterday = availability.days.find((d) => d.day === (zone.weekday + 6) % 7);
  if (yesterday?.enabled && toMinutes(yesterday.to) < toMinutes(yesterday.from)) {
    return zone.minutes < toMinutes(yesterday.to);
  }
  return false;
}

/** YYYY-MM-DD only. Anything else is ignored rather than compared as a string
 *  (the save path rejects it — see settings/save.server.ts — but seeds,
 *  imports and direct DB writes bypass that). */
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** True when `dateKey` (local YYYY-MM-DD) falls inside an enabled holiday. */
export function isHolidayOn(availability: AvailabilityData, dateKey: string): boolean {
  if (!availability.holidays.enabled) return false;
  return availability.holidays.items.some(
    (h) => DATE_KEY.test(h.from) && DATE_KEY.test(h.to) && h.from <= dateKey && dateKey <= h.to,
  );
}

/** Calendar-day arithmetic on a local date key (DST-safe: no clock maths). */
function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// A holiday can span more than a week, so the search window is two weeks
// rather than the seven days a pure weekly schedule needs.
const OPENING_SEARCH_DAYS = 14;

/** Human "{{schedule}}" value: "9 AM", "Monday 9 AM", or null if 24/7. */
export function nextOpening(availability: AvailabilityData, timezone: string, now = new Date()): string | null {
  if (availability.mode === "always") return null;
  const zone = zonedNow(timezone, now);

  for (let offset = 0; offset <= OPENING_SEARCH_DAYS; offset++) {
    const weekday = (zone.weekday + offset) % 7;
    const day = availability.days.find((d) => d.day === weekday);
    if (!day?.enabled) continue;
    // A working day that falls on a holiday is still closed — without this the
    // holiday copy read "Off today · Back at 9 AM" on day 1 of a 3-day break.
    if (isHolidayOn(availability, addDays(zone.dateKey, offset))) continue;
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

// ── Agent presence ("agent online", spec 16) ────────────────────────────────
// Spec 16 defines "agent online" as an admin session active in the inbox.
// There is no presence column, so presence is two cheap signals OR'd together:
//   1. an in-process heartbeat that inbox.server.ts stamps whenever a human
//      loads or acts on the inbox (embedded admin AND the web app go through
//      those functions), and
//   2. a `human_replied` analytics event inside the same window — index-only
//      on (shopId, type, occurredAt), and the only signal that survives a
//      multi-instance deploy where the heartbeat lives in another process.

export const AGENT_PRESENCE_WINDOW_MS = 5 * 60 * 1000;
const PRESENCE_PROBE_TTL_MS = 30_000; // memo so a busy widget can't hammer the DB

declare global {
  // eslint-disable-next-line no-var
  var agentPresenceBeats: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var agentPresenceProbe: Map<string, { at: number; online: boolean }> | undefined;
}

/** Stamp "a human is at the inbox right now" for this shop. */
export function touchAgentPresence(shopId: string): void {
  if (!shopId) return;
  if (!global.agentPresenceBeats) global.agentPresenceBeats = new Map();
  const beats = global.agentPresenceBeats;
  beats.set(shopId, Date.now());
  if (beats.size > 5000) {
    const cutoff = Date.now() - AGENT_PRESENCE_WINDOW_MS;
    for (const [key, at] of beats) if (at < cutoff) beats.delete(key);
  }
}

/** True when a team member counts as online for this shop right now. */
export async function isAgentOnline(shopId: string, now = new Date()): Promise<boolean> {
  if (!shopId) return false;
  const cutoff = now.getTime() - AGENT_PRESENCE_WINDOW_MS;
  const beat = global.agentPresenceBeats?.get(shopId);
  if (beat !== undefined && beat > cutoff) return true;

  if (!global.agentPresenceProbe) global.agentPresenceProbe = new Map();
  const memo = global.agentPresenceProbe.get(shopId);
  if (memo && now.getTime() - memo.at < PRESENCE_PROBE_TTL_MS) return memo.online;

  const hit = await db.analyticsEvent
    .findFirst({
      where: { shopId, type: "human_replied", occurredAt: { gt: new Date(cutoff) } },
      select: { id: true },
    })
    .catch(() => null);
  const online = hit !== null;
  global.agentPresenceProbe.set(shopId, { at: now.getTime(), online });
  return online;
}

/** Only two of the three display modes care who is at the desk. */
export function needsAgentPresence(availability: AvailabilityData): boolean {
  return availability.onlineStatusMode !== "working_hours";
}

/**
 * resolveAvailability with the shop's live agent presence filled in. Every
 * runtime caller must use this — calling resolveAvailability directly pins
 * agentOnline to false, which makes `agent_during_hours` permanently offline
 * and silently degrades `working_hours_or_agent` to `working_hours`.
 */
export async function resolveAvailabilityFor(
  shopId: string,
  availability: AvailabilityData,
  timezone: string,
  now = new Date(),
): Promise<ResolvedAvailability> {
  const agentOnline = needsAgentPresence(availability) ? await isAgentOnline(shopId, now) : false;
  return resolveAvailability(availability, timezone, agentOnline, now);
}

// ── Status freshness (spec 05 widget cache) ─────────────────────────────────

/** Longest the widget may cache the status line before it must refetch. */
export const AVAILABILITY_MAX_TTL_SECONDS = 300;

/**
 * Seconds until the resolved status could next change, capped at
 * AVAILABILITY_MAX_TTL_SECONDS. Schedule boundaries land on whole minutes, so
 * probing minute by minute over the cap is exact and costs at most five
 * resolves — far cheaper (and far smaller on the wire) than shipping the whole
 * schedule to the widget and re-implementing this engine there.
 *
 * Agent presence is NOT predictable, so it is held at its current value; a
 * presence flip still surfaces within one cache period.
 */
export function availabilityTtlSeconds(
  availability: AvailabilityData,
  timezone: string,
  agentOnline: boolean,
  now = new Date(),
): number {
  const line = (at: Date) => {
    const r = resolveAvailability(availability, timezone, agentOnline, at);
    return `${r.status} ${r.message}`; // the message moves too ("Back tomorrow 9 AM" → "Back 9 AM")
  };
  const current = line(now);
  // Start at the next whole minute — everything inside this one resolves the same.
  const startMs = 60_000 - (now.getTime() % 60_000);
  for (let offsetMs = startMs; offsetMs <= AVAILABILITY_MAX_TTL_SECONDS * 1000; offsetMs += 60_000) {
    if (line(new Date(now.getTime() + offsetMs)) !== current) {
      return Math.max(1, Math.round(offsetMs / 1000));
    }
  }
  return AVAILABILITY_MAX_TTL_SECONDS;
}
