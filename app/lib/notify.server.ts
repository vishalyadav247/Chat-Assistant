import { requireShopId } from "./tenancy.server";

// Team notification dispatcher (spec 10 seam, implemented in spec 18).
// Producers call these fire-and-forget helpers; delivery (browser push +
// handover email to the right team members) runs in a pg-boss job so the
// shopper-facing request never waits on push/email providers.

export type NotifyKind = "handover" | "humanReply" | "newConversation";

export const NOTIFY_JOB = "team-notify";

export interface NotifyJobData {
  shopId: string;
  conversationId: string;
  kind: NotifyKind;
}

async function dispatch(data: NotifyJobData): Promise<void> {
  requireShopId(data.shopId);
  try {
    // Lazy import keeps the jobs module graph (which imports inbox/pipeline
    // code that in turn imports this file) from forming an eager cycle.
    const { enqueue } = await import("./jobs/queue.server");
    await enqueue(NOTIFY_JOB, data);
  } catch (error) {
    console.error("notify_enqueue_failed", data.kind, error);
  }
}

/** A conversation was handed over to a human (inbox destination / form). */
export async function notifyMerchantHandover(shopId: string, conversationId: string): Promise<void> {
  await dispatch({ shopId, conversationId, kind: "handover" });
}

/** A shopper wrote in a conversation that's waiting for a human. */
export async function notifyShopperMessage(shopId: string, conversationId: string): Promise<void> {
  await dispatch({ shopId, conversationId, kind: "humanReply" });
}

/** A brand-new conversation started (opt-in, noisy). Skips the enqueue
 *  entirely unless some member of the shop opted in (cached 60s). */
const newConvoWanted = new Map<string, { value: boolean; until: number }>();
export async function notifyNewConversation(shopId: string, conversationId: string): Promise<void> {
  const now = Date.now();
  const cached = newConvoWanted.get(shopId);
  let wanted = cached && cached.until > now ? cached.value : null;
  if (wanted === null) {
    const { default: db } = await import("../db.server");
    const members = await db.teamMember.findMany({ where: { shopId, status: "active" }, select: { notifyPrefs: true } });
    wanted = members.some((m) => {
      const prefs = m.notifyPrefs as { push?: { newConversation?: boolean } } | null;
      return Boolean(prefs?.push?.newConversation);
    });
    newConvoWanted.set(shopId, { value: wanted, until: now + 60_000 });
  }
  if (!wanted) return;
  await dispatch({ shopId, conversationId, kind: "newConversation" });
}
