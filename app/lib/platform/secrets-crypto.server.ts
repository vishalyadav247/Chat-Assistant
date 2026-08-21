import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { logError, logWarn } from "../log.server";

// At-rest encryption for operator-managed secrets (spec 19 settings): the
// OpenAI key, Resend key and SMTP password live in app_secrets, so they are
// sealed with AES-256-GCM rather than stored as readable text.
//
// The key is derived from SHOPIFY_API_SECRET (always present in a real
// deployment; the Shopify CLI injects it in dev). If that is somehow absent we
// fall back to DATABASE_URL so dev boxes still work — noted, never silent.

const PREFIX = "enc:v1:";
let cachedKey: Buffer | null = null;

function secretKey(): Buffer {
  if (!cachedKey) {
    const material = process.env.SHOPIFY_API_SECRET || process.env.DATABASE_URL || "";
    if (!material) {
      throw new Error("cannot derive secret key: SHOPIFY_API_SECRET and DATABASE_URL are both unset");
    }
    if (!process.env.SHOPIFY_API_SECRET) {
      logWarn("platform_secret_key_fallback", "SHOPIFY_API_SECRET absent — deriving settings key from DATABASE_URL");
    }
    cachedKey = scryptSync(material, "chatconvert:platform:secrets:v1", 32);
  }
  return cachedKey;
}

/** Seal a value for storage. Empty string stays empty (means "not set"). */
export function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Open a stored value. Anything without the marker is returned unchanged (so a
 * hand-edited plaintext row still works), and an undecryptable value returns ""
 * rather than throwing — a rotated app secret must not break every page.
 */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(":");
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    logError("platform_secret_decrypt_failed", error instanceof Error ? error.message : error);
    return "";
  }
}

/** true when a stored value is sealed (used by tests to prove at-rest safety). */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Display form for a secret: never the value itself. */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 3)}••••••••${value.slice(-4)}`;
}
