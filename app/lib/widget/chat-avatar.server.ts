import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import type { WidgetSettingsData } from "../settings/schemas";

// The identity a shopper sees on AI/agent replies (Chatbox → Chat page → Chat
// avatar, spec 06). ONE resolver, because four surfaces render it and they must
// agree: the storefront widget config, the chatbox live preview, the inbox
// thread, and the campaign bubbles.
//
// Two modes:
//   store_branding — Settings → General store logo + name
//   team_member    — a chosen TeamMember's photo + name
//
// Both degrade to the store, never to nothing. A member who was disabled or
// removed after being chosen would otherwise blank the storefront avatar and
// strip the author caption — a settings change made in the Team page silently
// altering what shoppers see. Falling back keeps the widget coherent, and the
// Chatbox page surfaces the stale selection so the merchant can fix it.

export interface ChatAvatar {
  url: string | null;
  name: string;
}

/** Store-branding identity — also the fallback for every other mode. */
export function storeAvatar(
  storeInfo: { logoUrl: string | null; name: string },
  fallbackName: string,
): ChatAvatar {
  return { url: storeInfo.logoUrl, name: storeInfo.name.trim() || fallbackName };
}

/**
 * Resolve the avatar for a shop's current settings.
 *
 * @param fallbackName shop name / domain handle, when Store information has no name
 */
export async function resolveChatAvatar(
  shopId: string,
  widget: Pick<WidgetSettingsData, "avatarMode" | "avatarMemberId">,
  storeInfo: { logoUrl: string | null; name: string },
  fallbackName: string,
): Promise<ChatAvatar> {
  requireShopId(shopId);
  const store = storeAvatar(storeInfo, fallbackName);
  if (widget.avatarMode !== "team_member" || !widget.avatarMemberId) return store;

  const member = await db.teamMember.findFirst({
    // shopId in the WHERE, not just the id: a member id from another shop's
    // settings blob must never resolve.
    where: { id: widget.avatarMemberId, shopId, status: "active" },
    select: { name: true, avatarUrl: true },
  });
  if (!member) return store;
  return { url: member.avatarUrl, name: member.name.trim() || store.name };
}
