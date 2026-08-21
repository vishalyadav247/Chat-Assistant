import webpush from "web-push";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { getVapidKeys } from "./vapid.server";
import { logError } from "../log.server";

// Web Push delivery (spec 18). Payloads are end-to-end encrypted per the Web
// Push spec (p256dh/auth) — the push service never sees the content — but we
// still keep them lean: a title, a short snippet, a deep link.

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Collapses repeated notifications for the same conversation. */
  tag: string;
}

let configuredFor: string | null = null;
/** Resolve (env or auto-provisioned) VAPID keys and point web-push at them. */
export async function pushConfigured(): Promise<boolean> {
  try {
    const keys = await getVapidKeys();
    if (configuredFor !== keys.publicKey) {
      webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
      configuredFor = keys.publicKey;
    }
    return true;
  } catch (error) {
    logError("vapid_config_invalid", error);
    return false;
  }
}

/** Send one payload to every subscription of the given members. Prunes dead
 *  endpoints (404/410) and stamps lastUsedAt on success. */
export async function sendPushToMembers(shopId: string, memberIds: string[], payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  requireShopId(shopId);
  if (memberIds.length === 0 || !(await pushConfigured())) return { sent: 0, pruned: 0 };
  const subs = await db.pushSubscription.findMany({ where: { shopId, memberId: { in: memberIds } } });
  let sent = 0;
  let pruned = 0;
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, {
          TTL: 60 * 60,
          urgency: "high",
          topic: payload.tag.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, ""),
        });
        sent += 1;
        await db.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date(), failedAt: null } }).catch(() => undefined);
      } catch (error) {
        const status = (error as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          pruned += 1;
          await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
        } else {
          logError("push_send_failed", (error as Error)?.message, { status, shopId });
          await db.pushSubscription.update({ where: { id: sub.id }, data: { failedAt: new Date() } }).catch(() => undefined);
        }
      }
    }),
  );
  return { sent, pruned };
}
