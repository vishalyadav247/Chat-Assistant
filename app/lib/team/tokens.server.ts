import { createHash, randomBytes } from "node:crypto";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";

// Opaque tokens for web sessions and one-time links (spec 18). The raw token
// only ever travels in the cookie / URL; the DB stores sha256(token) so a DB
// read-leak can't be replayed.

export type TokenKind = "session" | "handoff" | "invite" | "reset";

export function newRawToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function mintToken(args: {
  shopId: string;
  memberId: string;
  kind: TokenKind;
  ttlMs: number;
  userAgent?: string | null;
}): Promise<string> {
  requireShopId(args.shopId);
  const raw = newRawToken();
  await db.teamSession.create({
    data: {
      tokenHash: hashToken(raw),
      shopId: args.shopId,
      memberId: args.memberId,
      kind: args.kind,
      expiresAt: new Date(Date.now() + args.ttlMs),
      userAgent: args.userAgent?.slice(0, 300) ?? null,
    },
  });
  return raw;
}

/** Look up a live token row (any kind). Returns null when missing/expired. */
export async function findToken(raw: string, kind: TokenKind) {
  if (!raw || raw.length > 200) return null;
  const row = await db.teamSession.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!row || row.kind !== kind) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.teamSession.delete({ where: { id: row.id } }).catch(() => undefined);
    return null;
  }
  return row;
}

/** One-time tokens: read + delete atomically enough for our purposes. */
export async function consumeToken(raw: string, kind: Exclude<TokenKind, "session">) {
  const row = await findToken(raw, kind);
  if (!row) return null;
  const deleted = await db.teamSession.deleteMany({ where: { id: row.id } });
  // Lost the race with a parallel consume → treat as used.
  if (deleted.count === 0) return null;
  return row;
}

/** Drop every outstanding one-time token of a kind for a member (re-issue flows). */
export async function revokeTokens(shopId: string, memberId: string, kind: TokenKind): Promise<void> {
  requireShopId(shopId);
  await db.teamSession.deleteMany({ where: { shopId, memberId, kind } });
}

export async function purgeExpiredTokens(): Promise<number> {
  const result = await db.teamSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
