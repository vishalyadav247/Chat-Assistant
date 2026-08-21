import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { submitHandoverForm } from "../lib/inbox/inbox.server";
import { resolveShopId } from "../lib/tenancy.server";
import { authenticate } from "../shopify.server";

// POST /apps/chatconvert/handover-form — leave-a-message / collect-email form
// (spec 10). Creates a lead Contact, attaches it to the conversation, and
// stores the request in the thread. Shop identity comes ONLY from the
// verified proxy signature.

const bodySchema = z.object({
  sessionId: z.string().min(8).max(64),
  conversationId: z.string().min(1).max(64),
  values: z.object({
    email: z.email().max(200).transform((v) => v.trim().toLowerCase()),
    issue: z.string().trim().min(1).max(2000),
    orderNumber: z.string().max(60).optional(),
    phone: z.string().max(40).optional(),
  }),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return new Response("app not installed", { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }

  const shopId = await resolveShopId(session.shop);
  const result = await submitHandoverForm(shopId, parsed.data);
  if (!result) {
    return new Response("not found", { status: 404 });
  }

  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
};
