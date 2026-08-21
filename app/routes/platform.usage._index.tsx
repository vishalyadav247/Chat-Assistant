import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { PlatformShell } from "../components/platform/PlatformShell";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { TabPills } from "../components/ui/TabPills";
import { EmptyState } from "../components/ui/EmptyState";
import { requirePlatformAdmin } from "../lib/platform/platform-auth.server";
import { normalizeRange, usageOverview } from "../lib/platform/usage-report.server";
import { PURPOSE_LABELS, RANGE_DAYS } from "../lib/platform/usage-shared";
import { formatTokens, formatUsd, PRICING_VERIFIED_AT } from "../lib/platform/llm-pricing";

// Platform → Usage (spec 19). Token consumption + estimated cost per merchant.
// Cross-tenant aggregate BY DESIGN; guarded by requirePlatformAdmin.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePlatformAdmin(request);
  const days = normalizeRange(new URL(request.url).searchParams.get("days"));
  const overview = await usageOverview(days);
  return { adminEmail: session.admin.email, ...overview };
};

export default function PlatformUsage() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const active = data.shops.filter((s) => s.totals.calls > 0);

  const setDays = (days: string) => {
    const next = new URLSearchParams(params);
    next.set("days", days);
    setParams(next, { preventScrollReset: true });
  };

  return (
    <PlatformShell adminEmail={data.adminEmail}>
      <s-page heading="Usage">
        <s-stack gap="base">
          <s-text color="subdued">
            Token consumption and estimated OpenAI cost per merchant. Counts come straight from the API — every chat,
            summary, moderation and embedding call is attributed to the store that triggered it.
          </s-text>

          <TabPills
            tabs={RANGE_DAYS.map((d) => ({ id: String(d), label: `${d} days` }))}
            active={String(data.days)}
            onChange={setDays}
          />

          <StatGrid>
            <StatTile
              label="Tokens used"
              value={formatTokens(data.grand.tokens)}
              icon="chart-line"
              tone="accent"
              sub={`${data.grand.calls.toLocaleString("en-US")} API calls`}
            />
            <StatTile
              label="Estimated cost"
              value={formatUsd(data.grand.costUsd)}
              icon="credit-card"
              tone="success"
              sub={`since ${data.fromDate}`}
            />
            <StatTile
              label="Stores with activity"
              value={String(data.shopsWithUsage)}
              icon="store"
              tone="info"
              sub={`of ${data.shops.length} installed`}
            />
          </StatGrid>

          {data.grand.unpricedModels.length > 0 ? (
            <s-banner tone="warning">
              No price on file for {data.grand.unpricedModels.join(", ")} — those tokens are counted but excluded from
              cost. Add the model to <code>app/lib/platform/llm-pricing.ts</code>.
            </s-banner>
          ) : null}

          <s-section heading="By merchant">
            {active.length === 0 ? (
              <EmptyState
                icon="chart-line"
                title="No AI usage recorded yet"
                description="Tracking starts from the first chat, sync, or ingestion after this feature was deployed."
              />
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Store</s-table-header>
                  <s-table-header>Plan</s-table-header>
                  <s-table-header>Conversations</s-table-header>
                  <s-table-header>Tokens</s-table-header>
                  <s-table-header>Est. cost</s-table-header>
                  <s-table-header>Cost / conv.</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {active.map((shop) => (
                    <s-table-row key={shop.shopId}>
                      <s-table-cell>
                        <s-stack gap="small-300">
                          <Link to={`/platform/usage/${shop.shopId}?days=${data.days}`}>
                            {shop.name || shop.domain}
                          </Link>
                          <s-text color="subdued">{shop.domain}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge>{shop.plan}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <span className="ccpf-num">{shop.conversations.toLocaleString("en-US")}</span>
                      </s-table-cell>
                      <s-table-cell>
                        <span className="ccpf-num">{formatTokens(shop.totals.tokens)}</span>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text type="strong">{formatUsd(shop.totals.costUsd)}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <span className="ccpf-num">
                          {shop.costPerConversation === null ? "—" : formatUsd(shop.costPerConversation)}
                        </span>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-section>

          <s-section heading="Where the tokens go">
            {data.byPurpose.length === 0 ? (
              <s-text color="subdued">Nothing recorded yet.</s-text>
            ) : (
              <s-stack gap="base">
                {data.byPurpose.map((row) => {
                  const share = data.grand.tokens > 0 ? (row.tokens / data.grand.tokens) * 100 : 0;
                  return (
                    <div key={row.purpose} className="ccpf-breakRow">
                      <div>{PURPOSE_LABELS[row.purpose] ?? row.purpose}</div>
                      <div className="ccpf-breakBar" aria-hidden="true">
                        <div className="ccpf-breakFill" style={{ width: `${Math.max(share, 0.5)}%` }} />
                      </div>
                      <div className="ccpf-breakValue">
                        {formatTokens(row.tokens)}
                        <span className="ccpf-breakCost">{formatUsd(row.costUsd)}</span>
                      </div>
                    </div>
                  );
                })}
                <s-text color="subdued">
                  Costs are estimated from OpenAI list prices verified {PRICING_VERIFIED_AT}; cached input tokens are
                  billed at their discounted rate.
                </s-text>
              </s-stack>
            )}
          </s-section>
        </s-stack>
      </s-page>
    </PlatformShell>
  );
}
