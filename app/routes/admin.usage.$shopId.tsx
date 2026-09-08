import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { AdminShell } from "../components/admin/AdminShell";
import { AdminCard, AdminPage } from "../components/admin/AdminUi";
import { PageHeader } from "../components/ui/PageHeader";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { TabPills } from "../components/ui/TabPills";
import { requireAdminUser } from "../lib/admin/admin-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import { grantQuota, listGrants, revokeGrant } from "../lib/billing/quota-grants.server";
import { GRANTABLE_DIMENSIONS, type QuotaDimension } from "../lib/billing/plan-shared";
import { normalizeRange, usageForShop } from "../lib/admin/usage-report.server";
import { PURPOSE_LABELS, RANGE_DAYS } from "../lib/admin/usage-shared";
import { formatTokens, formatUsd, PRICING_VERIFIED_AT } from "../lib/admin/llm-pricing";

// Admin → Usage → one merchant (spec 19). The shopId comes from the URL and
// is validated against the shop table (usageForShop returns null → 404); this
// is a READ-only operator view, never a shop-scoped mutation.

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const session = await requireAdminUser(request);
  const days = normalizeRange(new URL(request.url).searchParams.get("days"));
  const shopId = String(params.shopId ?? "");
  const detail = await usageForShop(shopId, days);
  if (!detail) throw new Response("Store not found", { status: 404 });
  return {
    adminEmail: session.admin.email,
    ...detail,
    credits: await listGrants(shopId),
  };
};

/**
 * Grant or withdraw bonus conversations for THIS shop.
 *
 * The only write on an otherwise read-only operator page, and deliberately
 * scoped to the shop in the URL: there is no "grant to everyone" path, which
 * is what made the old global billing switches dangerous.
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const session = await requireAdminUser(request);
  if (!sameOrigin(request)) {
    return { ok: false as const, error: "Request blocked. Reload the page and try again." };
  }
  const shopId = String(params.shopId ?? "");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "grant") {
      const amount = Number(form.get("amount"));
      const days = Number(form.get("expiresInDays"));
      const balance = await grantQuota(shopId, {
        dimension: String(form.get("dimension") ?? "conversations") as QuotaDimension,
        amount,
        reason: String(form.get("reason") ?? ""),
        grantedBy: session.admin.email,
        // Blank / 0 = never expires. A dated grant is spent first (credits.server).
        expiresAt:
          Number.isFinite(days) && days > 0
            ? new Date(Date.now() + days * 24 * 60 * 60 * 1000)
            : null,
      });
      return { ok: true as const, error: null, note: `Granted. This store now has ${balance.toLocaleString("en-US")} bonus conversation${balance === 1 ? "" : "s"}.` };
    }
    if (intent === "revoke") {
      const done = await revokeGrant(shopId, String(form.get("creditId") ?? ""));
      return done
        ? { ok: true as const, error: null, note: "Withdrawn." }
        : { ok: false as const, error: "That grant no longer exists." };
    }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Could not save." };
  }
  return { ok: false as const, error: "Unknown action." };
};

export default function AdminShopUsage() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const peak = Math.max(...data.daily.map((d) => d.costUsd), 0);

  const fetcher = useFetcher<typeof action>();
  const [dimension, setDimension] = useState<QuotaDimension>("conversations");
  const [amount, setAmount] = useState("100");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [reason, setReason] = useState("");
  const granting = fetcher.state !== "idle";
  const note = fetcher.data?.ok ? fetcher.data.note : null;
  const error = fetcher.data?.ok === false ? fetcher.data.error : null;
  // Clear the form once a grant lands, so a double-click cannot repeat it by
  // leaving the same numbers sitting in the fields.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setReason("");
      setExpiresInDays("");
    }
  }, [fetcher.state, fetcher.data]);

  const setDays = (days: string) => {
    const next = new URLSearchParams(params);
    next.set("days", days);
    setParams(next, { preventScrollReset: true });
  };

  return (
    <AdminShell adminEmail={data.adminEmail}>
      <AdminPage heading={data.shop.name || data.shop.domain}>
        <s-stack gap="base">
          {/* Wrapped: PageHeader is Polaris (heading, back button, description) and
              Polaris always renders LIGHT chrome, so on the dark ground it would
              be dark-on-dark. Inside a card it sits on the light sheet. */}
          <AdminCard>
            <PageHeader
              description={`${data.shop.domain} · ${data.shop.plan} plan${data.shop.uninstalled ? " · uninstalled" : ""}`}
              backLabel="All merchants"
              onBack={() => navigate(`/admin/usage?days=${data.days}`)}
              toolbar={
                <TabPills
                  tabs={RANGE_DAYS.map((d) => ({ id: String(d), label: `${d} days` }))}
                  active={String(data.days)}
                  onChange={setDays}
                  size="small"
                />
              }
            />
          </AdminCard>

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

          <AdminCard heading="Bonus conversations">
            <s-stack gap="base">
              <s-text color="subdued">
                Extra conversations for this store only, on top of its plan. Spent automatically
                once the plan allowance runs out and <b>before</b> any overage billing, so a
                granted store is never charged for conversations this was meant to cover. Free
                plans hard-cap at their quota, so this is the only way to keep their AI answering.
              </s-text>
              <s-stack direction="inline" gap="base" alignItems="end">
                <s-select
                  label="Quota"
                  value={dimension}
                  onInput={(e) => setDimension(e.currentTarget.value as QuotaDimension)}
                >
                  {GRANTABLE_DIMENSIONS.map((d) => (
                    <s-option key={d} value={d}>
                      {d.replace(/_/g, " ")}
                    </s-option>
                  ))}
                </s-select>
                <s-number-field
                  label="Amount"
                  min={1}
                  step={1}
                  value={amount}
                  onInput={(e) => setAmount(e.currentTarget.value)}
                />
                <s-number-field
                  label="Expires in (days)"
                  details="Blank = never expires"
                  min={0}
                  step={1}
                  value={expiresInDays}
                  onInput={(e) => setExpiresInDays(e.currentTarget.value)}
                />
                <s-text-field
                  label="Reason"
                  placeholder="Why this was granted"
                  value={reason}
                  onInput={(e) => setReason(e.currentTarget.value)}
                />
                <s-button
                  variant="primary"
                  loading={granting}
                  onClick={() =>
                    fetcher.submit(
                      { intent: "grant", dimension, amount, expiresInDays, reason },
                      { method: "post" },
                    )
                  }
                >
                  Grant
                </s-button>
              </s-stack>
              {note ? <s-banner tone="success">{note}</s-banner> : null}
              {error ? <s-banner tone="critical">{error}</s-banner> : null}

              {data.credits.length === 0 ? (
                <s-text color="subdued">No bonus conversations granted to this store.</s-text>
              ) : (
                <s-stack gap="small-300">
                  {data.credits.map((credit) => (
                    <s-stack key={credit.id} direction="inline" gap="base" alignItems="center">
                      <s-text type="strong">
                          {credit.dimension.replace(/_/g, " ")}:{" "}
                        {credit.remaining.toLocaleString("en-US")} / {credit.amount.toLocaleString("en-US")}
                      </s-text>
                      {credit.expired ? <s-badge tone="warning">expired</s-badge> : null}
                      {credit.remaining === 0 && !credit.expired ? <s-badge>used up</s-badge> : null}
                      <s-text color="subdued">
                        {credit.reason || "no reason given"} · {credit.grantedBy || "unknown"} ·{" "}
                        {new Date(credit.createdAt).toLocaleDateString("en-US")}
                        {credit.expiresAt
                          ? ` · expires ${new Date(credit.expiresAt).toLocaleDateString("en-US")}`
                          : ""}
                      </s-text>
                      {credit.remaining > 0 && !credit.expired ? (
                        <s-button
                          variant="tertiary"
                          onClick={() =>
                            fetcher.submit({ intent: "revoke", creditId: credit.id }, { method: "post" })
                          }
                        >
                          Withdraw
                        </s-button>
                      ) : null}
                    </s-stack>
                  ))}
                </s-stack>
              )}
            </s-stack>
          </AdminCard>

          <AdminCard heading="Daily cost">
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
          </AdminCard>

          <AdminCard heading="By purpose">
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
          </AdminCard>

          <AdminCard heading="By model">
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
          </AdminCard>

          <s-text color="subdued">
            Costs are estimated from OpenAI list prices verified {PRICING_VERIFIED_AT}. Cached input tokens (
            {formatTokens(data.totals.cachedTokens)} in this range) are billed at their discounted rate.
          </s-text>
        </s-stack>
      </AdminPage>
    </AdminShell>
  );
}
