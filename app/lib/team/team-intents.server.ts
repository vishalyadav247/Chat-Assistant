import { z } from "zod";
import db from "../../db.server";
import type { ShopAccess } from "../access.server";
import {
  inviteMember,
  issueResetLink,
  removeMember,
  resendInvite,
  setMemberRole,
  setMemberStatus,
} from "./team.server";

// Settings → Team intents (spec 18). Called from the settings route action
// for every `team-*` intent; the caller has already passed requireShopAccess
// with the "settings" permission (owner/admin only).

export interface TeamIntentResult {
  ok: boolean;
  intent: string;
  error?: string;
  /** Invite / reset link for the copy-link fallback (always returned; the UI
   *  shows it when emailDelivered is false). */
  link?: string;
  emailDelivered?: boolean;
}

export function isTeamIntent(intent: string): boolean {
  return intent.startsWith("team-");
}

export async function applyTeamIntent(args: {
  access: ShopAccess;
  intent: string;
  raw: unknown;
}): Promise<TeamIntentResult> {
  const { access, intent } = args;
  const shopId = access.shopId;
  const raw = args.raw ?? {};
  const inviterName =
    access.member?.name ??
    (await db.shop.findUnique({ where: { id: shopId }, select: { name: true } }))?.name ??
    "The store owner";

  try {
    switch (intent) {
      case "team-invite": {
        const p = z
          .object({
            name: z.string().trim().min(1).max(100),
            email: z.string().trim().email().max(200),
            role: z.enum(["admin", "agent"]).default("agent"),
          })
          .parse(raw);
        const result = await inviteMember({ shopId, name: p.name, email: p.email, role: p.role, inviterName });
        return { ok: result.ok, intent, error: result.error, link: result.inviteUrl, emailDelivered: result.emailDelivered };
      }
      case "team-resend": {
        const p = z.object({ id: z.string().min(1) }).parse(raw);
        const result = await resendInvite({ shopId, memberId: p.id, inviterName });
        return { ok: result.ok, intent, error: result.error, link: result.inviteUrl, emailDelivered: result.emailDelivered };
      }
      case "team-reset-link": {
        const p = z.object({ id: z.string().min(1) }).parse(raw);
        // Never for the owner row; web admins may only reset agents (a reset
        // link is account takeover, so it must not cross privilege levels).
        const target = await db.teamMember.findFirst({ where: { id: p.id, shopId }, select: { role: true } });
        if (!target) return { ok: false, intent, error: "Member not found." };
        if (target.role === "owner") return { ok: false, intent, error: "The owner signs in from the Shopify admin." };
        if (access.role === "admin" && target.role !== "agent") {
          return { ok: false, intent, error: "Only the store owner can reset another admin's password." };
        }
        const result = await issueResetLink(shopId, p.id);
        return { ok: result.ok, intent, error: result.error, link: result.url, emailDelivered: result.emailDelivered };
      }
      case "team-role": {
        const p = z.object({ id: z.string().min(1), role: z.enum(["admin", "agent"]) }).parse(raw);
        // A member can't change their own role (would lock themselves out).
        if (access.member && access.member.id === p.id) return { ok: false, intent, error: "You can't change your own role." };
        return { ok: await setMemberRole(shopId, p.id, p.role), intent };
      }
      case "team-status": {
        const p = z.object({ id: z.string().min(1), status: z.enum(["active", "disabled"]) }).parse(raw);
        if (access.member && access.member.id === p.id) return { ok: false, intent, error: "You can't disable yourself." };
        return { ok: await setMemberStatus(shopId, p.id, p.status), intent };
      }
      case "team-remove": {
        const p = z.object({ id: z.string().min(1) }).parse(raw);
        if (access.member && access.member.id === p.id) return { ok: false, intent, error: "You can't remove yourself." };
        return { ok: await removeMember(shopId, p.id), intent };
      }
      default:
        return { ok: false, intent, error: `Unknown team intent: ${intent}` };
    }
  } catch (error) {
    return { ok: false, intent, error: error instanceof Error ? error.message : "Invalid team payload" };
  }
}
