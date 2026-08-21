import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { PlatformShell } from "../components/platform/PlatformShell";
import { PageHeader } from "../components/ui/PageHeader";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { TabPills } from "../components/ui/TabPills";
import { requirePlatformAdmin } from "../lib/platform/platform-auth.server";
import { normalizeRange, usageForShop } from "../lib/platform/usage-report.server";
import { PURPOSE_LABELS, RANGE_DAYS } from "../lib/platform/usage-shared";
import { formatTokens, formatUsd, PRICING_VERIFIED_AT } from "../lib/platform/llm-pricing";

// Platform → Usage → one merchant (spec 19). The shopId comes from the URL and
// is validated against the shop table (usageForShop returns null → 404); this
// is a READ-only operator view, never a shop-scoped mutation.

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const session = await requirePlatformAdmin(request);
  const days = normalizeRange(new URL(request.url).searchParams.get("days"));
  const detail = await usageForShop(String(params.shopId ?? ""), days);
  if (!detail) throw new Response("Store not found", { status: 404 });
  return { adminEmail: session.admin.email, ...detail };
};

export default function PlatformShopUsage() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const peak = Math.max(...data.daily.map((d) => d.costUsd), 0);

  const setDays = (days: string) => {
    const next = new URLSearchParams(params);
    next.set("days", days);
    setParams(next, { preventScrollReset: true });
  };

  return (
    <PlatformShell adminEmail={data.adminEmail}>
      <s-page heading={data.shop.name || data.shop.domain}>
        <s-stack gap="base">
          <PageHeader
            description={`${data.shop.domain} · ${data.shop.plan} plan${data.shop.uninstalled ? " · uninstalled" : ""}`}
            backLabel="All merchants"
            onBack={() => navigate(`/platform/usage?days=${data.days}`)}
            toolbar={
              <TabPills
                tabs={RANGE_DAYS.map((d) => ({ id: String(d), label: `${d} days` }))}
                active={String(data.days)}
                onChange={setDays}
                size="small"
              />
            }
          />

          <StatGrid>
            <StatTile
              label="Estimated cost"
              value={formatUsd(data.totals.costUsd)}
              icon="credit-card"
              tone="accent"
              sub={`since ${data.fromDate}`}
            />
            <StatTile
              label="Tokens"
              value={formatTokens(data.totals.tokens)}
              icon="chart-line"
              tone="info"
              sub={`${data.totals.calls.toLocaleString("en-US")} API calls`}
            />
            <StatTile
              label="Cost per conversation"
              value={data.costPerConversation === null ? "—" : formatUsd(data.costPerConversation)}
              icon="chat"
              tone="success"
              sub={`${data.conversations.toLocaleString("en-US")} conversations`}
            />
          </StatGrid>

          <s-section heading="Daily cost">
            {peak === 0 ? (
              <s-text color="subdued">No usage recorded in this range.</s-text>
            ) : (
              <s-stack gap="base">
                <div className="ccpf-chart">
                  {data.daily.map((day) => (
                    <div
                      key={day.date}
                      className="ccpf-chartCol"
                      title={`${day.date} · ${formatUsd(day.costUsd)} · ${formatTokens(day.tokens)} tokens`}
                    >
                      <div
                        className="ccpf-chartBar"
                        style={{ height: `${day.costUsd === 0 ? 0 : Math.max((day.costUsd / peak) * 100, 2)}%` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="ccpf-chartAxis">
                  <span>{data.daily[0]?.date}</span>
                  <span>peak {formatUsd(peak)}/day</span>
                  <span>{data.daily[data.daily.length - 1]?.date}</span>
                </div>
              </s-stack>
            )}
          </s-section>

          <s-section heading="By purpose">
            <s-table>
              <s-table-header-row>
                <s-table-header>Purpose</s-table-header>
                <s-table-header>Tokens</s-table-header>
                <s-table-header>Cost</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.byPurpose.map((row) => (
                  <s-table-row key={row.purpose}>
                    <s-table-cell>{PURPOSE_LABELS[row.purpose] ?? row.purpose}</s-table-cell>
                    <s-table-cell>
                      <span className="ccpf-num">{formatTokens(row.tokens)}</span>
                    </s-table-cell>
                    <s-table-cell>
                      <span className="ccpf-num">{formatUsd(row.costUsd)}</span>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {data.byPurpose.length === 0 ? <s-text color="subdued">Nothing recorded yet.</s-text> : null}
          </s-section>

          <s-section heading="By model">
            <s-table>
              <s-table-header-row>
                <s-table-header>Model</s-table-header>
                <s-table-header>Calls</s-table-header>
                <s-table-header>Cost</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.byModel.map((row) => (
                  <s-table-row key={row.model}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-300">
                        <span className="ccpf-mono">{row.model}</span>
                        {row.priced ? null : <s-badge tone="warning">unpriced</s-badge>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <span className="ccpf-num">{row.calls.toLocaleString("en-US")}</span>
                    </s-table-cell>
                    <s-table-cell>
                      <span className="ccpf-num">{formatUsd(row.costUsd)}</span>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {data.byModel.length === 0 ? <s-text color="subdued">Nothing recorded yet.</s-text> : null}
          </s-section>

          <s-text color="subdued">
            Costs are estimated from OpenAI list prices verified {PRICING_VERIFIED_AT}. Cached input tokens (
            {formatTokens(data.totals.cachedTokens)} in this range) are billed at their discounted rate.
          </s-text>
        </s-stack>
      </s-page>
    </PlatformShell>
  );
}
