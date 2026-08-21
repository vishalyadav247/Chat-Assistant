import { z } from "zod";
import db from "../../db.server";
import { getQuota } from "../billing/plans.server";
import { requireShopId } from "../tenancy.server";
import { runtimeConfig } from "../platform/runtime-config.server";
import { handoverEmail, inviteEmail, resetEmail, sendEmail } from "../email/email.server";
import { hashPassword, passwordProblem, verifyPassword } from "./password.server";
import { consumeToken, findToken, mintToken, revokeTokens } from "./tokens.server";
import { revokeMemberSessions } from "./web-session.server";
import { logError } from "../log.server";

// Team module (spec 18): roster + logins for the standalone web surface.
// Replaces the JSON roster that lived in ShopSettings.settings.team.members.
// Every function takes shopId first and scopes every query by it.

export type MemberRole = "owner" | "admin" | "agent";
export type MemberStatus = "invited" | "active" | "disabled";

/** The conversation.assigneeId key for a member: the owner keeps the literal
 *  "owner" (pre-existing data), everyone else is their row id. */
export const OWNER_ASSIGNEE_KEY = "owner";
export function assigneeKeyFor(member: { id: string; role: string }): string {
  return member.role === "owner" ? OWNER_ASSIGNEE_KEY : member.id;
}

export const notifyPrefsSchema = z.object({
  push: z
    .object({
      handover: z.boolean().catch(true),
      humanReply: z.boolean().catch(true),
      newConversation: z.boolean().catch(false),
    })
    .catch({ handover: true, humanReply: true, newConversation: false }),
  emailHandover: z.boolean().catch(false),
  sound: z.boolean().catch(true),
});
export type NotifyPrefs = z.infer<typeof notifyPrefsSchema>;
export function parseNotifyPrefs(raw: unknown, role?: string): NotifyPrefs {
  const parsed = notifyPrefsSchema.parse(raw && typeof raw === "object" ? raw : {});
  // Owners/admins default to handover emails on when nothing was ever saved.
  if ((raw === null || raw === undefined) && (role === "owner" || role === "admin")) {
    parsed.emailHandover = true;
  }
  return parsed;
}

export interface MemberRow {
  id: string;
  email: string;
  name: string;
  role: MemberRole;
  status: MemberStatus;
  hasPassword: boolean;
  invitedAt: string;
  joinedAt: string | null;
  lastLoginAt: string | null;
  since: string;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

export function webBaseUrl(): string {
  // Operator-managed at /platform/settings; WEB_APP_URL / SHOPIFY_APP_URL fall back.
  return runtimeConfig().webAppUrl.replace(/\/+$/, "");
}

function asRole(value: string): MemberRole {
  return value === "owner" || value === "admin" ? value : "agent";
}
function asStatus(value: string): MemberStatus {
  return value === "active" || value === "disabled" ? value : "invited";
}
const normEmail = (email: string) => email.trim().toLowerCase();

function toRow(m: {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  passwordHash: string | null;
  invitedAt: Date;
  joinedAt: Date | null;
  lastLoginAt: Date | null;
}): MemberRow {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    role: asRole(m.role),
    status: asStatus(m.status),
    hasPassword: Boolean(m.passwordHash),
    invitedAt: m.invitedAt.toISOString(),
    joinedAt: m.joinedAt?.toISOString() ?? null,
    lastLoginAt: m.lastLoginAt?.toISOString() ?? null,
    since: (m.joinedAt ?? m.invitedAt).toISOString().slice(0, 10),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listMembers(shopId: string): Promise<MemberRow[]> {
  requireShopId(shopId);
  const rows = await db.teamMember.findMany({
    where: { shopId },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  // owner first, then admins, then agents (alphabetical role happens to be
  // admin < agent < owner, so sort explicitly).
  const rank: Record<string, number> = { owner: 0, admin: 1, agent: 2 };
  return rows.map(toRow).sort((a, b) => rank[a.role] - rank[b.role] || a.since.localeCompare(b.since));
}

/** Owner row (may be null until the first admin handoff). */
export async function getOwnerMember(shopId: string) {
  requireShopId(shopId);
  return db.teamMember.findFirst({ where: { shopId, role: "owner" } });
}

/** People a conversation can be assigned to. Keeps the legacy shape
 *  [{ id: "owner", name }, ...members]. */
export async function assigneeOptions(shopId: string): Promise<Array<{ id: string; name: string }>> {
  requireShopId(shopId);
  const [shop, members] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId }, select: { name: true } }),
    db.teamMember.findMany({
      where: { shopId, status: { not: "disabled" } },
      select: { id: true, name: true, role: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const owner = members.find((m) => m.role === "owner");
  return [
    { id: OWNER_ASSIGNEE_KEY, name: owner ? `${owner.name} (Owner)` : `${shop?.name || "Store owner"} (Owner)` },
    ...members.filter((m) => m.role !== "owner").map((m) => ({ id: m.id, name: m.name })),
  ];
}

/** Validate an assignee key coming from the UI. */
export async function isValidAssignee(shopId: string, assigneeId: string): Promise<boolean> {
  if (assigneeId === OWNER_ASSIGNEE_KEY) return true;
  const row = await db.teamMember.findFirst({ where: { id: assigneeId, shopId, role: { not: "owner" } }, select: { id: true } });
  return Boolean(row);
}

/** Map assignee keys → display names (contacts/inbox). */
export async function assigneeNameMap(shopId: string): Promise<Map<string, string>> {
  const options = await assigneeOptions(shopId);
  return new Map(options.map((o) => [o.id, o.name]));
}

// ── Owner bootstrap ──────────────────────────────────────────────────────────

/** Create/refresh the owner row from the Shopify shop record. Called from
 *  the admin handoff (trusted: the caller passed authenticate.admin). */
const placeholderOwnerEmail = (shopDomain: string) => `owner@${shopDomain}`;

async function lookupOwnerIdentity(shopDomain: string): Promise<{ email: string; name: string }> {
  try {
    // Lazy import: keeps offline scripts (golden eval, smoke) from booting the
    // full Shopify app config just to reach the pipeline through contacts.
    const { unauthenticated } = await import("../../shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);
    const res = await admin.graphql(`#graphql
      query OwnerIdentity { shop { email name shopOwnerName } }`);
    const json = (await res.json()) as {
      data?: { shop?: { email?: string; name?: string; shopOwnerName?: string } };
      errors?: unknown;
    };
    if (json.errors) logError("owner_identity_lookup_errors", JSON.stringify(json.errors).slice(0, 500));
    return { email: json.data?.shop?.email ?? "", name: json.data?.shop?.shopOwnerName || json.data?.shop?.name || "" };
  } catch (error) {
    logError("owner_identity_lookup_failed", error, { shopDomain });
    return { email: "", name: "" };
  }
}

export async function ensureOwnerMember(shopId: string, shopDomain: string) {
  requireShopId(shopId);
  const existing = await db.teamMember.findFirst({ where: { shopId, role: "owner" } });
  if (existing) {
    const patch: { status?: string; joinedAt?: Date; email?: string; name?: string } = {};
    if (existing.status !== "active") {
      patch.status = "active";
      patch.joinedAt = existing.joinedAt ?? new Date();
    }
    // A previous bootstrap couldn't reach the Admin API and stored the
    // placeholder address — retry now so the owner gets a real email.
    if (existing.email === placeholderOwnerEmail(shopDomain)) {
      const found = await lookupOwnerIdentity(shopDomain);
      if (found.email) {
        const email = normEmail(found.email);
        const clash = await db.teamMember.findUnique({ where: { shopId_email: { shopId, email } } });
        if (!clash) {
          patch.email = email;
          if (found.name && existing.name === shopDomain.replace(".myshopify.com", "")) patch.name = found.name;
        }
      }
    }
    if (Object.keys(patch).length === 0) return existing;
    return db.teamMember.update({ where: { id: existing.id }, data: patch });
  }

  let { email, name } = await lookupOwnerIdentity(shopDomain);
  if (!email) {
    const session = await db.session.findFirst({ where: { shop: shopDomain }, orderBy: { accountOwner: "desc" } });
    email = session?.email ?? placeholderOwnerEmail(shopDomain);
    name = name || [session?.firstName, session?.lastName].filter(Boolean).join(" ");
  }
  if (!name) name = shopDomain.replace(".myshopify.com", "");
  email = normEmail(email);

  // The owner's email might already be on the roster as an invited member —
  // promote that row instead of violating the (shopId,email) uniqueness.
  const clash = await db.teamMember.findUnique({ where: { shopId_email: { shopId, email } } });
  if (clash) {
    // Promotion drops any password/sessions the invited row had — the owner
    // identity must start from the admin handoff, not from a pre-seeded login.
    await revokeMemberSessions(shopId, clash.id);
    await db.pushSubscription.deleteMany({ where: { shopId, memberId: clash.id } });
    return db.teamMember.update({
      where: { id: clash.id },
      data: { role: "owner", status: "active", joinedAt: new Date(), name: clash.name || name, passwordHash: null },
    });
  }
  return db.teamMember.create({
    data: { shopId, email, name, role: "owner", status: "active", joinedAt: new Date() },
  });
}

/** One-time handoff token: embedded admin → web tab. */
export async function mintHandoffToken(shopId: string, memberId: string, userAgent?: string | null): Promise<string> {
  return mintToken({ shopId, memberId, kind: "handoff", ttlMs: HANDOFF_TTL_MS, userAgent });
}

export async function consumeHandoffToken(raw: string) {
  const row = await consumeToken(raw, "handoff");
  if (!row) return null;
  const member = await db.teamMember.findFirst({ where: { id: row.memberId, shopId: row.shopId, status: "active" } });
  return member ? { member, shopId: row.shopId } : null;
}

// ── Roster mutations ─────────────────────────────────────────────────────────

export interface InviteResult {
  ok: boolean;
  error?: string;
  member?: MemberRow;
  inviteUrl?: string;
  emailDelivered?: boolean;
}

async function seatsUsed(shopId: string): Promise<number> {
  return db.teamMember.count({ where: { shopId, role: { not: "owner" } } });
}

export async function inviteMember(args: {
  shopId: string;
  name: string;
  email: string;
  role: "admin" | "agent";
  inviterName: string;
}): Promise<InviteResult> {
  requireShopId(args.shopId);
  const email = normEmail(args.email);
  const name = args.name.trim().slice(0, 100);
  if (!name) return { ok: false, error: "Name is required." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return { ok: false, error: "Enter a valid email." };

  const shop = await db.shop.findUnique({ where: { id: args.shopId }, select: { plan: true, name: true, domain: true } });
  if (!shop) return { ok: false, error: "Shop not found." };
  const existing = await db.teamMember.findUnique({ where: { shopId_email: { shopId: args.shopId, email } } });
  if (existing) return { ok: false, error: "A member with this email already exists." };
  const quota = getQuota(shop.plan, "team_seats");
  if ((await seatsUsed(args.shopId)) >= quota) {
    return { ok: false, error: `Your plan allows ${quota} team member${quota === 1 ? "" : "s"}. Upgrade to invite more.` };
  }

  const member = await db.teamMember.create({
    data: { shopId: args.shopId, email, name, role: args.role, status: "invited" },
  });
  const sent = await issueInvite({ shopId: args.shopId, member, shopName: shop.name || shop.domain, inviterName: args.inviterName });
  return { ok: true, member: toRow(member), inviteUrl: sent.inviteUrl, emailDelivered: sent.emailDelivered };
}

async function issueInvite(args: {
  shopId: string;
  member: { id: string; email: string };
  shopName: string;
  inviterName: string;
}): Promise<{ inviteUrl: string; emailDelivered: boolean }> {
  await revokeTokens(args.shopId, args.member.id, "invite");
  const raw = await mintToken({ shopId: args.shopId, memberId: args.member.id, kind: "invite", ttlMs: INVITE_TTL_MS });
  const inviteUrl = `${webBaseUrl()}/web/invite/${raw}`;
  const result = await sendEmail(
    inviteEmail({ to: args.member.email, inviterName: args.inviterName, shopName: args.shopName, url: inviteUrl }),
  );
  return { inviteUrl, emailDelivered: result.delivered };
}

/** Re-issue an invite link (and email) for an invited member. */
export async function resendInvite(args: { shopId: string; memberId: string; inviterName: string }): Promise<InviteResult> {
  requireShopId(args.shopId);
  const [member, shop] = await Promise.all([
    db.teamMember.findFirst({ where: { id: args.memberId, shopId: args.shopId } }),
    db.shop.findUnique({ where: { id: args.shopId }, select: { name: true, domain: true } }),
  ]);
  if (!member || !shop) return { ok: false, error: "Member not found." };
  if (member.role === "owner") return { ok: false, error: "The owner signs in from the Shopify admin." };
  if (member.status === "disabled") return { ok: false, error: "Enable the member first." };
  // An invite link sets a NEW password on acceptance — on an active account
  // that is a takeover. Reset links are the tool for members who have joined.
  if (member.status === "active") return { ok: false, error: "This member has already joined. Send a reset link instead." };
  const sent = await issueInvite({ shopId: args.shopId, member, shopName: shop.name || shop.domain, inviterName: args.inviterName });
  return { ok: true, member: toRow(member), inviteUrl: sent.inviteUrl, emailDelivered: sent.emailDelivered };
}

export async function setMemberRole(shopId: string, memberId: string, role: "admin" | "agent"): Promise<boolean> {
  requireShopId(shopId);
  const result = await db.teamMember.updateMany({ where: { id: memberId, shopId, role: { not: "owner" } }, data: { role } });
  return result.count > 0;
}

export async function setMemberStatus(shopId: string, memberId: string, status: "active" | "disabled"): Promise<boolean> {
  requireShopId(shopId);
  const member = await db.teamMember.findFirst({ where: { id: memberId, shopId, role: { not: "owner" } } });
  if (!member) return false;
  if (status === "active" && !member.passwordHash) {
    // Never accepted the invite — back to invited.
    await db.teamMember.update({ where: { id: member.id }, data: { status: "invited" } });
    return true;
  }
  await db.teamMember.update({ where: { id: member.id }, data: { status } });
  if (status === "disabled") {
    await revokeMemberSessions(shopId, memberId);
    await db.pushSubscription.deleteMany({ where: { shopId, memberId } });
  }
  return true;
}

/** Remove a member: sessions, tokens, push subscriptions, and their
 *  assignments go back to Unassigned. */
export async function removeMember(shopId: string, memberId: string): Promise<boolean> {
  requireShopId(shopId);
  const member = await db.teamMember.findFirst({ where: { id: memberId, shopId } });
  if (!member || member.role === "owner") return false;
  await db.$transaction([
    db.teamSession.deleteMany({ where: { shopId, memberId } }),
    db.pushSubscription.deleteMany({ where: { shopId, memberId } }),
    db.conversation.updateMany({ where: { shopId, assigneeId: memberId }, data: { assigneeId: null } }),
    db.teamMember.delete({ where: { id: member.id } }),
  ]);
  return true;
}

// ── Invite acceptance / password flows ──────────────────────────────────────

export async function peekInvite(raw: string) {
  const row = await findToken(raw, "invite");
  if (!row) return null;
  const [member, shop] = await Promise.all([
    db.teamMember.findFirst({ where: { id: row.memberId, shopId: row.shopId } }),
    db.shop.findUnique({ where: { id: row.shopId }, select: { name: true, domain: true } }),
  ]);
  if (!member || !shop || member.status !== "invited") return null;
  return { member, shopName: shop.name || shop.domain };
}

export async function acceptInvite(args: {
  raw: string;
  name: string;
  password: string;
}): Promise<{ ok: true; member: { id: string; shopId: string } } | { ok: false; error: string }> {
  const problem = passwordProblem(args.password);
  if (problem) return { ok: false, error: problem };
  // Only "invite" tokens are accepted here (a "reset" token goes through
  // resetPassword); an invite must never set a password on an account that
  // has already joined — that would be a takeover path.
  const row = await consumeToken(args.raw, "invite");
  if (!row) return { ok: false, error: "This invitation link is invalid or has expired. Ask for a new one." };
  const member = await db.teamMember.findFirst({ where: { id: row.memberId, shopId: row.shopId } });
  if (!member || member.status !== "invited") return { ok: false, error: "This invitation is no longer valid." };
  const name = args.name.trim().slice(0, 100) || member.name;
  await db.teamMember.update({
    where: { id: member.id },
    data: {
      name,
      passwordHash: await hashPassword(args.password),
      status: "active",
      joinedAt: member.joinedAt ?? new Date(),
      lastLoginAt: new Date(),
      failedLogins: 0,
      lockedUntil: null,
    },
  });
  return { ok: true, member: { id: member.id, shopId: member.shopId } };
}

/** Always resolves (no account enumeration). Emails every active member
 *  matching the address, one link per shop. */
export async function requestPasswordReset(emailInput: string): Promise<{ links: Array<{ shopName: string; url: string }>; delivered: boolean }> {
  const email = normEmail(emailInput);
  if (!email) return { links: [], delivered: false };
  const members = await db.teamMember.findMany({ where: { email, status: "active" } });
  const links: Array<{ shopName: string; url: string }> = [];
  let delivered = false;
  for (const member of members) {
    const shop = await db.shop.findUnique({ where: { id: member.shopId }, select: { name: true, domain: true } });
    await revokeTokens(member.shopId, member.id, "reset");
    const raw = await mintToken({ shopId: member.shopId, memberId: member.id, kind: "reset", ttlMs: RESET_TTL_MS });
    const url = `${webBaseUrl()}/web/reset/${raw}`;
    links.push({ shopName: shop?.name || shop?.domain || "your store", url });
    const result = await sendEmail(resetEmail({ to: member.email, url }));
    delivered = delivered || result.delivered;
  }
  return { links, delivered };
}

/** Admin-issued reset link (copy-link fallback when email isn't configured). */
export async function issueResetLink(shopId: string, memberId: string): Promise<{ ok: boolean; url?: string; emailDelivered?: boolean; error?: string }> {
  requireShopId(shopId);
  const member = await db.teamMember.findFirst({ where: { id: memberId, shopId, status: "active" } });
  if (!member) return { ok: false, error: "Member not found." };
  await revokeTokens(shopId, memberId, "reset");
  const raw = await mintToken({ shopId, memberId, kind: "reset", ttlMs: RESET_TTL_MS });
  const url = `${webBaseUrl()}/web/reset/${raw}`;
  const result = await sendEmail(resetEmail({ to: member.email, url }));
  return { ok: true, url, emailDelivered: result.delivered };
}

export async function resetPassword(raw: string, password: string): Promise<{ ok: true; member: { id: string; shopId: string } } | { ok: false; error: string }> {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  const row = await consumeToken(raw, "reset");
  if (!row) return { ok: false, error: "This reset link is invalid or has expired." };
  const member = await db.teamMember.findFirst({ where: { id: row.memberId, shopId: row.shopId } });
  if (!member || member.status === "disabled") return { ok: false, error: "This account is not active." };
  await db.teamMember.update({
    where: { id: member.id },
    data: { passwordHash: await hashPassword(password), status: "active", joinedAt: member.joinedAt ?? new Date(), failedLogins: 0, lockedUntil: null },
  });
  // New password → every other device signs out.
  await revokeMemberSessions(member.shopId, member.id);
  return { ok: true, member: { id: member.id, shopId: member.shopId } };
}

export async function setPassword(shopId: string, memberId: string, password: string, keepSessionId?: string): Promise<{ ok: boolean; error?: string }> {
  requireShopId(shopId);
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  const result = await db.teamMember.updateMany({
    where: { id: memberId, shopId },
    data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null },
  });
  if (result.count === 0) return { ok: false, error: "Member not found." };
  await revokeMemberSessions(shopId, memberId, keepSessionId);
  return { ok: true };
}

export async function updateMemberProfile(shopId: string, memberId: string, data: { name?: string; notifyPrefs?: NotifyPrefs }): Promise<boolean> {
  requireShopId(shopId);
  const patch: { name?: string; notifyPrefs?: NotifyPrefs } = {};
  if (data.name !== undefined) {
    const name = data.name.trim().slice(0, 100);
    if (!name) return false;
    patch.name = name;
  }
  if (data.notifyPrefs) patch.notifyPrefs = notifyPrefsSchema.parse(data.notifyPrefs);
  const result = await db.teamMember.updateMany({ where: { id: memberId, shopId }, data: patch });
  return result.count > 0;
}

// ── Login ────────────────────────────────────────────────────────────────────

export interface LoginCandidate {
  memberId: string;
  shopId: string;
  shopName: string;
  role: MemberRole;
}

export type LoginResult =
  | { ok: true; candidates: LoginCandidate[] }
  | { ok: false; error: string };

/** Verify email+password across every shop the address belongs to. Returns
 *  all matching (shop, member) pairs so the UI can offer a store picker. */
export async function verifyLogin(emailInput: string, password: string): Promise<LoginResult> {
  const email = normEmail(emailInput);
  const generic = "Incorrect email or password.";
  if (!email || !password) return { ok: false, error: generic };
  const members = await db.teamMember.findMany({ where: { email, status: "active" } });
  if (members.length === 0) {
    // Burn roughly the same time as a real verify to blunt timing probes.
    await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    return { ok: false, error: generic };
  }
  const now = Date.now();
  const locked = members.filter((m) => m.lockedUntil && m.lockedUntil.getTime() > now);
  if (locked.length === members.length) {
    // Lock is enforced server-side but reported with the generic message so a
    // locked account can't be told apart from an unknown email.
    await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    return { ok: false, error: generic };
  }
  const candidates: LoginCandidate[] = [];
  const failed: string[] = [];
  for (const member of members) {
    if (member.lockedUntil && member.lockedUntil.getTime() > now) continue;
    if (!member.passwordHash) continue; // owner without password → admin handoff only
    if (await verifyPassword(password, member.passwordHash)) {
      const shop = await db.shop.findUnique({ where: { id: member.shopId }, select: { name: true, domain: true } });
      candidates.push({ memberId: member.id, shopId: member.shopId, shopName: shop?.name || shop?.domain || "Store", role: asRole(member.role) });
    } else {
      failed.push(member.id);
    }
  }
  if (candidates.length === 0) {
    for (const id of failed) {
      const m = members.find((x) => x.id === id)!;
      const count = m.failedLogins + 1;
      await db.teamMember.update({
        where: { id },
        data: { failedLogins: count, ...(count >= MAX_FAILED_LOGINS ? { lockedUntil: new Date(now + LOCK_MS), failedLogins: 0 } : {}) },
      });
    }
    // Same message whether the password was wrong or the row has none yet
    // (owner before setting one) — no account enumeration.
    return { ok: false, error: generic };
  }
  await db.teamMember.updateMany({ where: { id: { in: candidates.map((c) => c.memberId) } }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  return { ok: true, candidates };
}

// ── Notifications helpers used by notify.server.ts ──────────────────────────

/** Members that should hear about an event in a conversation. */
export async function notificationRecipients(args: {
  shopId: string;
  kind: "handover" | "humanReply" | "newConversation";
  assigneeId: string | null;
}): Promise<Array<{ id: string; email: string; name: string; role: MemberRole; prefs: NotifyPrefs }>> {
  requireShopId(args.shopId);
  let members = await db.teamMember.findMany({ where: { shopId: args.shopId, status: "active" } });
  if (members.length === 0) {
    // Fresh install: the owner row is normally created the first time the
    // merchant opens the web app. Bootstrap it here so handover emails reach
    // the store owner before that ever happens.
    const shop = await db.shop.findUnique({ where: { id: args.shopId }, select: { domain: true } });
    if (shop) {
      try {
        await ensureOwnerMember(args.shopId, shop.domain);
        members = await db.teamMember.findMany({ where: { shopId: args.shopId, status: "active" } });
      } catch (error) {
        logError("notification_owner_bootstrap_failed", error);
      }
    }
  }
  return members
    .map((m) => ({ id: m.id, email: m.email, name: m.name, role: asRole(m.role), prefs: parseNotifyPrefs(m.notifyPrefs, m.role) }))
    .filter((m) => {
      // Assigned conversations only notify the assignee (+ nobody else).
      if (args.assigneeId && args.assigneeId !== assigneeKeyFor(m)) return false;
      return true;
    });
}

export { handoverEmail };
