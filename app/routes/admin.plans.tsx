import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { ZodError } from "zod";
import { AdminShell } from "../components/admin/AdminShell";
import { AdminCard, AdminPage } from "../components/admin/AdminUi";
import { TabPills } from "../components/ui/TabPills";
import { SPACE } from "../components/ui/tokens";
import {
  ANALYTICS_RANGES,
  ANALYTICS_RANGE_DAYS,
  ANALYTICS_RANGE_LABELS,
} from "../lib/analytics/shared";
import { useAppBridge } from "../lib/ui/surface";
import { requireAdminUser } from "../lib/admin/admin-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import {
  getStoredPlanConfig,
  resetPlanConfig,
  savePlanConfig,
} from "../lib/admin/admin-settings.server";
import {
  DEFAULT_PLANS,
  loadPlanConfig,
  PLANS,
  planEnforcementMode,
  yearlyBillingEnabled,
} from "../lib/billing/plans.server";
import {
  GATED_FEATURES,
  OPEN_MODE_PLAN,
  PLAN_IDS,
  QUOTA_DIMENSIONS,
  type GatedFeature,
  type PlanDefinition,
  type PlanId,
  type QuotaDimension,
} from "../lib/billing/plan-shared";

// Admin → Plans (spec 19). Edits the LIVE plan matrix used by every gate,
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
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requireAdminUser(request);
  await loadPlanConfig(); // guarantee the freshest matrix for the editor
  const stored = await getStoredPlanConfig();
  return {
    adminEmail: session.admin.email,
    plans: PLANS,
    defaults: DEFAULT_PLANS,
    enforcement: planEnforcementMode(),
    yearlyBilling: yearlyBillingEnabled(),
    hasOverrides: Boolean(stored.enforcement || stored.plans),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireAdminUser(request);
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

    if (intent === "yearly-billing") {
      const stored = await getStoredPlanConfig();
      await savePlanConfig({ ...stored, yearlyBilling: form.get("enabled") === "true" });
      return { ok: true as const, error: null };
    }

    if (intent === "save-plan") {
      const planId = String(form.get("planId")) as PlanId;
      if (!PLAN_IDS.includes(planId)) return { ok: false as const, error: "Unknown plan." };
      const payload = JSON.parse(String(form.get("payload") ?? "{}")) as {
        hidden: boolean;
        overagePerConversation: number | null;
        priceMonthly: number;
        priceYearlyPerMonth: number;
        trialDays: number;
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
  hidden: boolean;
  priceMonthly: string;
  priceYearlyPerMonth: string;
  trialDays: string;
  /** "" = null = this plan hard-caps instead of billing. Paid tiers only. */
  overage: string;
  quotas: Record<QuotaDimension, string>;
  features: GatedFeature[];
}

function toDraft(plan: PlanDefinition): PlanDraft {
  return {
    hidden: plan.hidden,
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

export default function AdminPlans() {
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
          hidden: draft.hidden,
          priceMonthly: num(draft.priceMonthly, defaults.priceMonthly),
          priceYearlyPerMonth: num(draft.priceYearlyPerMonth, defaults.priceYearlyPerMonth),
          trialDays: Math.floor(num(draft.trialDays, defaults.trialDays)),
          // Free is filtered server-side too (applyConfig ignores a rate for it),
          // but do not even send one — the field is not rendered for that tier.
          overagePerConversation:
            tier === "free" ? null : draft.overage.trim() === "" ? null : num(draft.overage, 0),
          quotas: Object.fromEntries(
            QUOTA_DIMENSIONS.map((dim) => [dim, Math.floor(num(draft.quotas[dim], defaults.quotas[dim]))]),
          ),
          features: draft.features,
          // Stamp the list this screen actually offered, so features shipped
          // later are not mistaken for ones deliberately switched off.
          knownFeatures: GATED_FEATURES,
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
    <AdminShell adminEmail={data.adminEmail}>
      <AdminPage heading="Plans" subheading="The live plan matrix for every store — quotas, prices, and gated features. Merchant pages and gates pick changes up within ~30 seconds.">
        <s-stack gap="base">
          <AdminCard heading="Enforcement">
            <s-stack gap="base">
              <s-switch
                label={
                  data.enforcement === "enforced"
                    ? "Plan gates enforced"
                    : `Open mode — every store gets the ${data.plans[OPEN_MODE_PLAN].name} plan`
                }
                details={`Enforced: every gate and quota below is applied server-side. Open: every store gets ${data.plans[OPEN_MODE_PLAN].name}'s features and limits instead of its own — generous, but still a real plan with a ceiling. Meters keep showing each store's own matrix values.`}
                checked={data.enforcement === "enforced"}
                onInput={(e) => setEnforcement(e.currentTarget.checked ? "enforced" : "open")}
              />
              {data.enforcement === "open" ? (
                <s-banner tone="warning">
                  Enforcement is OFF: every store is being served {data.plans[OPEN_MODE_PLAN].name} limits and features,
                  whatever they pay — so nothing is billed or blocked until a store passes{" "}
                  {data.plans[OPEN_MODE_PLAN].name}&apos;s own limits. Flip the switch when the tiers below are final.
                </s-banner>
              ) : null}

              <s-divider />

              {/* Annual billing is a BILLING-MODEL switch, not a discount one:
                  Shopify rejects usage lines on annual subscriptions, so a
                  yearly subscriber can never be charged for extra conversations
                  and simply hard-caps — with no upgrade left to sell on the top
                  tier. Switching this off makes every paying shop monthly,
                  which is the only interval where overage works end to end. */}
              <s-switch
                label="Offer annual billing"
                details="Off: the Monthly/Yearly toggle disappears from Plan & Usage and the server refuses a yearly subscribe. Existing annual subscriptions keep running untouched — this only decides what is offered from here on. Note that a yearly subscriber can never be billed for extra conversations (Shopify allows usage charges on monthly cycles only), so they stop at their quota instead."
                checked={data.yearlyBilling}
                onInput={(e) =>
                  fetcher.submit(
                    { intent: "yearly-billing", enabled: String(e.currentTarget.checked) },
                    { method: "post" },
                  )
                }
              />
              {data.yearlyBilling ? null : (
                <s-banner tone="info">
                  Annual billing is withdrawn: new subscriptions are monthly only, so every paid store
                  can be billed for conversations past its allowance. Shops already on an annual plan
                  are unaffected and still see their own interval.
                </s-banner>
              )}
            </s-stack>
          </AdminCard>

          <AdminCard heading="Plan matrix">
            <s-stack gap="base">
              <TabPills
                tabs={PLAN_IDS.map((id) => ({
                  id,
                  label: data.plans[id].name + (drafts[id].hidden ? " · hidden" : ""),
                }))}
                active={tier}
                onChange={(id) => setTier(id)}
              />

              {/* First thing in the tier, because it decides whether anything
                  below it is ever seen. Saved with the rest of the tier — a
                  visibility change is a plan edit, not a separate action. Same
                  switch as Enforcement above (user, 2026-09-03). */}
              <s-switch
                label={`Show ${data.plans[tier].name} to merchants`}
                details={
                  draft.hidden
                    ? "Hidden: it is not offered on Plan & Usage and no upgrade prompt names it. A store already on it keeps every quota, keeps being billed, and still sees it as its current plan — hiding withdraws the offer, it never downgrades anyone."
                    : "Listed on Plan & Usage and available in upgrade prompts."
                }
                checked={!draft.hidden}
                onInput={(e) => patchDraft({ hidden: !e.currentTarget.checked })}
              />
              {draft.hidden !== data.plans[tier].hidden ? (
                <s-banner tone="info">Save the plan to apply the visibility change.</s-banner>
              ) : null}

              <s-divider />

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
                {/* PAID TIERS ONLY. Free has no Shopify subscription, so it has
                    no usage line to charge against — a rate here would be
                    unbillable and would only mislead the plan card, which is
                    exactly what happened on 2026-09-03. applyConfig() drops a
                    stored rate for `free` as well, so this is belt and braces. */}
                {tier === "free" ? null : (
                  <s-text-field
                    label="Overage $ / conversation"
                    placeholder="blank = AI stops at cap"
                    details="Monthly subscriptions only — Shopify rejects usage charges on yearly ones, so a yearly subscriber hard-caps at the quota whatever this says."
                    value={draft.overage}
                    onInput={(e) => patchDraft({ overage: e.currentTarget.value })}
                  />
                )}
              </s-stack>
              <s-text color="subdued">
                Price changes apply to new subscriptions only — existing Shopify subscriptions keep their agreed charge.
                {tier === "free"
                  ? " Free can't bill overage at all (no subscription, no usage line), so it has no rate — it stops the AI at the cap."
                  : " A rate change applies to conversations recorded from then on."}
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
                {QUOTA_DIMENSIONS.map((dim) =>
                  // Analytics history is the one quota the merchant does not
                  // spend down — it maps onto the four ranges the range picker
                  // offers. A free number box let an operator set 45, which
                  // clampRange rounds back to 30: the extra 15 days bought the
                  // merchant nothing and nothing said so. Offer the same four
                  // choices the app actually renders.
                  dim === "analytics_range_days" ? (
                    <s-select
                      key={dim}
                      label={QUOTA_LABELS[dim]}
                      value={String(draft.quotas[dim])}
                      onInput={(e) =>
                        patchDraft({ quotas: { ...draft.quotas, [dim]: e.currentTarget.value } })
                      }
                    >
                      {ANALYTICS_RANGES.map((range) => (
                        <s-option key={range} value={String(ANALYTICS_RANGE_DAYS[range])}>
                          {ANALYTICS_RANGE_LABELS[range]}
                        </s-option>
                      ))}
                    </s-select>
                  ) : (
                    <s-number-field
                      key={dim}
                      label={QUOTA_LABELS[dim]}
                      min={0}
                      value={draft.quotas[dim]}
                      onInput={(e) => patchDraft({ quotas: { ...draft.quotas, [dim]: e.currentTarget.value } })}
                    />
                  ),
                )}
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
                    onInput={(e) =>
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
          </AdminCard>
        </s-stack>
      </AdminPage>
    </AdminShell>
  );
}
