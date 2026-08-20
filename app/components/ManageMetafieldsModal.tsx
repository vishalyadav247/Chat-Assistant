import { useEffect, useMemo, useState } from "react";
import type { MetafieldDefinitionRow } from "../lib/ingestion/metafields.server";
import type { TrainingActionResult } from "../routes/app.ai-agent.training";
import { BrowseModalShell } from "./BrowseProductsModal";
import { SubTabs, useTrainingFetcher } from "./TrainingShared";
import { BRAND } from "./ui/tokens";
import { useDateTime } from "../lib/format/context";

// Manage metafields modal (spec 07 → Products tab, reference
// resources/other/productMetafields.png, 2026-08-19): Product / Variant
// metafield tabs (no Order tab — user decision) with "Sync now" on their right
// (definitions + used-in counts, also refreshed by product sync and
// metafield_definitions/* webhooks), "Last synced …" on the modal heading row,
// plan-cap banner, search + All/Enabled/Disabled filter, table
// Metafield · Used in · Status (switch; unsupported types can't be enabled).
// Structured (defined) metafields only — user decision 2026-08-19; unsupported
// types are HIDDEN from the list (footnote count) — user decision; footer link
// opens a second popup listing supported types. Enabling re-embeds the affected
// products in a background job (server action `metafield-toggle`).

const TYPES_MODAL_ID = "manage-metafields-types-modal";

interface ModalEl extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const modalEl = (id: string) => document.getElementById(id) as ModalEl | null;

/** Mirrors SUPPORTED_BASE_TYPES in lib/ingestion/metafields.server.ts. */
const SUPPORTED_TYPES: { label: string; types: string }[] = [
  { label: "Text", types: "single line text, multi line text, rich text" },
  { label: "Numbers", types: "integer, decimal, rating, money" },
  { label: "Measurements", types: "dimension, volume, weight" },
  { label: "Other", types: "true/false, date, date & time, URL, link, color" },
  { label: "Lists", types: "lists of any type above" },
];

type OwnerTab = "product" | "variant";
type StatusFilter = "all" | "enabled" | "disabled";

export function ManageMetafieldsModal(props: {
  open: boolean;
  onClose: () => void;
  rows: MetafieldDefinitionRow[];
  /** Plan cap on enabled metafields (display value from the plan matrix). */
  quota: number;
  /** SyncState.metafieldSyncAt — last definitions refresh (any path). */
  lastSyncedAt: string | null;
}) {
  const dt = useDateTime();
  // Rows are seeded from the loader and replaced by each action's fresh list
  // so toggles/sync reflect instantly without waiting for revalidation.
  const [rows, setRows] = useState(props.rows);
  useEffect(() => setRows(props.rows), [props.rows]);
  const { submit, pendingIntent, fetcher } = useTrainingFetcher((result: TrainingActionResult) => {
    if (result.ok && result.metafields) setRows(result.metafields);
  });
  const [tab, setTab] = useState<OwnerTab>("product");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [limitDismissed, setLimitDismissed] = useState(false);

  const enabledCount = rows.filter((r) => r.enabled).length;
  const atLimit = props.quota > 0 && enabledCount >= props.quota;
  const pendingId =
    pendingIntent === "metafield-toggle" ? String(fetcher.formData?.get("id") ?? "") : "";

  // Unsupported types (references, files, JSON…) are hidden — user decision
  // 2026-08-19 — and counted in a footnote so nothing goes silently missing.
  const supportedRows = useMemo(() => rows.filter((r) => r.supported), [rows]);
  const hiddenCount = rows.filter((r) => r.ownerType === tab && !r.supported).length;
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return supportedRows.filter(
      (r) =>
        r.ownerType === tab &&
        (status === "all" || (status === "enabled") === r.enabled) &&
        (!needle ||
          r.name.toLowerCase().includes(needle) ||
          `${r.namespace}.${r.key}`.toLowerCase().includes(needle)),
    );
  }, [supportedRows, tab, q, status]);

  return (
    <BrowseModalShell
      open={props.open}
      title="Manage metafields"
      headerMeta={`Last synced: ${props.lastSyncedAt ? dt.dateTime(props.lastSyncedAt) : "N/A"}`}
      fixedHeight
      onClose={props.onClose}
      footer={
        <>
          <span style={{ flex: 1 }}>
            <button
              type="button"
              onClick={() => modalEl(TYPES_MODAL_ID)?.showOverlay()}
              style={{
                background: "none",
                border: 0,
                padding: 0,
                font: "inherit",
                cursor: "pointer",
                color: `var(--s-color-text-link, ${BRAND.accent})`,
              }}
            >
              View types of supported metafields
            </button>
          </span>
          <s-button onClick={props.onClose}>Close</s-button>
        </>
      }
    >
      <s-stack gap="base">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <SubTabs
            tabs={[
              { id: "product", label: "Product metafields" },
              { id: "variant", label: "Product variant metafields" },
            ]}
            active={tab}
            onChange={(next) => {
              setTab(next);
              setQ("");
              setStatus("all");
            }}
          />
          <s-button
            variant="primary"
            icon="refresh"
            loading={pendingIntent === "metafields-sync"}
            onClick={() => submit("metafields-sync")}
          >
            Sync now
            <s-tooltip>
              Refresh the metafield list from Shopify. Auto sync follows Products auto sync and
              Shopify webhooks.
            </s-tooltip>
          </s-button>
        </s-grid>

        {atLimit && !limitDismissed ? (
          <s-banner tone="warning" onDismiss={() => setLimitDismissed(true)}>
            You&apos;ve reached the metafields limit for your plan ({enabledCount} of {props.quota}{" "}
            enabled). Disable one to enable another, or upgrade for more.
          </s-banner>
        ) : null}

        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <input
            type="search"
            value={q}
            placeholder="Search metafield"
            onChange={(e) => setQ(e.currentTarget.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid var(--s-color-border, #d4d4d4)",
              font: "inherit",
              boxSizing: "border-box",
            }}
          />
          <SubTabs
            tabs={[
              { id: "all", label: "All" },
              { id: "enabled", label: "Enabled" },
              { id: "disabled", label: "Disabled" },
            ]}
            active={status}
            onChange={setStatus}
          />
        </s-grid>

        {visible.length === 0 ? (
          <s-box padding="large">
            <s-stack gap="small-200" alignItems="center">
              <s-text color="subdued">
                {supportedRows.some((r) => r.ownerType === tab)
                  ? "No metafields match your search or filter."
                  : `No ${tab} metafield definitions found — define them in Shopify (Settings → Custom data), then Sync now.`}
              </s-text>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Metafield</s-table-header>
              <s-table-header>Used in</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {visible.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-stack gap="small-500">
                      <s-text type="strong">{row.name}</s-text>
                      <s-text color="subdued">
                        {row.namespace}.{row.key} · {typeLabel(row.type)}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text tone="neutral">
                      {row.usedIn} {row.usedIn === 1 ? "product" : "products"}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-switch
                      label={`Learn ${row.name}`}
                      labelAccessibilityVisibility="exclusive"
                      checked={row.enabled}
                      disabled={pendingId === row.id}
                      onChange={(e) =>
                        submit("metafield-toggle", {
                          id: row.id,
                          enabled: e.currentTarget.checked ? "true" : "false",
                        })
                      }
                    />
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        {hiddenCount > 0 ? (
          <s-text color="subdued">
            {hiddenCount} {hiddenCount === 1 ? "metafield isn't" : "metafields aren't"} listed
            because {hiddenCount === 1 ? "its type isn't" : "their types aren't"} supported yet.
          </s-text>
        ) : null}
      </s-stack>

      {/* Second popup: what the AI can learn from (Polaris modal, stacks over the shell). */}
      <s-modal id={TYPES_MODAL_ID} heading="Supported metafield types">
        <s-stack gap="base">
          <s-paragraph>
            The AI learns from metafields whose values can be read as text. These types can be
            enabled:
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header>Group</s-table-header>
              <s-table-header>Types</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {SUPPORTED_TYPES.map((t) => (
                <s-table-row key={t.label}>
                  <s-table-cell>
                    <s-text type="strong">{t.label}</s-text>
                  </s-table-cell>
                  <s-table-cell>{t.types}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-paragraph color="subdued">
            Not supported yet: references (products, variants, collections, files, pages,
            metaobjects) and JSON — their values are IDs or raw data, not text. Only metafields
            with a definition (Shopify Settings → Custom data) are listed.
          </s-paragraph>
        </s-stack>
        <s-button slot="primary-action" onClick={() => modalEl(TYPES_MODAL_ID)?.hideOverlay()}>
          Close
        </s-button>
      </s-modal>
    </BrowseModalShell>
  );
}

/** Human label for a Shopify metafield type name. */
function typeLabel(type: string): string {
  const list = type.startsWith("list.");
  const base = list ? type.slice(5) : type;
  const label = base.replace(/_field$/, "").replace(/_/g, " ").replace(/^number /, "");
  return list ? `list of ${label}` : label;
}
