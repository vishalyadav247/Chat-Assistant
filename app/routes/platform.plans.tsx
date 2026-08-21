import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { ZodError } from "zod";
import { PlatformShell } from "../components/platform/PlatformShell";
import { TabPills } from "../components/ui/TabPills";
import { SPACE } from "../components/ui/tokens";
import { useAppBridge } from "../lib/ui/surface";
import { requirePlatformAdmin } from "../lib/platform/platform-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import {
  getStoredPlanConfig,
  resetPlanConfig,
  savePlanConfig,
} from "../lib/platform/platform-settings.server";
import { DEFAULT_PLANS, loadPlanConfig, PLANS, planEnforcementMode } from "../lib/billing/plans.server";
import {
  GATED_FEATURES,
  PLAN_IDS,
  QUOTA_DIMENSIONS,
  type GatedFeature,
  type PlanDefinition,
  type PlanId,
  type QuotaDimension,
} from "../lib/billing/plan-shared";

// Platform → Plans (spec 19). Edits the LIVE plan matrix used by every gate,
// meter, and the merchant plan page. This page also owns the enforcement
// switch — it replaces the old "edit the ENFORCEMENT constant" step (spec 15).

const QUOTA_LABELS: Record<QuotaDimension, string> = {
  conversations: "Conversations / month",
  products_synced: "Products synced",
  curated_answers: "Curated answers",
  manual_qas: "Manual Q&As",
  policy_pages: "Policy pages",
  crawl_pages: "Website pages crawled",
  file_uploads: "File uploads",
  metafields_enabled: "Metafields enabled for AI",
  team_seats: "Team seats",
  active_campaigns: "Active proactive campaigns",
  analytics_range_days: "Analytics history (days)",
};

const FEATURE_LABELS: Record<GatedFeature, string> = {
  remove_branding: "Remove ChatConvert branding",
  unanswered_analytics: "Unanswered-questions analytics",
  discount_realtime_sync: "Real-time discount sync",
  catalog_auto_sync: "Catalog auto-sync",
  premium_campaign_templates: "Premium campaign templates",
  inbox_cart_view: "Inbox cart view",
  exports: "Data exports",
  csv_import: "CSV import",
  file_upload: "File upload sources",
  survey: "Post-chat survey (CSAT)",
  push_notifications: "Browser push notifications",
  custom_recommendations: "Custom recommendations + cross-sells",
  multi_language: "Multi-language auto-detect",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePlatformAdmin(request);
  await loadPlanConfig(); // guarantee the freshest matrix for the editor
  const stored = await getStoredPlanConfig();
  return {
    adminEmail: session.admin.email,
    plans: PLANS,
    defaults: DEFAULT_PLANS,
    enforcement: planEnforcementMode(),
    hasOverrides: Boolean(stored.enforcement || stored.plans),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requirePlatformAdmin(request);
  if (!sameOrigin(request)) return { ok: false as const, error: "Request blocked. Reload the page and try again." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "enforcement") {
      const stored = await getStoredPlanConfig();
      const mode = String(form.get("mode")) === "enforced" ? ("enforced" as const) : ("open" as const);
      await savePlanConfig({ ...stored, enforcement: mode });
      return { ok: true as const, error: null };
    }

    if (intent === "save-plan") {
      const planId = String(form.get("planId")) as PlanId;
      if (!PLAN_IDS.includes(planId)) return { ok: false as const, error: "Unknown plan." };
      const payload = JSON.parse(String(form.get("payload") ?? "{}")) as {
        priceMonthly: number;
        priceYearlyPerMonth: number;
        trialDays: number;
        overagePerConversation: number | null;
        quotas: Record<string, number>;
        features: string[];
      };
      const stored = await getStoredPlanConfig();
      await savePlanConfig({
        ...stored,
        plans: { ...stored.plans, [planId]: payload },
      });
      return { ok: true as const, error: null };
    }

    if (intent === "reset") {
      await resetPlanConfig();
      return { ok: true as const, error: null };
    }
  } catch (error) {
    if (error instanceof ZodError) {
      // Human-readable first issue (with its path) instead of the raw issues JSON.
      const issue = error.issues[0];
      const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return { ok: false as const, error: `${path}${issue?.message ?? "Invalid values."}`.slice(0, 300) };
    }
    const message = error instanceof Error ? error.message : "Invalid values.";
    return { ok: false as const, error: message.slice(0, 300) };
  }
  return { ok: false as const, error: "Unknown action." };
};

interface PlanDraft {
  priceMonthly: string;
  priceYearlyPerMonth: string;
  trialDays: string;
  overage: string; // "" = null = AI stops at cap
  quotas: Record<QuotaDimension, string>;
  features: GatedFeature[];
}

function toDraft(plan: PlanDefinition): PlanDraft {
  return {
    priceMonthly: String(plan.priceMonthly),
    priceYearlyPerMonth: String(plan.priceYearlyPerMonth),
    trialDays: String(plan.trialDays),
    overage: plan.overagePerConversation === null ? "" : String(plan.overagePerConversation),
    quotas: Object.fromEntries(
      QUOTA_DIMENSIONS.map((dim) => [dim, String(plan.quotas[dim])]),
    ) as Record<QuotaDimension, string>,
    features: [...plan.features],
  };
}

export default function PlatformPlans() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  // Feedback as a toast (like the admin/web surfaces), not a banner on top.
  const handled = useRef<unknown>(null);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) shopify.toast.show("Saved — live within ~30 seconds");
    else if (result.error) shopify.toast.show(result.error, { isError: true });
  }, [fetcher.data, fetcher.state, shopify]);

  const [tier, setTier] = useState<PlanId>("free");
  const initialDrafts = useMemo(
    () => Object.fromEntries(PLAN_IDS.map((id) => [id, toDraft(data.plans[id])])) as Record<PlanId, PlanDraft>,
    // Drafts seed once from the loader; edits live in local state until saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [drafts, setDrafts] = useState(initialDrafts);
  const draft = drafts[tier];

  const patchDraft = (patch: Partial<PlanDraft>) =>
    setDrafts((prev) => ({ ...prev, [tier]: { ...prev[tier], ...patch } }));

  const savePlan = () => {
    const num = (value: string, fallback: number) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const defaults = data.defaults[tier];
    fetcher.submit(
      {
        intent: "save-plan",
        planId: tier,
        payload: JSON.stringify({
          priceMonthly: num(draft.priceMonthly, defaults.priceMonthly),
          priceYearlyPerMonth: num(draft.priceYearlyPerMonth, defaults.priceYearlyPerMonth),
          trialDays: Math.floor(num(draft.trialDays, defaults.trialDays)),
          overagePerConversation: draft.overage.trim() === "" ? null : num(draft.overage, 0),
          quotas: Object.fromEntries(
            QUOTA_DIMENSIONS.map((dim) => [dim, Math.floor(num(draft.quotas[dim], defaults.quotas[dim]))]),
          ),
          features: draft.features,
        }),
      },
      { method: "post" },
    );
  };

  const setEnforcement = (mode: "open" | "enforced") =>
    fetcher.submit({ intent: "enforcement", mode }, { method: "post" });

  const resetAll = () => {
    fetcher.submit({ intent: "reset" }, { method: "post" });
    setDrafts(Object.fromEntries(PLAN_IDS.map((id) => [id, toDraft(data.defaults[id])])) as Record<PlanId, PlanDraft>);
  };

  return (
    <PlatformShell adminEmail={data.adminEmail}>
      <s-page heading="Plans">
        <s-stack gap="base">
          <s-text color="subdued">
            The live plan matrix for every store — quotas, prices, and gated features. Merchant pages and gates pick
            changes up within ~30 seconds.
          </s-text>

          <s-section heading="Enforcement">
            <s-stack gap="base">
              <s-switch
                label={
                  data.enforcement === "enforced"
                    ? "Plan gates enforced"
                    : "Open mode — every feature free on every plan"
                }
                details="Open: all features usable everywhere, quotas unlimited (meters still show matrix values). Enforced: every gate and quota below is applied server-side."
                checked={data.enforcement === "enforced"}
                onChange={(e) => setEnforcement(e.currentTarget.checked ? "enforced" : "open")}
              />
              {data.enforcement === "open" ? (
                <s-banner tone="warning">
                  Enforcement is OFF: merchants on any plan can use everything. Flip the switch when the tiers below are
                  final.
                </s-banner>
              ) : null}
            </s-stack>
          </s-section>

          <s-section heading="Plan matrix">
            <s-stack gap="base">
              <TabPills
                tabs={PLAN_IDS.map((id) => ({ id, label: data.plans[id].name }))}
                active={tier}
                onChange={(id) => setTier(id)}
              />

              <s-text type="strong">Pricing</s-text>
              <s-stack direction="inline" gap="base">
                <s-text-field
                  label="Monthly price ($)"
                  value={draft.priceMonthly}
                  onInput={(e) => patchDraft({ priceMonthly: e.currentTarget.value })}
                />
                <s-text-field
                  label="Yearly ($/month)"
                  value={draft.priceYearlyPerMonth}
                  onInput={(e) => patchDraft({ priceYearlyPerMonth: e.currentTarget.value })}
                />
                <s-number-field
                  label="Trial days"
                  min={0}
                  max={90}
                  value={draft.trialDays}
                  onInput={(e) => patchDraft({ trialDays: e.currentTarget.value })}
                />
                <s-text-field
                  label="Overage $ / conversation"
                  placeholder="blank = AI stops at cap"
                  value={draft.overage}
                  onInput={(e) => patchDraft({ overage: e.currentTarget.value })}
                />
              </s-stack>
              <s-text color="subdued">
                Price changes apply to new subscriptions only — existing Shopify subscriptions keep their agreed charge.
              </s-text>

              <s-divider />

              <s-text type="strong">Quotas</s-text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
                  gap: SPACE.md,
                }}
              >
                {QUOTA_DIMENSIONS.map((dim) => (
                  <s-number-field
                    key={dim}
                    label={QUOTA_LABELS[dim]}
                    min={0}
                    value={draft.quotas[dim]}
                    onInput={(e) => patchDraft({ quotas: { ...draft.quotas, [dim]: e.currentTarget.value } })}
                  />
                ))}
              </div>

              <s-divider />

              <s-text type="strong">Features</s-text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                  gap: SPACE.sm,
                }}
              >
                {GATED_FEATURES.map((feature) => (
                  <s-checkbox
                    key={feature}
                    label={FEATURE_LABELS[feature]}
                    checked={draft.features.includes(feature)}
                    onChange={(e) =>
                      patchDraft({
                        features: e.currentTarget.checked
                          ? [...draft.features, feature]
                          : draft.features.filter((f) => f !== feature),
                      })
                    }
                  />
                ))}
              </div>

              <s-stack direction="inline" gap="base">
                <s-button variant="primary" loading={busy} onClick={savePlan}>
                  Save {data.plans[tier].name}
                </s-button>
                <s-button tone="critical" disabled={busy || !data.hasOverrides} onClick={resetAll}>
                  Reset all plans to code defaults
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        </s-stack>
      </s-page>
    </PlatformShell>
  );
}
