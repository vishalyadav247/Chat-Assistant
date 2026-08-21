/* Chat availability QA (spec 16 sub-view "Chat availability" + spec 05 status line).
 *
 * Run: npx tsx scripts/qa/availability.test.ts
 * Needs: dev Postgres up (npm run db:up) + migrated + seeded.
 * Every row it writes is tagged with a `qa-avail-` shopId and removed again;
 * seeded data is never touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";
const NY = "America/New_York";
const QA_PREFIX = "qa-avail-";

let passed = 0;
let failed = 0;
const createdShopIds: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** A fresh fake shop id — isAgentOnline memoizes per shop, so every presence
 *  case needs its own or the 30 s memo leaks between assertions. */
function qaShopId(): string {
  const id = `${QA_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
  createdShopIds.push(id);
  return id;
}

async function main(): Promise<void> {
  const A = await import("../../app/lib/settings/availability.server");
  const { availabilitySchema } = await import("../../app/lib/settings/schemas");
  const db = (await import("../../app/db.server")).default;

  type Availability = ReturnType<typeof availabilitySchema.parse>;
  const build = (patch: Record<string, unknown>): Availability => availabilitySchema.parse(patch);
  const everyDay = (from: string, to: string) =>
    [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, enabled: true, from, to }));

  // 2026-08-21 is a Friday. All wall-clock offsets below are New York local.
  const at = (iso: string) => new Date(iso);
  const alwaysOn = build({ mode: "always" });
  const weekdays = build({ mode: "custom" }); // schema default: Mon–Fri 09:00–17:00
  const overnight = build({ mode: "custom", days: everyDay("22:00", "06:00") });
  const allWeek = build({ mode: "custom", days: everyDay("09:00", "17:00") });

  // ── 1. 24/7 mode ──────────────────────────────────────────────────────────
  console.log("\n[24/7 mode]");
  eq("always → online at 3am", A.resolveAvailability(alwaysOn, NY, false, at("2026-08-21T03:00:00-04:00")).status, "online");
  eq("always → withinWorkingHours", A.resolveAvailability(alwaysOn, NY, false, new Date()).withinWorkingHours, true);
  eq("always → nextOpening null ({{schedule}} has nothing to say)", A.nextOpening(alwaysOn, NY), null);

  // ── 2. inTimeRange ────────────────────────────────────────────────────────
  console.log("\n[inTimeRange]");
  eq("09:00–17:00 at 09:00 (start inclusive)", A.inTimeRange("09:00", "17:00", 9 * 60), true);
  eq("09:00–17:00 at 17:00 (end exclusive)", A.inTimeRange("09:00", "17:00", 17 * 60), false);
  eq("09:00–17:00 at 16:59", A.inTimeRange("09:00", "17:00", 16 * 60 + 59), true);
  eq("22:00–06:00 at 23:00 (wraps midnight)", A.inTimeRange("22:00", "06:00", 23 * 60), true);
  eq("22:00–06:00 at 03:00 (wraps midnight)", A.inTimeRange("22:00", "06:00", 3 * 60), true);
  eq("22:00–06:00 at 12:00", A.inTimeRange("22:00", "06:00", 12 * 60), false);
  // Deliberate: an equal from/to is an empty window, NOT 24h. The save path
  // (settings/save.server.ts superRefine) rejects it with "can't be the same",
  // so the only way to store one is a direct DB write.
  eq("09:00–09:00 reads as closed, not 24h", A.inTimeRange("09:00", "09:00", 10 * 60), false);

  // ── 3. Working hours + overnight wrap ─────────────────────────────────────
  console.log("\n[working hours]");
  eq("Fri 08:59 closed", A.resolveAvailability(weekdays, NY, false, at("2026-08-21T08:59:00-04:00")).status, "offline");
  eq("Fri 09:00 open", A.resolveAvailability(weekdays, NY, false, at("2026-08-21T09:00:00-04:00")).status, "online");
  eq("Fri 16:59 open", A.resolveAvailability(weekdays, NY, false, at("2026-08-21T16:59:00-04:00")).status, "online");
  eq("Fri 17:00 closed", A.resolveAvailability(weekdays, NY, false, at("2026-08-21T17:00:00-04:00")).status, "offline");
  eq("Sat closed (day disabled)", A.resolveAvailability(weekdays, NY, false, at("2026-08-22T12:00:00-04:00")).status, "offline");

  console.log("\n[overnight ranges 22:00–06:00]");
  eq("Fri 23:00 open", A.resolveAvailability(overnight, NY, false, at("2026-08-21T23:00:00-04:00")).status, "online");
  eq("Sat 02:00 open (previous weekday wrap)", A.resolveAvailability(overnight, NY, false, at("2026-08-22T02:00:00-04:00")).status, "online");
  eq("Sat 05:59 open", A.resolveAvailability(overnight, NY, false, at("2026-08-22T05:59:00-04:00")).status, "online");
  eq("Sat 06:00 closed", A.resolveAvailability(overnight, NY, false, at("2026-08-22T06:00:00-04:00")).status, "offline");
  eq("Sat 12:00 closed", A.resolveAvailability(overnight, NY, false, at("2026-08-22T12:00:00-04:00")).status, "offline");

  // Only Monday enabled overnight → Tuesday's early morning is covered, Wednesday's is not.
  const monOnlyNight = build({
    mode: "custom",
    days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, enabled: day === 1, from: "22:00", to: "06:00" })),
  });
  eq("Mon-only overnight → Tue 03:00 open", A.resolveAvailability(monOnlyNight, NY, false, at("2026-08-25T03:00:00-04:00")).status, "online");
  eq("Mon-only overnight → Wed 03:00 closed", A.resolveAvailability(monOnlyNight, NY, false, at("2026-08-26T03:00:00-04:00")).status, "offline");
  eq("Mon-only overnight → Mon 12:00 closed", A.resolveAvailability(monOnlyNight, NY, false, at("2026-08-24T12:00:00-04:00")).status, "offline");

  // ── 4. DST (America/New_York: EDT→EST 2026-11-01, EST→EDT 2026-03-08) ─────
  console.log("\n[DST boundaries, America/New_York]");
  // 2026-11-01 is a Sunday; clocks fall back at 02:00 local. 14:00Z = 09:00 EST.
  eq("fall-back day 08:59 EST closed", A.resolveAvailability(allWeek, NY, false, at("2026-11-01T13:59:00Z")).status, "offline");
  eq("fall-back day 09:00 EST open", A.resolveAvailability(allWeek, NY, false, at("2026-11-01T14:00:00Z")).status, "online");
  eq("day before (EDT) 09:00 open", A.resolveAvailability(allWeek, NY, false, at("2026-10-31T13:00:00Z")).status, "online");
  eq("day before (EDT) 08:59 closed", A.resolveAvailability(allWeek, NY, false, at("2026-10-31T12:59:00Z")).status, "offline");
  // 2026-03-08 spring forward at 02:00 local. 13:00Z = 09:00 EDT.
  eq("spring-forward day 09:00 EDT open", A.resolveAvailability(allWeek, NY, false, at("2026-03-08T13:00:00Z")).status, "online");
  eq("spring-forward day 08:59 EDT closed", A.resolveAvailability(allWeek, NY, false, at("2026-03-08T12:59:00Z")).status, "offline");
  eq("day before (EST) 09:00 open", A.resolveAvailability(allWeek, NY, false, at("2026-03-07T14:00:00Z")).status, "online");
  // Same instant, two zones → different answers.
  eq("Asia/Kolkata sees the same instant differently", A.resolveAvailability(allWeek, "Asia/Kolkata", false, at("2026-03-08T13:00:00Z")).status, "offline");

  // ── 5. Breaks ─────────────────────────────────────────────────────────────
  console.log("\n[breaks]");
  const withBreak = build({
    mode: "custom",
    days: everyDay("09:00", "17:00"),
    breaks: { enabled: true, ranges: [{ from: "13:00", to: "14:00" }] },
    messages: { break: "On break · Back at {{schedule}}" },
  });
  eq("13:30 → break", A.resolveAvailability(withBreak, NY, false, at("2026-08-21T13:30:00-04:00")).status, "break");
  eq("break message resolves {{schedule}} to the break end", A.resolveAvailability(withBreak, NY, false, at("2026-08-21T13:30:00-04:00")).message, "On break · Back at 2 PM");
  eq("14:00 → back online (break end exclusive)", A.resolveAvailability(withBreak, NY, false, at("2026-08-21T14:00:00-04:00")).status, "online");
  eq("break inside hours keeps withinWorkingHours true", A.resolveAvailability(withBreak, NY, false, at("2026-08-21T13:30:00-04:00")).withinWorkingHours, true);
  // Breaks only apply INSIDE working hours: a 20:00 break on a 9–5 day is inert.
  const lateBreak = build({
    mode: "custom",
    days: everyDay("09:00", "17:00"),
    breaks: { enabled: true, ranges: [{ from: "19:00", to: "21:00" }] },
  });
  eq("break outside working hours → offline, not break", A.resolveAvailability(lateBreak, NY, false, at("2026-08-21T20:00:00-04:00")).status, "offline");
  // 24/7 shops are always "within hours", so their breaks do apply round the clock.
  const alwaysBreak = build({ mode: "always", breaks: { enabled: true, ranges: [{ from: "02:00", to: "03:00" }] } });
  eq("24/7 + break at 02:30 → break", A.resolveAvailability(alwaysBreak, NY, false, at("2026-08-21T02:30:00-04:00")).status, "break");
  const breakOff = build({ mode: "always", breaks: { enabled: false, ranges: [{ from: "02:00", to: "03:00" }] } });
  eq("breaks toggle off → ranges ignored", A.resolveAvailability(breakOff, NY, false, at("2026-08-21T02:30:00-04:00")).status, "online");

  // ── 6. Holidays ───────────────────────────────────────────────────────────
  console.log("\n[holidays]");
  const holiday = build({
    mode: "custom",
    days: everyDay("09:00", "17:00"),
    holidays: { enabled: true, items: [{ name: "Long weekend", from: "2026-08-21", to: "2026-08-23" }] },
    messages: { holiday: "Off today · Back at {{schedule}}" },
  });
  eq("inside range → holiday (beats working hours)", A.resolveAvailability(holiday, NY, false, at("2026-08-21T12:00:00-04:00")).status, "holiday");
  eq("last day of range → holiday", A.resolveAvailability(holiday, NY, false, at("2026-08-23T12:00:00-04:00")).status, "holiday");
  eq("day after range → online", A.resolveAvailability(holiday, NY, false, at("2026-08-24T12:00:00-04:00")).status, "online");
  eq("day before range → online", A.resolveAvailability(holiday, NY, false, at("2026-08-20T12:00:00-04:00")).status, "online");
  eq("holiday keeps withinWorkingHours false", A.resolveAvailability(holiday, NY, false, at("2026-08-21T12:00:00-04:00")).withinWorkingHours, false);
  // {{schedule}} must skip the rest of the holiday, not name today's opening.
  eq("holiday {{schedule}} skips the closed days", A.resolveAvailability(holiday, NY, false, at("2026-08-21T07:00:00-04:00")).message, "Off today · Back at Monday 9 AM");
  const holidayOff = build({
    mode: "custom",
    days: everyDay("09:00", "17:00"),
    holidays: { enabled: false, items: [{ name: "x", from: "2026-08-21", to: "2026-08-23" }] },
  });
  eq("holidays toggle off → items ignored", A.resolveAvailability(holidayOff, NY, false, at("2026-08-21T12:00:00-04:00")).status, "online");
  // 24/7 shop on holiday: there is no schedule to come back to.
  const alwaysHoliday = build({
    mode: "always",
    holidays: { enabled: true, items: [{ name: "x", from: "2026-08-21", to: "2026-08-21" }] },
    messages: { holiday: "Off today · Back at {{schedule}}" },
  });
  eq("24/7 + holiday → 'soon'", A.resolveAvailability(alwaysHoliday, NY, false, at("2026-08-21T12:00:00-04:00")).message, "Off today · Back at soon");
  // Malformed dates are ignored rather than string-compared (the save path
  // rejects them, but seeds / imports / direct writes do not go through it).
  const badHoliday = build({
    mode: "custom",
    days: everyDay("09:00", "17:00"),
    holidays: { enabled: true, items: [{ name: "Bad", from: "21/08/2026", to: "22/08/2026" }] },
  });
  eq("malformed holiday dates never match", A.resolveAvailability(badHoliday, NY, false, at("2026-08-21T12:00:00-04:00")).status, "online");
  eq("isHolidayOn ignores malformed rows", A.isHolidayOn(badHoliday, "2026-08-21"), false);

  // ── 7. nextOpening / {{schedule}} shapes ──────────────────────────────────
  console.log("\n[nextOpening / {{schedule}}]");
  eq("before today's opening → '9 AM'", A.nextOpening(weekdays, NY, at("2026-08-21T07:00:00-04:00")), "9 AM");
  eq("Thu evening → 'tomorrow 9 AM'", A.nextOpening(weekdays, NY, at("2026-08-20T18:00:00-04:00")), "tomorrow 9 AM");
  eq("Fri evening (weekend closed) → 'Monday 9 AM'", A.nextOpening(weekdays, NY, at("2026-08-21T18:00:00-04:00")), "Monday 9 AM");
  eq("Sunday → 'tomorrow 9 AM'", A.nextOpening(weekdays, NY, at("2026-08-23T12:00:00-04:00")), "tomorrow 9 AM");
  eq("24/7 → null", A.nextOpening(alwaysOn, NY, at("2026-08-21T12:00:00-04:00")), null);
  eq("holiday spanning tomorrow pushes the schedule out", A.nextOpening(holiday, NY, at("2026-08-21T07:00:00-04:00")), "Monday 9 AM");
  eq("offline message merges {{schedule}}", A.resolveAvailability(weekdays, NY, false, at("2026-08-21T18:00:00-04:00")).message, "We're away · Back Monday 9 AM");
  // Half-hour openings format with minutes.
  const halfPast = build({ mode: "custom", days: everyDay("09:30", "17:00") });
  eq("09:30 formats as '9:30 AM'", A.nextOpening(halfPast, NY, at("2026-08-21T07:00:00-04:00")), "9:30 AM");
  const noon = build({ mode: "custom", days: everyDay("12:00", "17:00") });
  eq("12:00 formats as '12 PM'", A.nextOpening(noon, NY, at("2026-08-21T07:00:00-04:00")), "12 PM");
  const midnight = build({ mode: "custom", days: everyDay("00:00", "06:00") });
  eq("00:00 formats as '12 AM'", A.nextOpening(midnight, NY, at("2026-08-21T07:00:00-04:00")), "tomorrow 12 AM");

  // ── 8. onlineStatusMode × agentOnline ─────────────────────────────────────
  console.log("\n[onlineStatusMode × agent presence]");
  const inHours = at("2026-08-21T12:00:00-04:00");
  const outHours = at("2026-08-21T22:00:00-04:00");
  const matrix: Array<[string, boolean, Date, string]> = [
    ["working_hours", false, inHours, "online"],
    ["working_hours", true, inHours, "online"],
    ["working_hours", false, outHours, "offline"],
    ["working_hours", true, outHours, "offline"],
    ["working_hours_or_agent", false, inHours, "online"],
    ["working_hours_or_agent", true, inHours, "online"],
    ["working_hours_or_agent", false, outHours, "offline"],
    ["working_hours_or_agent", true, outHours, "online"],
    ["agent_during_hours", false, inHours, "offline"],
    ["agent_during_hours", true, inHours, "online"],
    ["agent_during_hours", false, outHours, "offline"],
    ["agent_during_hours", true, outHours, "offline"],
  ];
  for (const [mode, agent, when, want] of matrix) {
    const cfg = build({ mode: "custom", onlineStatusMode: mode });
    const label = when === inHours ? "in hours" : "out of hours";
    eq(`${mode} / ${label} / agent=${agent}`, A.resolveAvailability(cfg, NY, agent, when).status, want);
  }
  eq("only working_hours can skip the presence lookup", A.needsAgentPresence(build({ onlineStatusMode: "working_hours" })), false);
  eq("working_hours_or_agent needs presence", A.needsAgentPresence(build({ onlineStatusMode: "working_hours_or_agent" })), true);
  eq("agent_during_hours needs presence", A.needsAgentPresence(build({ onlineStatusMode: "agent_during_hours" })), true);

  // ── 9. Agent presence resolution ──────────────────────────────────────────
  console.log("\n[agent presence]");
  const quietShop = qaShopId();
  eq("no heartbeat, no replies → offline", await A.isAgentOnline(quietShop), false);

  const beatShop = qaShopId();
  A.touchAgentPresence(beatShop);
  eq("heartbeat (inbox open) → online", await A.isAgentOnline(beatShop), true);

  const staleBeatShop = qaShopId();
  A.touchAgentPresence(staleBeatShop);
  eq(
    "heartbeat older than the window → offline",
    await A.isAgentOnline(staleBeatShop, new Date(Date.now() + A.AGENT_PRESENCE_WINDOW_MS + 60_000)),
    false,
  );

  const repliedShop = qaShopId();
  await db.analyticsEvent.create({ data: { shopId: repliedShop, type: "human_replied", occurredAt: new Date() } });
  eq("recent human_replied event → online (survives a restart / other instance)", await A.isAgentOnline(repliedShop), true);

  const oldReplyShop = qaShopId();
  await db.analyticsEvent.create({
    data: { shopId: oldReplyShop, type: "human_replied", occurredAt: new Date(Date.now() - 10 * 60_000) },
  });
  eq("human_replied older than the window → offline", await A.isAgentOnline(oldReplyShop), false);

  const otherShop = qaShopId();
  await db.analyticsEvent.create({ data: { shopId: otherShop, type: "handover_triggered", occurredAt: new Date() } });
  eq("another shop's activity never leaks in", await A.isAgentOnline(qaShopId()), false);
  eq("a non-reply event is not presence", await A.isAgentOnline(otherShop), false);

  // resolveAvailabilityFor is the wiring the runtime must use. The heartbeat is
  // stamped off the real clock, so these cases use schedules that are open (or
  // shut) at any wall-clock time rather than a pinned `now`.
  console.log("\n[resolveAvailabilityFor]");
  const alwaysInHours = (mode: string) => build({ mode: "always", onlineStatusMode: mode });
  const neverInHours = (mode: string) =>
    build({
      mode: "custom",
      days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, enabled: false, from: "09:00", to: "17:00" })),
      onlineStatusMode: mode,
    });

  eq(
    "agent_during_hours, nobody at the desk → offline",
    (await A.resolveAvailabilityFor(qaShopId(), alwaysInHours("agent_during_hours"), NY)).status,
    "offline",
  );
  const agentShop = qaShopId();
  A.touchAgentPresence(agentShop);
  eq(
    "agent_during_hours, agent present → online",
    (await A.resolveAvailabilityFor(agentShop, alwaysInHours("agent_during_hours"), NY)).status,
    "online",
  );
  const nightAgentShop = qaShopId();
  A.touchAgentPresence(nightAgentShop);
  eq(
    "working_hours_or_agent, agent present outside hours → online",
    (await A.resolveAvailabilityFor(nightAgentShop, neverInHours("working_hours_or_agent"), NY)).status,
    "online",
  );
  eq(
    "working_hours_or_agent, nobody present outside hours → offline",
    (await A.resolveAvailabilityFor(qaShopId(), neverInHours("working_hours_or_agent"), NY)).status,
    "offline",
  );
  eq(
    "working_hours ignores presence entirely",
    (await A.resolveAvailabilityFor(agentShop, neverInHours("working_hours"), NY)).status,
    "offline",
  );

  // ── 10. Status freshness (widget cache ttl) ───────────────────────────────
  console.log("\n[availability ttl]");
  eq("far from a boundary → capped at 5 min", A.availabilityTtlSeconds(weekdays, NY, false, at("2026-08-21T12:00:00-04:00")), A.AVAILABILITY_MAX_TTL_SECONDS);
  eq("two minutes before closing → 120s", A.availabilityTtlSeconds(weekdays, NY, false, at("2026-08-21T16:58:00-04:00")), 120);
  eq("one minute before opening → 60s", A.availabilityTtlSeconds(weekdays, NY, false, at("2026-08-21T08:59:00-04:00")), 60);
  eq("30s before closing rounds to the boundary", A.availabilityTtlSeconds(weekdays, NY, false, at("2026-08-21T16:59:30-04:00")), 30);
  eq("just after a boundary → capped again", A.availabilityTtlSeconds(weekdays, NY, false, at("2026-08-21T17:00:30-04:00")), A.AVAILABILITY_MAX_TTL_SECONDS);
  eq("break start is a boundary too", A.availabilityTtlSeconds(withBreak, NY, false, at("2026-08-21T12:58:00-04:00")), 120);
  eq("24/7 never expires early", A.availabilityTtlSeconds(alwaysOn, NY, false, new Date()), A.AVAILABILITY_MAX_TTL_SECONDS);
  // The status can hold while the MESSAGE moves ("Back tomorrow 9 AM" → "Back 9 AM").
  const beforeMidnight = at("2026-08-23T23:58:00-04:00"); // Sunday
  ok(
    "message-only change still expires the cache",
    A.resolveAvailability(weekdays, NY, false, beforeMidnight).message !==
      A.resolveAvailability(weekdays, NY, false, new Date(beforeMidnight.getTime() + 120_000)).message &&
      A.availabilityTtlSeconds(weekdays, NY, false, beforeMidnight) === 120,
    `ttl=${A.availabilityTtlSeconds(weekdays, NY, false, beforeMidnight)}`,
  );

  // ── 11. Widget payload wiring ─────────────────────────────────────────────
  console.log("\n[widget config payload]");
  const shop = await db.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN }, select: { id: true } });
  if (!shop) {
    ok("dev shop present", false, `seed ${DEV_SHOP_DOMAIN} first`);
  } else {
    const { buildWidgetConfig } = await import("../../app/lib/widget/config.server");
    const payload = await buildWidgetConfig(shop.id, DEV_SHOP_DOMAIN);
    if (payload.active === false) {
      ok("widget config carries availability", false, "widget is switched off for the dev shop");
    } else {
      ok("payload carries a status", typeof payload.availability.status === "string", payload.availability.status);
      ok("payload carries a message", typeof payload.availability.message === "string", payload.availability.message);
      ok(
        "payload carries a bounded ttl the widget can cache against",
        Number.isInteger(payload.availability.ttl) &&
          payload.availability.ttl >= 1 &&
          payload.availability.ttl <= A.AVAILABILITY_MAX_TTL_SECONDS,
        `ttl=${payload.availability.ttl}s`,
      );
    }
  }

  console.log(`\n${failed === 0 ? "AVAILABILITY TESTS PASS" : "AVAILABILITY TESTS FAIL"} — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("\nAVAILABILITY TESTS ERROR", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const db = (await import("../../app/db.server")).default;
    try {
      if (createdShopIds.length > 0) {
        await db.analyticsEvent.deleteMany({ where: { shopId: { in: createdShopIds } } });
      }
    } catch (error) {
      console.error("cleanup failed", error);
      process.exitCode = 1;
    }
    // MUST await — the shared client keeps the pool (and the process) alive.
    await db.$disconnect();
  });
