import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { PlatformShell } from "../components/platform/PlatformShell";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { SPACE } from "../components/ui/tokens";
import { requirePlatformAdmin } from "../lib/platform/platform-auth.server";
import { getEffectiveAiConfig } from "../lib/platform/platform-settings.server";
import { planEnforcementMode, PLANS } from "../lib/billing/plans.server";
import { PLAN_IDS } from "../lib/billing/plan-shared";

// Platform overview (spec 19). Cross-tenant aggregates BY DESIGN — this is the
// operator surface; no shopId ever comes from user input.

// Tier colours: the first four slots of the validated categorical palette
// (dataviz skill). A single-hue ramp was tried first and REJECTED — four light
// steps of one hue can't clear the adjacent normal-vision ΔE≥15 gate (best
// candidate scored 13.3), and the user asked for lighter bars. These four pass
// every hard check (worst adjacent ΔE 22.9 normal / 9.1 CVD); the labelled
// legend with counts supplies the contrast relief the validator asks for.
const TIER_COLORS: Record<string, string> = {
  free: "#2a78d6", // blue
  basic: "#eb6834", // orange
  pro: "#1baf7a", // aqua
  plus: "#eda100", // yellow
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePlatformAdmin(request);

  // "Installed" = currently installed (uninstalledAt null); uninstalled shops
  // are counted separately so the tile and tier meter agree.
  const [totalShops, uninstalledShops, byPlan, recentShops, ai] = await Promise.all([
    db.shop.count({ where: { uninstalledAt: null } }),
    db.shop.count({ where: { uninstalledAt: { not: null } } }),
    db.shop.groupBy({ by: ["plan", "planStatus"], where: { uninstalledAt: null }, _count: { _all: true } }),
    db.shop.findMany({
      orderBy: { installedAt: "desc" },
      take: 10,
      select: { domain: true, name: true, plan: true, planStatus: true, installedAt: true, uninstalledAt: true },
    }),
    getEffectiveAiConfig(),
  ]);

  const planCounts: Record<string, number> = {};
  for (const row of byPlan) {
    planCounts[row.plan] = (planCounts[row.plan] ?? 0) + row._count._all;
  }

  return {
    adminEmail: session.admin.email,
    totalShops,
    uninstalledShops,
    tiers: PLAN_IDS.map((id) => ({ id, name: PLANS[id].name, count: planCounts[id] ?? 0 })),
    recentShops: recentShops.map((s) => ({
      ...s,
      installedAt: s.installedAt.toISOString().slice(0, 10),
      uninstalled: Boolean(s.uninstalledAt),
    })),
    effectiveChatModel: ai.effectiveChatModel,
    chatModelOverridden: Boolean(ai.overrides.chatModel),
    enforcement: planEnforcementMode(),
  };
};

export default function PlatformOverview() {
  const data = useLoaderData<typeof loader>();
  const distributed = data.tiers.filter((t) => t.count > 0);

  return (
    <PlatformShell adminEmail={data.adminEmail}>
      <s-page heading="Overview">
        <s-stack gap="base">
          <s-text color="subdued">
            Global state of ChatConvert across every installed store. Settings changed in this console apply to all
            merchants.
          </s-text>

          <StatGrid>
            <StatTile
              label="Installed stores"
              value={String(data.totalShops)}
              icon="store"
              tone="accent"
              sub={`${data.uninstalledShops} uninstalled`}
            />
            <StatTile
              label="Chat model"
              value={data.effectiveChatModel}
              icon="wand"
              tone="success"
              sub={data.chatModelOverridden ? "Dashboard override" : "Environment default"}
            />
            <StatTile
              label="Plan enforcement"
              value={data.enforcement === "enforced" ? "Enforced" : "Open"}
              icon="lock"
              tone={data.enforcement === "enforced" ? "success" : "warning"}
              sub={data.enforcement === "enforced" ? "Gates active" : "Everything free on every plan"}
            />
          </StatGrid>

          <s-section heading="Stores by plan">
            <s-stack gap="base">
              <s-text color="subdued">Distribution of installed stores across the four tiers.</s-text>
              <div
                className="ccpf-meter"
                role="img"
                aria-label={data.tiers.map((t) => `${t.name}: ${t.count}`).join(", ")}
              >
                {distributed.map((tier) => (
                  <div
                    key={tier.id}
                    className="ccpf-meterSeg"
                    style={{ flexGrow: tier.count, backgroundColor: TIER_COLORS[tier.id] }}
                    title={`${tier.name}: ${tier.count}`}
                  />
                ))}
              </div>
              <div className="ccpf-legend">
                {data.tiers.map((tier) => (
                  <div key={tier.id} className="ccpf-legendItem">
                    <span
                      className="ccpf-legendDot"
                      style={{ backgroundColor: TIER_COLORS[tier.id] }}
                      aria-hidden="true"
                    />
                    {tier.name}
                    <span className="ccpf-legendCount">{tier.count}</span>
                  </div>
                ))}
              </div>
            </s-stack>
          </s-section>

          <s-section heading="Recent installs">
            {data.recentShops.length === 0 ? (
              <s-text color="subdued">No stores yet.</s-text>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Store</s-table-header>
                  <s-table-header>Plan</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Installed</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.recentShops.map((shop) => (
                    <s-table-row key={shop.domain}>
                      <s-table-cell>
                        <s-stack gap="small-300">
                          <s-text type="strong">{shop.name || shop.domain}</s-text>
                          <s-text color="subdued">{shop.domain}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge>{shop.plan}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {shop.uninstalled ? (
                          <s-badge tone="critical">Uninstalled</s-badge>
                        ) : (
                          <s-badge tone={shop.planStatus === "active" ? "success" : "neutral"}>
                            {shop.planStatus}
                          </s-badge>
                        )}
                      </s-table-cell>
                      <s-table-cell>{shop.installedAt}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-section>

          <s-section heading="Jump to">
            <div style={{ display: "flex", gap: SPACE.sm, flexWrap: "wrap" }}>
              <Link to="/platform/usage">Token usage &amp; cost</Link>
              <Link to="/platform/ai">AI model settings</Link>
              <Link to="/platform/plans">Plans &amp; enforcement</Link>
              <Link to="/platform/settings">Settings</Link>
            </div>
          </s-section>
        </s-stack>
      </s-page>
    </PlatformShell>
  );
}
