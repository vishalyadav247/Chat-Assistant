import { useState } from "react";
import type { CampaignRow } from "../lib/campaigns/campaigns.server";
import { campaignTemplate } from "../lib/campaigns/templates";
import { DataTable } from "./DataTable";
import { useDateTime } from "../lib/format/context";

// Campaign table (spec 12 dashboard): sub-tabs All/Active/Inactive, columns
// Priority (reorder buttons persisting ints) | Name | Type | View | CTR (value
// + inline bar) | ATCs | Revenue | Status toggle | Updated | kebab. "–" for
// zero metrics per the design.

export function campaignCtr(views: number, clicks: number): number {
  return views > 0 ? (clicks / views) * 100 : 0;
}

function MetricCell(props: { value: number; format?: (v: number) => string }) {
  if (props.value <= 0) return <s-text tone="neutral">–</s-text>;
  return <s-text>{props.format ? props.format(props.value) : String(props.value)}</s-text>;
}

export function ProactiveCampaignTable(props: {
  rows: CampaignRow[];
  currency: string;
  busy: boolean;
  onEdit: (row: CampaignRow) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
  onReorder: (id: string, direction: "up" | "down") => void;
}) {
  const dt = useDateTime();
  const [tab, setTab] = useState<"all" | "active" | "inactive">("all");
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const filtered =
    tab === "all" ? props.rows : props.rows.filter((r) => (r.status === "active") === (tab === "active"));

  const formatMoney = (value: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: props.currency }).format(value);

  const tabs: { id: "all" | "active" | "inactive"; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "inactive", label: "Inactive" },
  ];

  return (
    <s-stack gap="base">
      <div style={{ display: "flex", gap: 4 }}>
        {tabs.map((t) => (
          <s-button
            key={t.id}
            variant={tab === t.id ? "secondary" : "tertiary"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </s-button>
        ))}
      </div>

      <DataTable
        rows={filtered}
        searchPlaceholder="Search campaigns"
        searchFn={(row, q) => row.name.toLowerCase().includes(q)}
        emptyMessage={
          props.rows.length === 0
            ? "No campaigns yet — create your first proactive chat."
            : "No campaigns match."
        }
        perPage={10}
        columns={[
          {
            key: "priority",
            title: "Priority",
            render: (row) => {
              const index = props.rows.findIndex((r) => r.id === row.id);
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontWeight: 700, minWidth: 16 }}>{row.priority}</span>
                  <span style={{ display: "inline-flex", flexDirection: "column" }}>
                    <s-button
                      variant="tertiary"
                      icon="caret-up"
                      accessibilityLabel={`Move ${row.name} up`}
                      disabled={props.busy || index <= 0}
                      onClick={() => props.onReorder(row.id, "up")}
                    />
                    <s-button
                      icon="caret-down"
                      variant="tertiary"
                      accessibilityLabel={`Move ${row.name} down`}
                      disabled={props.busy || index >= props.rows.length - 1}
                      onClick={() => props.onReorder(row.id, "down")}
                    />
                  </span>
                </span>
              );
            },
          },
          {
            key: "name",
            title: "Name",
            render: (row) => <span style={{ fontWeight: 600 }}>{row.name}</span>,
          },
          {
            key: "type",
            title: "Type",
            render: (row) => {
              const tpl = campaignTemplate(row.templateType);
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 7,
                      background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                    }}
                  >
                    {tpl?.emoji ?? "💬"}
                  </span>
                  <s-text tone="neutral">{tpl?.name ?? row.templateType}</s-text>
                </span>
              );
            },
          },
          {
            key: "views",
            title: "View",
            render: (row) => <MetricCell value={row.views} />,
          },
          {
            key: "ctr",
            title: "CTR",
            render: (row) => {
              const ctr = campaignCtr(row.views, row.clicks);
              if (row.views <= 0) return <s-text tone="neutral">–</s-text>;
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", gap: 3, minWidth: 64 }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{ctr.toFixed(2)}%</span>
                  <span
                    aria-hidden="true"
                    style={{
                      height: 4,
                      borderRadius: 4,
                      background: "var(--s-color-bg-fill-secondary, #ececf0)",
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        height: "100%",
                        width: `${Math.min(ctr, 100)}%`,
                        borderRadius: 4,
                        background: "linear-gradient(90deg,#7c3aed,#3b82f6)",
                      }}
                    />
                  </span>
                </span>
              );
            },
          },
          {
            key: "atcs",
            title: "ATCs",
            render: (row) => <MetricCell value={row.atcs} />,
          },
          {
            key: "revenue",
            title: "Revenue",
            render: (row) => <MetricCell value={row.revenue} format={formatMoney} />,
          },
          {
            key: "status",
            title: "Status",
            render: (row) => (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <s-switch
                  label={`${row.name} active`}
                  labelAccessibilityVisibility="exclusive"
                  checked={row.status === "active"}
                  disabled={props.busy}
                  onChange={() => props.onToggle(row.id, row.status !== "active")}
                />
                <s-badge tone={row.status === "active" ? "success" : "neutral"}>
                  {row.status === "active" ? "Active" : "Inactive"}
                </s-badge>
              </span>
            ),
          },
          {
            key: "updated",
            title: "Updated at",
            render: (row) => (
              <s-text tone="neutral">
                {dt.dateTime(row.updatedAt)}
              </s-text>
            ),
          },
          {
            key: "actions",
            title: "",
            align: "end",
            render: (row) => (
              <span style={{ position: "relative", display: "inline-block" }}>
                <s-button
                  variant="tertiary"
                  accessibilityLabel={`Actions for ${row.name}`}
                  onClick={() => setMenuFor((cur) => (cur === row.id ? null : row.id))}
                >
                  ⋯
                </s-button>
                {menuFor === row.id ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "100%",
                      zIndex: 30,
                      background: "var(--s-color-bg, #fff)",
                      border: "1px solid var(--s-color-border, #e3e3e3)",
                      borderRadius: 10,
                      boxShadow: "0 6px 20px rgba(20,20,25,.12)",
                      display: "flex",
                      flexDirection: "column",
                      minWidth: 130,
                      padding: 4,
                    }}
                  >
                    <s-button
                      variant="tertiary"
                      onClick={() => {
                        setMenuFor(null);
                        props.onEdit(row);
                      }}
                    >
                      Edit
                    </s-button>
                    <s-button
                      variant="tertiary"
                      disabled={props.busy}
                      onClick={() => {
                        setMenuFor(null);
                        props.onDuplicate(row.id);
                      }}
                    >
                      Duplicate
                    </s-button>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      disabled={props.busy}
                      onClick={() => {
                        setMenuFor(null);
                        props.onDelete(row.id);
                      }}
                    >
                      Delete
                    </s-button>
                  </div>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </s-stack>
  );
}
