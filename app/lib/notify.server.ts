import { requireShopId } from "./tenancy.server";

// Merchant notification seam (spec 10). v1: no email provider is configured
// for this app yet (delta noted in the spec: "email notify pending
// email-provider decision"), so the in-admin notification IS the Inbox
// Handover filter badge + unread state, both server-computed on every load.
// When the provider decision lands (spec 17 / later), wire SMTP or an email
// API inside this function — every call site already passes through here.

export async function notifyMerchantHandover(
  shopId: string,
  conversationId: string,
): Promise<void> {
  requireShopId(shopId);
  // TODO(email-provider): send the merchant a handover email with a deep link
  // to /app/inbox?c=<conversationId>. Until then this is a structured log —
  // the handover_triggered analytics event is already recorded by the runtime.
  console.log(
    `[notify] handover pending for shop ${shopId} conversation ${conversationId} (email notify pending email-provider decision)`,
  );
}
