import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
import { recordEvent } from "../lib/analytics/events.server";
import { TestAiConsole } from "../components/TestAiConsole";
import { PageHeader } from "../components/ui/PageHeader";

// Test AI (spec 08, design ai-agent.html #viewTest): merchant chat console
// that streams the REAL pipeline via /api/test-chat (isTest: true → no usage
// meter tick, conversation flagged isTest). This route's action serves the
// per-reply debug data: the pipeline frames don't carry sourceLayer/intent,
// so after each turn the client asks for the just-saved assistant Message row.

export interface ReviewSourceData {
  sourceLayer: string | null;
  intent: unknown;
  productCards: { title: string; price: number }[] | null;
  content: string;
}

export interface TestActionResult {
  ok: boolean;
  intent: string;
  error?: string;
  source?: ReviewSourceData;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);

  const [persona, faqs, shop] = await Promise.all([
    db.persona.findUnique({ where: { shopId }, select: { welcomeMessage: true } }),
    db.faq.findMany({
      where: { shopId, status: "published" },
      orderBy: [{ featured: "desc" }, { position: "asc" }],
      take: 3,
      select: { id: true, question: true },
    }),
    db.shop.findUnique({ where: { id: shopId }, select: { currency: true } }),
  ]);

  const welcome =
    persona?.welcomeMessage?.trim() ||
    "Hello 👋 I'm the ChatConvert AI agent, here to help you find what you're looking for. How can I help you?";

  return {
    welcome,
    faqChips: faqs.map((f) => ({ id: f.id, question: f.question })),
    currency: shop?.currency ?? "USD",
  };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<TestActionResult> => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "source") {
    const conversationId = String(formData.get("conversationId") ?? "");
    if (!conversationId) return { ok: false, intent, error: "Missing conversation" };
    // The just-saved assistant reply for this test conversation — shop-scoped
    // (Message rows carry shopId; the conversationId alone is never trusted).
    const message = await db.message.findFirst({
      where: { shopId, conversationId, role: "out" },
      orderBy: { createdAt: "desc" },
      select: { sourceLayer: true, intent: true, productCards: true, content: true },
    });
    if (!message) return { ok: false, intent, error: "No reply found" };
    return {
      ok: true,
      intent,
      source: {
        sourceLayer: message.sourceLayer,
        intent: message.intent,
        productCards: message.productCards as ReviewSourceData["productCards"],
        content: message.content,
      },
    };
  }

  if (intent === "feedback") {
    const rating = Number(formData.get("rating"));
    if (![1, 2, 3].includes(rating)) return { ok: false, intent, error: "Invalid rating" };
    await recordEvent(shopId, "test_feedback", {
      rating,
      conversationId: String(formData.get("conversationId") ?? "") || undefined,
    });
    return { ok: true, intent };
  }

  return { ok: false, intent, error: `Unknown intent: ${intent || "(none)"}` };
};

export default function TestAiPage() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <s-page heading="Test AI">
      <s-stack gap="base">
        <PageHeader
          backTo="/app/ai-agent"
          backLabel="AI Agent"
          description="Chat with your AI exactly as a shopper would. Replies use your live training data and instructions; test chats never appear in the inbox."
          toolbar={
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-button onClick={() => navigate("/app/ai-agent/training")}>Training data</s-button>
              <s-button onClick={() => navigate("/app/ai-agent/instructions")}>
                Edit instructions
              </s-button>
            </s-stack>
          }
        />
        <TestAiConsole welcome={data.welcome} faqChips={data.faqChips} currency={data.currency} />
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
