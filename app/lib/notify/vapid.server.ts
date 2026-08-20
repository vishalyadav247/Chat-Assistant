import webpush from "web-push";
import db from "../../db.server";
import { env } from "../env.server";

// VAPID keys for Web Push (spec 18). Zero-config: if VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY aren't in the environment, a key pair is generated once
// and kept in app_secrets so push "just works" in dev and on a fresh deploy.
// Env vars always win (rotate by setting them). Subscriptions are bound to
// the public key, so keys must stay stable across restarts — hence the DB.

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let cached: Promise<VapidKeys> | null = null;

export function getVapidKeys(): Promise<VapidKeys> {
  if (!cached) {
    cached = resolveKeys().catch((error) => {
      cached = null; // retry next call
      throw error;
    });
  }
  return cached;
}

async function resolveKeys(): Promise<VapidKeys> {
  const e = env();
  // Subject = contact for the push services. Defaults to the EMAIL_FROM address
  // so production needs no extra variable.
  const fromAddress = e.EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? e.EMAIL_FROM.trim();
  const subject = e.VAPID_SUBJECT || (fromAddress.includes("@") ? `mailto:${fromAddress}` : "mailto:support@example.com");
  if (e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY) {
    return { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject };
  }
  const row = await db.appSecret.findUnique({ where: { key: "vapid" } });
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as { publicKey?: string; privateKey?: string };
      if (parsed.publicKey && parsed.privateKey) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subject };
      }
    } catch {
      /* fall through and regenerate */
    }
  }
  const generated = webpush.generateVAPIDKeys();
  const value = JSON.stringify({ publicKey: generated.publicKey, privateKey: generated.privateKey });
  // Upsert so two boots racing don't collide; the first writer wins and the
  // second reads it back.
  await db.appSecret.upsert({ where: { key: "vapid" }, create: { key: "vapid", value }, update: {} });
  const stored = await db.appSecret.findUnique({ where: { key: "vapid" } });
  const final = stored ? (JSON.parse(stored.value) as { publicKey: string; privateKey: string }) : generated;
  console.log("[push] VAPID keys auto-provisioned (set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY to manage them yourself)");
  return { publicKey: final.publicKey, privateKey: final.privateKey, subject };
}

/** Public key for the browser (empty string if keys can't be resolved). */
export async function getVapidPublicKey(): Promise<string> {
  try {
    return (await getVapidKeys()).publicKey;
  } catch (error) {
    console.error("vapid_keys_unavailable", error);
    return "";
  }
}
