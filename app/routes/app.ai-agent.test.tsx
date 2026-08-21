import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { recordEvent } from "../lib/analytics/events.server";
import { PipelineFlowGuide, type FlowConfig } from "../components/PipelineFlowGuide";
import { TestAiConsole } from "../components/TestAiConsole";
import { PageHeader } from "../components/ui/PageHeader";
import { requireShopAccess } from "../lib/access.server";
import { getShopConfig } from "../lib/config/shop-config.server";
import { routeError } from "../lib/ui/route-error";

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
  const { shopId } = await requireShopAccess(request, { permission: "ai_agent" });

  const [config, persona, faqs, shop] = await Promise.all([
    getShopConfig(shopId),
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

  // The walkthrough quotes THIS shop live thresholds, so a value changed in
  // Instructions is reflected here with no second source of truth.
  const flow: FlowConfig = {
    aiEnabled: config.aiEnabled,
    bannedTopicCount: (config.guardrails?.bannedTopics ?? []).filter((t) => t.trim()).length,
    bannedMatchThreshold: config.guardrails?.bannedMatchThreshold ?? 0.35,
    handoverIntentRules: config.handover.intentRules.length,
    curatedMatchThreshold: config.guardrails?.curatedMatchThreshold ?? 0.8,
    curatedBorderline: config.guardrails?.curatedBorderline ?? 0.65,
    minMeaningScore: config.guardrails?.minMeaningScore ?? 0.3,
    answerOnlyFromKnowledge: config.guardrails?.answerOnlyFromKnowledge ?? true,
    learnProducts: config.settings.learn.products,
    learnDiscounts: config.settings.learn.discounts,
    excludeOutOfStock: config.settings.recommendationRules.excludeOutOfStock,
  };

  return {
    welcome,
    faqChips: faqs.map((f) => ({ id: f.id, question: f.question })),
    currency: shop?.currency ?? "USD",
    flow,
  };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<TestActionResult> => {
  const { shopId } = await requireShopAccess(request, { permission: "ai_agent" });
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
    <s-page heading="Test AI" inlineSize="large">
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
        <ImproveAiBanner />
        <PipelineFlowGuide config={data.flow} />
        <TestAiConsole welcome={data.welcome} faqChips={data.faqChips} currency={data.currency} />
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

const GUIDE_KEY = "chatconvert-test-ai-guide-dismissed";

/** Page-level nudge, dismissed per browser. Starts hidden and appears only
 *  after the effect confirms it was not dismissed — never flashes on reload. */
function ImproveAiBanner() {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(GUIDE_KEY) === "1");
    } catch {
      setDismissed(false); // private mode — show it
    }
  }, []);

  if (dismissed) return null;

  return (
    <s-banner
      tone="info"
      heading="Improve your AI"
      dismissible
      onDismiss={() => {
        setDismissed(true);
        try {
          localStorage.setItem(GUIDE_KEY, "1");
        } catch {
          /* private mode */
        }
      }}
    >
      <s-paragraph>
        Keep adding more data sources to enhance AI&apos;s capabilities, quality and efficiency.
      </s-paragraph>
    </s-banner>
  );
}
