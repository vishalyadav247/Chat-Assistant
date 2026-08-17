import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useOutlet, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
import { invalidateShopConfig } from "../lib/config/shop-config.server";
import { loadShopSettings } from "../lib/settings/save.server";
import { ProgressTrack } from "../components/ui/Progress";

// AI Agent home (spec 07, design ai-agent.html #viewAgent): master AI switch,
// unresolved-questions card, 3-step setup grid, done-for-you promo. This route
// is also the layout for /app/ai-agent/training and /app/ai-agent/review — it
// renders the child outlet when one matches.
//
// Deactivate stops AI replies at the pipeline gate: app/lib/pipeline/
// index.server.ts checks `config.aiEnabled` and short-circuits to the fallback
// path; the widget's aiAvailable flag (app/lib/widget/config.server.ts) flips
// the storefront into contact/leave-message mode.

const BANNER_KEY = "chatconvert-ai-agent-banner-dismissed";

interface HomeData {
  aiEnabled: boolean;
  pendingUnresolved: number;
  itemsLearned: number;
  instructionsPct: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  // Child routes (training / review) load their own data — skip the home queries.
  if (url.pathname.replace(/\/+$/, "") !== "/app/ai-agent") {
    return { home: null as HomeData | null };
  }
  const shopId = await resolveShopId(session.shop);

  const [shop, pendingUnresolved, learnedProducts, sources, publishedFaqs, persona, settings] =
    await Promise.all([
      db.shop.findUnique({ where: { id: shopId }, select: { aiEnabled: true } }),
      db.unresolvedQuestion.count({ where: { shopId, status: "pending" } }),
      db.product.count({ where: { shopId, learnEnabled: true } }),
      db.dataSource.findMany({
        where: { shopId, status: { not: "suggested" }, type: { not: "faq" } },
        select: { chunkCount: true },
      }),
      db.faq.count({ where: { shopId, status: "published" } }),
      db.persona.findUnique({
        where: { shopId },
        select: { role: true, behaviours: true, communicationStyle: true },
      }),
      loadShopSettings(shopId),
    ]);

  const knowledgeChunks = sources.reduce((sum, s) => sum + s.chunkCount, 0);
  // Instructions completeness heuristic (spec 07): role + behaviours + style.
  const instructionsPct = Math.min(
    100,
    (persona?.role?.trim() ? 40 : 0) +
      (persona?.behaviours?.trim() ? 40 : 0) +
      (persona?.communicationStyle?.trim() ? 20 : 0),
  );

  return {
    home: {
      aiEnabled: shop?.aiEnabled ?? true,
      pendingUnresolved,
      // Master learn permission gates the effective count (spec 07): products
      // don't count as learned while ShopSettings.learn.products is off.
      itemsLearned:
        (settings.learn.products ? learnedProducts : 0) + knowledgeChunks + publishedFaqs,
      instructionsPct,
    } as HomeData,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "toggle-ai") {
    const enabled = String(formData.get("enabled")) === "true";
    await db.shop.update({ where: { id: shopId }, data: { aiEnabled: enabled } });
    invalidateShopConfig(shopId);
    return { ok: true as const, enabled };
  }
  return { ok: false as const, enabled: false };
};

export default function AiAgentPage() {
  const outlet = useOutlet();
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const [bannerDismissed, setBannerDismissed] = useState(true);

  useEffect(() => {
    try {
      setBannerDismissed(localStorage.getItem(BANNER_KEY) === "1");
    } catch {
      setBannerDismissed(false);
    }
  }, []);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(
        fetcher.data.enabled
          ? "AI agent activated"
          : "AI agent deactivated — the widget falls back to contact options",
      );
    }
  }, [fetcher.state, fetcher.data, shopify]);

  if (outlet) return outlet;
  const home = data.home;
  if (!home) return null;

  const busy = fetcher.state !== "idle";
  const trainingDone = home.itemsLearned > 0;
  const testReady = trainingDone && home.instructionsPct > 0;

  const dismissBanner = () => {
    setBannerDismissed(true);
    try {
      localStorage.setItem(BANNER_KEY, "1");
    } catch {
      /* private mode */
    }
  };

  return (
    <s-page heading="AI Agent">
      <s-stack gap="base">
        {/* Status + page actions stay INSIDE the page (user decision 2026-08-17). */}
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={home.aiEnabled ? "success" : "neutral"} icon={home.aiEnabled ? "check-circle" : "circle-dashed"}>
              {home.aiEnabled ? "AI agent on" : "AI agent off"}
            </s-badge>
            <s-text color="subdued">Enhance support and increase sales with an AI agent.</s-text>
          </s-stack>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-button onClick={() => navigate("/app/ai-agent/test")}>Test AI</s-button>
            <s-button
              variant="primary"
              disabled={busy}
              loading={busy}
              onClick={() =>
                fetcher.submit(
                  { intent: "toggle-ai", enabled: home.aiEnabled ? "false" : "true" },
                  { method: "post" },
                )
              }
            >
              {home.aiEnabled ? "Deactivate" : "Activate"}
            </s-button>
          </s-stack>
        </s-grid>

        {home.aiEnabled && !bannerDismissed ? (
          <s-banner
            tone="info"
            heading="Your AI agent is on"
            dismissible
            onDismiss={dismissBanner}
          >
            AI is now responding to customers. Review and add training data to ensure accurate
            answers.
          </s-banner>
        ) : null}
        {!home.aiEnabled ? (
          <s-banner tone="warning" heading="Your AI agent is off">
            The chat widget falls back to contact and leave-a-message options until you activate
            the AI agent again.
          </s-banner>
        ) : null}

        <s-section>
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-stack gap="small-200">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading>AI unresolved questions</s-heading>
                {home.pendingUnresolved > 0 ? (
                  <s-badge tone="warning">{home.pendingUnresolved} pending</s-badge>
                ) : (
                  <s-badge tone="success">All clear</s-badge>
                )}
              </s-stack>
              <s-paragraph color="subdued">
                Questions the AI couldn&apos;t answer confidently — turn them into training data.
              </s-paragraph>
            </s-stack>
            <s-button onClick={() => navigate("/app/ai-agent/review")}>Go to review</s-button>
          </s-grid>
        </s-section>

        <s-section heading="Set up your AI agent">
          <s-stack gap="base">
            <s-paragraph color="subdued">
              Three steps: teach it your store, tell it how to behave, then try it out.
            </s-paragraph>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
              <SetupCard
                step="Step 1"
                title="Training data"
                description="What the AI knows about your business"
                statusLabel={
                  trainingDone ? `${home.itemsLearned} items learned` : "No items learned yet"
                }
                statusTone={trainingDone ? "success" : "warning"}
                pct={trainingDone ? 100 : 0}
                actionLabel="Manage"
                onAction={() => navigate("/app/ai-agent/training")}
              />
              <SetupCard
                step="Step 2"
                title="Instructions"
                description="How the AI responds to your customers"
                statusLabel={
                  home.instructionsPct >= 100
                    ? "Complete"
                    : home.instructionsPct > 0
                      ? "Needs a few tweaks"
                      : "Not started"
                }
                statusTone={home.instructionsPct >= 100 ? "success" : "warning"}
                pct={home.instructionsPct}
                actionLabel="Manage"
                onAction={() => navigate("/app/ai-agent/instructions")}
              />
              <SetupCard
                step="Step 3"
                title="Test AI"
                description="Chat with your AI to check its answers"
                statusLabel={testReady ? "Ready to test" : "Finish steps 1 & 2"}
                statusTone={testReady ? "success" : "neutral"}
                pct={testReady ? 100 : 0}
                actionLabel="Test now"
                onAction={() => navigate("/app/ai-agent/test")}
              />
            </s-grid>
          </s-stack>
        </s-section>

        <s-section>
          <s-grid gridTemplateColumns="1fr auto" gap="large" alignItems="center">
            <s-stack gap="small-200">
              <s-heading>Want us to set up your AI agent?</s-heading>
              <s-paragraph color="subdued">
                Our team trains it on your store, writes the instructions, and gets it ready — so
                you can switch it on with confidence.
              </s-paragraph>
              <s-box paddingBlockStart="small-200">
                <s-button
                  variant="primary"
                  icon="email"
                  onClick={() =>
                    window.open(
                      "mailto:support@chatconvert.app?subject=Set%20up%20my%20AI%20agent",
                      "_blank",
                    )
                  }
                >
                  Set it up for me
                </s-button>
              </s-box>
            </s-stack>
            <s-box
              padding="base"
              borderRadius="base"
              background="subdued"
              accessibilityVisibility="hidden"
            >
              <s-icon type="chat" tone="neutral" />
            </s-box>
          </s-grid>
        </s-section>
      </s-stack>
    </s-page>
  );
}

function SetupCard(props: {
  step: string;
  title: string;
  description: string;
  statusLabel: string;
  statusTone: "success" | "warning" | "neutral";
  pct: number;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="base">
      <s-stack gap="small-200">
        <s-text color="subdued" type="strong">
          {props.step.toUpperCase()}
        </s-text>
        <s-heading>{props.title}</s-heading>
        <s-text color="subdued">{props.description}</s-text>
        <s-box paddingBlock="small-200">
          <s-badge tone={props.statusTone}>{props.statusLabel}</s-badge>
        </s-box>
        <ProgressTrack value={props.pct} max={100} height={6} label={`${props.title} progress`} />
        <s-box paddingBlockStart="small-200">
          <s-button onClick={props.onAction}>{props.actionLabel}</s-button>
        </s-box>
      </s-stack>
    </s-box>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
