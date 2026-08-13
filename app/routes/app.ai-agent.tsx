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
import { BRAND } from "../components/ui/tokens";
import { StripBanner } from "../components/ui/StripBanner";

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
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <s-badge tone={home.aiEnabled ? "success" : "neutral"}>
            {home.aiEnabled ? "On" : "Off"}
          </s-badge>
          <s-text tone="neutral">
            Enhance support and increase sales with an AI agent.
          </s-text>
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
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
          </span>
        </div>

        {home.aiEnabled && !bannerDismissed ? (
          <StripBanner
            tone="info"
            icon="info"
            title="Your AI agent is on"
            onDismiss={dismissBanner}
          >
            AI is now responding to customers. Review and add training data to ensure accurate
            answers.
          </StripBanner>
        ) : null}
        {!home.aiEnabled ? (
          <StripBanner tone="warning" icon="alert-triangle" title="Your AI agent is off">
            The chat widget falls back to contact and leave-a-message options until you activate
            the AI agent again.
          </StripBanner>
        ) : null}

        <s-section>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <s-heading>AI unresolved questions</s-heading>
                {home.pendingUnresolved > 0 ? (
                  <s-badge tone="warning">{home.pendingUnresolved} pending</s-badge>
                ) : (
                  <s-badge tone="success">All clear</s-badge>
                )}
              </div>
              <s-paragraph>Monitor and improve AI agent responses</s-paragraph>
            </div>
            <s-button variant="tertiary" onClick={() => navigate("/app/ai-agent/review")}>
              Go to review
            </s-button>
          </div>
        </s-section>

        <s-section heading="Setup AI agent">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            <SetupCard
              step="STEP 1"
              title="Training data"
              description="What AI knows about your business"
              statusLabel={
                trainingDone ? `${home.itemsLearned} items learned` : "No items learned yet"
              }
              statusTone={trainingDone ? "success" : "warning"}
              pct={trainingDone ? 100 : 0}
              button={
                <s-button onClick={() => navigate("/app/ai-agent/training")}>Manage</s-button>
              }
            />
            <SetupCard
              step="STEP 2"
              title="Instructions"
              description="How AI responds to your customers"
              statusLabel={
                home.instructionsPct >= 100
                  ? "Complete"
                  : home.instructionsPct > 0
                    ? "Needs a few tweaks"
                    : "Not started"
              }
              statusTone={home.instructionsPct >= 100 ? "success" : "warning"}
              pct={home.instructionsPct}
              button={
                <s-button onClick={() => navigate("/app/ai-agent/instructions")}>
                  Manage
                </s-button>
              }
            />
            <SetupCard
              step="STEP 3"
              title="Test AI"
              description="Chat with your AI to test responses"
              statusLabel={testReady ? "Ready to test" : "Finish steps 1 & 2"}
              statusTone={testReady ? "success" : "neutral"}
              pct={testReady ? 100 : 0}
              button={
                <s-button onClick={() => navigate("/app/ai-agent/test")}>
                  Test now
                </s-button>
              }
            />
          </div>
        </s-section>

        <s-section>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <div style={{ flex: 1 }}>
              <s-heading>Want us to set up your AI agent?</s-heading>
              <s-paragraph>
                Our team trains it on your store, writes the instructions, and gets it ready — so
                you can switch it on with confidence.
              </s-paragraph>
              <div style={{ marginTop: 10 }}>
                <s-button
                  variant="primary"
                  onClick={() =>
                    window.open(
                      "mailto:support@chatconvert.app?subject=Set%20up%20my%20AI%20agent",
                      "_blank",
                    )
                  }
                >
                  Set it up for me
                </s-button>
              </div>
            </div>
            <div style={{ fontSize: 56 }} aria-hidden="true">
              🤖
            </div>
          </div>
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
  button: React.ReactNode;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small">
        <s-text tone="neutral">{props.step}</s-text>
        <s-heading>{props.title}</s-heading>
        <s-text tone="neutral">{props.description}</s-text>
        <s-badge tone={props.statusTone}>{props.statusLabel}</s-badge>
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: "var(--s-color-border, #e3e3e3)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, Math.max(0, props.pct))}%`,
              height: "100%",
              background: BRAND.progressGradient,
              borderRadius: 3,
              transition: "width 300ms ease",
            }}
          />
        </div>
        {props.button}
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
