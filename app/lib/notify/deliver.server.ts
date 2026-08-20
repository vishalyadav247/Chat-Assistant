import db from "../../db.server";
import { sendEmail } from "../email/email.server";
import type { NotifyJobData } from "../notify.server";
import { handoverEmail, notificationRecipients, webBaseUrl } from "../team/team.server";
import { requireShopId } from "../tenancy.server";
import { sendPushToMembers } from "./push.server";

// Job-side delivery for team notifications (spec 18). Picks recipients by
// role/assignment/preferences, sends Web Push to their devices and (handover
// only) an email to members who opted in.

export async function deliverNotification(data: NotifyJobData): Promise<void> {
  const shopId = requireShopId(data.shopId);
  const convo = await db.conversation.findFirst({
    where: { id: data.conversationId, shopId },
    select: { id: true, assigneeId: true, blocked: true, isTest: true, contactId: true },
  });
  if (!convo || convo.isTest || convo.blocked) return;

  const [recipients, shop, lastShopperMessage, contact] = await Promise.all([
    notificationRecipients({ shopId, kind: data.kind, assigneeId: convo.assigneeId }),
    db.shop.findUnique({ where: { id: shopId }, select: { name: true, domain: true } }),
    db.message.findFirst({
      where: { conversationId: convo.id, shopId, author: "shopper" },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    }),
    convo.contactId ? db.contact.findFirst({ where: { id: convo.contactId, shopId }, select: { name: true, email: true } }) : null,
  ]);
  if (recipients.length === 0) return;

  const shopName = shop?.name || shop?.domain || "your store";
  const who = contact?.name?.trim() || contact?.email?.split("@")[0] || "A shopper";
  const snippet = (lastShopperMessage?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  // Through the web login: signed-in browsers are forwarded straight to
  // `next`; a fresh device (email on a phone) gets the login form instead of
  // the Shopify admin bounce.
  const url = `${webBaseUrl()}/web/login?next=${encodeURIComponent(`/app/inbox?c=${convo.id}`)}`;

  const title =
    data.kind === "handover"
      ? `${who} needs a human · ${shopName}`
      : data.kind === "humanReply"
        ? `New message from ${who}`
        : `New conversation · ${shopName}`;
  const body = snippet || (data.kind === "handover" ? "Open the inbox to reply." : "Open the inbox to take a look.");

  const pushMembers = recipients.filter((r) => r.prefs.push[data.kind]).map((r) => r.id);
  await sendPushToMembers(shopId, pushMembers, { title, body, url, tag: convo.id });

  if (data.kind === "handover") {
    const seen = new Set<string>();
    for (const r of recipients) {
      if (!r.prefs.emailHandover || seen.has(r.email)) continue;
      seen.add(r.email);
      // No transcript snippet in email (third-party processor) — the link is enough.
      await sendEmail(handoverEmail({ to: r.email, shopName, url }));
    }
  }
}
