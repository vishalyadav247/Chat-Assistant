import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { PlatformShell } from "../components/platform/PlatformShell";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { TabPills } from "../components/ui/TabPills";
import { EmptyState } from "../components/ui/EmptyState";
import { requirePlatformAdmin } from "../lib/platform/platform-auth.server";
import {
  logsOverview,
  normalizeHours,
  normalizeLevel,
  resolveShopFilterStrict,
} from "../lib/platform/logs-report.server";
import {
  LEVEL_LABELS,
  LOG_RANGE_HOURS,
  RANGE_LABELS,
  ROW_LIMIT,
} from "../lib/platform/logs-shared";

// Platform → Logs (spec 21). Every merchant's errors and warnings in one
// window. Cross-tenant aggregate BY DESIGN; guarded by requirePlatformAdmin.
// Operator-only — no merchant surface reads app_logs.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePlatformAdmin(request);
  const params = new URL(request.url).searchParams;
  const event = params.get("event")?.trim() || null;
  // Validated against the shop table — never trust the query string. An id
  // that no longer resolves is reported, not silently dropped.
  const shop = await resolveShopFilterStrict(params.get("shop"));
  const overview = await logsOverview({
    hours: normalizeHours(params.get("hours")),
    level: normalizeLevel(params.get("level")),
    event,
    shopId: shop.shopId,
    unknownShop: shop.unknownShop,
  });
  return { adminEmail: session.admin.email, ...overview };
};

/** Operator console runs on UTC, matching the rest of /platform. */
function stamp(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
}

export default function PlatformLogs() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { preventScrollReset: true });
  };

  const rangeLabel = RANGE_LABELS[data.filters.hours] ?? `${data.filters.hours} hours`;
  const filtered = Boolean(data.filters.level || data.filters.event || data.filters.shopId);

  return (
    <PlatformShell adminEmail={data.adminEmail}>
      <s-page heading="Logs">
        <s-stack gap="base">
          <s-text color="subdued">
            Errors and warnings from every merchant, newest first. Filter to a store when someone reports a problem.
            Rows are kept for 14 days — this is a diagnostic trail, not an audit log, and it never stores message
            bodies or contact details.
          </s-text>

          <TabPills
            tabs={LOG_RANGE_HOURS.map((h) => ({ id: String(h), label: RANGE_LABELS[h] }))}
            active={String(data.filters.hours)}
            onChange={(id) => setParam("hours", id)}
          />

          <StatGrid>
            <StatTile
              label="Errors"
              value={data.errors.toLocaleString("en-US")}
              icon="alert-triangle"
              tone="critical"
              sub={`in the last ${rangeLabel}`}
            />
            <StatTile
              label="Warnings"
              value={data.warnings.toLocaleString("en-US")}
              icon="info"
              tone="warning"
              sub={`in the last ${rangeLabel}`}
            />
            <StatTile
              label="Stores affected"
              value={data.shopsAffected.toLocaleString("en-US")}
              icon="store"
              tone="info"
              sub="excludes system-wide failures"
            />
          </StatGrid>

          {data.filters.unknownShop ? (
            <s-banner tone="warning">
              The store in this link no longer exists (it was uninstalled and purged), so the store filter was
              dropped — you are looking at <s-text type="strong">every store</s-text>.
            </s-banner>
          ) : null}

          {data.truncatedAggregate ? (
            <s-banner tone="warning">
              More than 5,000 entries in this window — the totals and top-events table cover the most recent 5,000
              only. That volume means something is looping; start with the top event below.
            </s-banner>
          ) : null}

          <s-section heading="Top failing events">
            {data.topEvents.length === 0 ? (
              <EmptyState
                icon="check-circle"
                title="Nothing logged in this window"
                description="No errors or warnings were recorded. Widen the range if you are looking for something older."
              />
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Event</s-table-header>
                  <s-table-header>Level</s-table-header>
                  <s-table-header>Count</s-table-header>
                  <s-table-header>Stores</s-table-header>
                  <s-table-header>Last seen</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.topEvents.map((row) => (
                    <s-table-row key={row.event}>
                      <s-table-cell>
                        <button
                          type="button"
                          className="ccpf-logLink"
                          onClick={() => setParam("event", row.event)}
                        >
                          {row.event}
                        </button>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={row.level === "error" ? "critical" : "warning"}>
                          {LEVEL_LABELS[row.level] ?? row.level}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <span className="ccpf-num">{row.count.toLocaleString("en-US")}</span>
                      </s-table-cell>
                      <s-table-cell>
                        <span className="ccpf-num">{row.shops || "—"}</span>
                      </s-table-cell>
                      <s-table-cell>
                        <span className="ccpf-mono">{stamp(row.lastSeen)}</span>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-section>

          <s-section heading="Entries">
            <s-stack gap="base">
              <div className="ccpf-logFilters">
                <s-select
                  label="Level"
                  value={data.filters.level ?? ""}
                  onChange={(e) => setParam("level", e.currentTarget.value)}
                >
                  <s-option value="">All levels</s-option>
                  <s-option value="error">Errors</s-option>
                  <s-option value="warn">Warnings</s-option>
                </s-select>
                <s-select
                  label="Event"
                  value={data.filters.event ?? ""}
                  onChange={(e) => setParam("event", e.currentTarget.value)}
                >
                  <s-option value="">All events</s-option>
                  {data.eventOptions.map((event) => (
                    <s-option key={event} value={event}>
                      {event}
                    </s-option>
                  ))}
                </s-select>
                <s-select
                  label="Store"
                  value={data.filters.shopId ?? ""}
                  onChange={(e) => setParam("shop", e.currentTarget.value)}
                >
                  <s-option value="">All stores</s-option>
                  {data.shopOptions.map((shop) => (
                    <s-option key={shop.id} value={shop.id}>
                      {shop.label}
                    </s-option>
                  ))}
                </s-select>
              </div>

              {data.truncatedRows ? (
                <s-text color="subdued">
                  Showing the newest {ROW_LIMIT} of more than {ROW_LIMIT} matching entries — narrow the filters to see
                  the rest.
                </s-text>
              ) : null}

              {data.rows.length === 0 ? (
                <EmptyState
                  icon="check-circle"
                  title={filtered ? "No entries match these filters" : "Nothing logged in this window"}
                  description={
                    filtered
                      ? "Clear a filter or widen the range."
                      : "No errors or warnings were recorded for any store."
                  }
                />
              ) : (
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Time (UTC)</s-table-header>
                    <s-table-header>Level</s-table-header>
                    <s-table-header>Event</s-table-header>
                    <s-table-header>Store</s-table-header>
                    <s-table-header>Detail</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {data.rows.map((row) => (
                      <s-table-row key={row.id}>
                        <s-table-cell>
                          <span className="ccpf-mono">{stamp(row.occurredAt)}</span>
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge tone={row.level === "error" ? "critical" : "warning"}>
                            {LEVEL_LABELS[row.level] ?? row.level}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>
                          <span className="ccpf-mono">{row.event}</span>
                        </s-table-cell>
                        <s-table-cell>
                          {row.shopLabel ?? <s-text color="subdued">System</s-text>}
                        </s-table-cell>
                        <s-table-cell>
                          <div className="ccpf-logDetail">
                            <span>{row.message}</span>
                            {row.context ? (
                              <details className="ccpf-logCtx">
                                <summary>Context</summary>
                                <pre>{row.context}</pre>
                              </details>
                            ) : null}
                          </div>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}
            </s-stack>
          </s-section>
        </s-stack>
      </s-page>
    </PlatformShell>
  );
}
