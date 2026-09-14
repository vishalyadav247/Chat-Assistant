import { z } from "zod";
import db from "../../db.server";
import { logError } from "../log.server";
import { DEFAULT_TRACE_HOURS, MAX_TRACE_SHOPS, TRACE_DURATION_HOURS } from "./turn-tracing-shared";

// Admin → Debug recording state (QA-C3, 2026-09-14).
//
// Recording stores REAL shopper message text, so it is:
//   - per STORE: an explicit allowlist of shop ids, never "every store";
//   - time-limited: `until` — recording stops by itself, no one has to remember;
//   - hard-locked in production unless ALLOW_TURN_TRACING=true (set only once the
//     privacy policy + Protected Customer Data answers describe this access);
//   - read FRESH (≤5 s cache) and fail-CLOSED, so "Stop now" takes effect within
//     seconds and a database hiccup means "not recording" (QA-U6).
//
// Stored in its own app_secrets row, not the 30 s runtime-config snapshot. A
// legacy `turnTracingEnabled: true` in runtime config is ignored → off.

const STORAGE_KEY = "admin:turn-tracing";
const CACHE_MS = 5_000;

const stateSchema = z.object({
  shopIds: z.array(z.string().min(1).max(40)).max(MAX_TRACE_SHOPS).catch([]),
  until: z.string().max(40).nullable().catch(null),
  startedBy: z.string().max(200).nullable().catch(null),
});

export type TurnTracingState = z.infer<typeof stateSchema>;

const OFF: TurnTracingState = { shopIds: [], until: null, startedBy: null };

let cached: { state: TurnTracingState; at: number } | null = null;

/** Production refuses to record unless explicitly allowed by the environment. */
export function turnTracingAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_TURN_TRACING === "true";
}

async function readState(): Promise<TurnTracingState> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
  try {
    const row = await db.appSecret.findUnique({ where: { key: STORAGE_KEY } });
    const state = row ? stateSchema.parse(JSON.parse(row.value)) : OFF;
    cached = { state, at: Date.now() };
    return state;
  } catch (error) {
    // Fail closed: an unreadable state is "not recording", and is not cached,
    // so the next turn retries the read.
    logError("turn_tracing_state_load_error", error);
    return OFF;
  }
}

/** Is the window still open (now < until)? */
export function tracingActive(state: TurnTracingState, now = Date.now()): boolean {
  return state.shopIds.length > 0 && state.until !== null && Date.parse(state.until) > now;
}

/** The per-turn check used by the storefront chat route. */
export async function isTracingShop(shopId: string): Promise<boolean> {
  if (!turnTracingAllowed()) return false;
  const state = await readState();
  return tracingActive(state) && state.shopIds.includes(shopId);
}

/** Current state for the Debug page (fresh read). */
export async function turnTracingState(): Promise<TurnTracingState & { active: boolean; allowed: boolean }> {
  cached = null;
  const state = await readState();
  return { ...state, active: tracingActive(state), allowed: turnTracingAllowed() };
}

async function writeState(state: TurnTracingState): Promise<void> {
  const value = JSON.stringify(state);
  await db.appSecret.upsert({
    where: { key: STORAGE_KEY },
    create: { key: STORAGE_KEY, value },
    update: { value },
  });
  cached = { state, at: Date.now() };
}

export async function startTurnTracing(args: {
  shopIds: string[];
  hours: number;
  by: string;
}): Promise<TurnTracingState> {
  if (!turnTracingAllowed()) throw new Error("Recording is disabled on this server.");
  const hours = (TRACE_DURATION_HOURS as readonly number[]).includes(args.hours) ? args.hours : DEFAULT_TRACE_HOURS;
  const shopIds = [...new Set(args.shopIds.filter(Boolean))].slice(0, MAX_TRACE_SHOPS);
  if (shopIds.length === 0) throw new Error("Pick at least one store to record.");
  // Only real, installed shops can be recorded.
  const shops = await db.shop.findMany({
    where: { id: { in: shopIds }, uninstalledAt: null },
    select: { id: true },
  });
  if (shops.length === 0) throw new Error("None of the selected stores is installed.");
  const state: TurnTracingState = {
    shopIds: shops.map((s) => s.id),
    until: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
    startedBy: args.by,
  };
  await writeState(state);
  return state;
}

export async function stopTurnTracing(): Promise<void> {
  await writeState(OFF);
}

/** Test seam: drop the per-process cache. */
export function resetTurnTracingCache(): void {
  cached = null;
}
