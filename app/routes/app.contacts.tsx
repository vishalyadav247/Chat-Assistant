import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { resolveShopId } from "../lib/tenancy.server";
import {
  contactDetail,
  contactStats,
  exportContactsCsv,
  listContacts,
  reclassifyPendingContacts,
} from "../lib/contacts/contacts.server";
import { StatGrid, StatTile } from "../components/StatTile";
import { DataTable } from "../components/DataTable";
import {
  CHANNEL_LABELS,
  CONTACTS_PAGE_SIZE,
  ContactAvatar,
  ContactTypeBadge,
  contactDisplayName,
  EmDash,
  type ContactRowData,
  type ContactSort,
  type ContactType,
} from "../components/ContactsShared";
import { ContactDetailPanel } from "../components/ContactDetailPanel";
import { ContactsExportModal, type ExportScope } from "../components/ContactsExportModal";

// Contacts CRM (spec 11, design contacts.html): stat tiles, tabbed + searchable
// contact table with conversation counts, contact detail side panel, CSV export
// modal. Contacts are created by the storefront paths (pre-chat/handover lead
// capture in proxy.prechat.tsx, specs 05/10) — this page reads/classifies only.

const TAB_TYPES = ["customer", "lead", "anonymous"] as const;

function parseType(raw: string | null): ContactType | undefined {
  return (TAB_TYPES as readonly string[]).includes(raw ?? "")
    ? (raw as ContactType)
    : undefined;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const type = parseType(new URL(request.url).searchParams.get("type"));

  // Opportunistic re-classification: contacts whose storefront customer id
  // arrived after row creation get upgraded to "customer" (spec 11 rule; the
  // email→Shopify-customer Admin API match is deferred, see spec delta note).
  await reclassifyPendingContacts(shopId);

  const [stats, contacts] = await Promise.all([
    contactStats(shopId),
    listContacts(shopId, { type }),
  ]);
  return { stats, contacts, tab: type ?? ("all" as const) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "export") {
    const scope: ExportScope = formData.get("scope") === "all" ? "all" : "page";
    const page = Math.max(1, Number(formData.get("page") ?? 1) || 1);
    const q = String(formData.get("q") ?? "");
    const sort: ContactSort = formData.get("sort") === "name" ? "name" : "created";
    const type = parseType(formData.get("type") as string | null);
    const csv = await exportContactsCsv(shopId, { scope, page, q, sort, type });
    const stamp = new Date().toISOString().slice(0, 10);
    return { intent: "export" as const, filename: `contacts-${stamp}.csv`, csv };
  }

  if (intent === "detail") {
    const detail = await contactDetail(shopId, String(formData.get("id") ?? ""));
    return { intent: "detail" as const, detail };
  }

  return { intent: "unknown" as const };
};

const TABS: { id: "all" | ContactType; label: string }[] = [
  { id: "all", label: "All" },
  { id: "customer", label: "Customer" },
  { id: "lead", label: "Lead" },
  { id: "anonymous", label: "Anonymous" },
];

export default function ContactsPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseType(searchParams.get("type")) ?? "all";

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ContactSort>("created");
  const [page, setPage] = useState(1);
  const [exportOpen, setExportOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const exportFetcher = useFetcher<typeof action>();
  const detailFetcher = useFetcher<typeof action>();

  const setTab = (next: (typeof TABS)[number]["id"]) => {
    setPage(1);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "all") params.delete("type");
        else params.set("type", next);
        return params;
      },
      { preventScrollReset: true },
    );
  };

  // Client-side search + sort mirror the server rules (contains-insensitive on
  // name OR email; created-desc vs name-asc nulls-last) so a "Current page"
  // export re-computes the exact visible slice server-side.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? data.contacts.filter(
          (c) =>
            (c.name ?? "").toLowerCase().includes(q) ||
            (c.email ?? "").toLowerCase().includes(q),
        )
      : [...data.contacts];
    if (sort === "name") {
      filtered.sort((a, b) => {
        if (!a.name && !b.name) return 0;
        if (!a.name) return 1;
        if (!b.name) return -1;
        return a.name.localeCompare(b.name);
      });
    }
    return filtered;
  }, [data.contacts, query, sort]);

  // Export round-trip → client-side download. In the embedded admin only
  // App-Bridge-authenticated fetches carry the session token (a document POST
  // can't), so the CSV rides back in the action payload and is saved as a
  // UTF-8 (BOM) Blob here — the attachment-equivalent for iframe apps.
  const processedExport = useRef<unknown>(null);
  useEffect(() => {
    const result = exportFetcher.data;
    if (exportFetcher.state !== "idle" || !result || processedExport.current === result) return;
    processedExport.current = result;
    if (result.intent === "export") {
      // UTF-8 BOM prefix so Excel opens the CSV correctly.
      const blob = new Blob([String.fromCharCode(0xfeff) + result.csv], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportOpen(false);
      shopify.toast.show("Contacts exported");
    }
  }, [exportFetcher.state, exportFetcher.data, shopify]);

  const runExport = (scope: ExportScope) => {
    exportFetcher.submit(
      {
        intent: "export",
        scope,
        page: String(page),
        q: query,
        sort,
        type: tab === "all" ? "" : tab,
      },
      { method: "post" },
    );
  };

  const openDetail = (row: ContactRowData) => {
    setDetailOpen(true);
    detailFetcher.submit({ intent: "detail", id: row.id }, { method: "post" });
  };

  const detail =
    detailFetcher.data?.intent === "detail" ? detailFetcher.data.detail : null;

  return (
    <s-page heading="Contacts">
      <s-button slot="primary-action" variant="primary" onClick={() => setExportOpen(true)}>
        Export
      </s-button>

      <s-stack gap="base">
        <StatGrid>
          <StatTile
            label="Total contacts"
            value={String(data.stats.total)}
            sub="across all channels"
          />
          <StatTile
            label="Customers"
            value={String(data.stats.customers)}
            sub="have placed an order"
          />
          <StatTile label="Leads" value={String(data.stats.leads)} sub="shared contact info" />
          <StatTile
            label="Anonymous"
            value={String(data.stats.anonymous)}
            sub="not yet identified"
          />
        </StatGrid>

        <s-section>
          <s-stack gap="base">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="search"
                value={query}
                placeholder="Search by name or email"
                onChange={(e) => {
                  setQuery(e.currentTarget.value);
                  setPage(1);
                }}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--s-color-border, #d4d4d4)",
                  font: "inherit",
                }}
              />
              <s-button
                variant="tertiary"
                accessibilityLabel={
                  sort === "created" ? "Sort by name (A–Z)" : "Sort by newest first"
                }
                onClick={() => {
                  setSort((s) => (s === "created" ? "name" : "created"));
                  setPage(1);
                }}
              >
                {sort === "created" ? "↕ Newest" : "↕ Name A–Z"}
              </s-button>
            </div>

            <div role="tablist" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    border: "none",
                    cursor: "pointer",
                    font: "inherit",
                    fontWeight: 600,
                    fontSize: 13,
                    padding: "7px 14px",
                    borderRadius: 9,
                    background:
                      tab === t.id ? "var(--s-color-bg-fill-secondary, #f1f1f1)" : "transparent",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <DataTable
              rows={rows}
              emptyMessage="No contacts match your search."
              perPage={CONTACTS_PAGE_SIZE}
              page={page}
              onPageChange={setPage}
              onRowClick={openDetail}
              footerExtra={
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <s-text tone="neutral">Rows per page</s-text>
                  <select
                    value={String(CONTACTS_PAGE_SIZE)}
                    disabled
                    aria-label="Rows per page"
                    style={{
                      font: "inherit",
                      padding: "4px 8px",
                      borderRadius: 8,
                      border: "1px solid var(--s-color-border, #d4d4d4)",
                    }}
                  >
                    <option value="10">10</option>
                  </select>
                </label>
              }
              columns={[
                {
                  key: "name",
                  title: "Name",
                  render: (row) => {
                    const displayName = contactDisplayName(row);
                    return (
                      <span style={{ display: "flex", alignItems: "center", gap: 11 }}>
                        <ContactAvatar id={row.id} displayName={displayName} />
                        <span style={{ fontWeight: 650 }}>{displayName}</span>
                      </span>
                    );
                  },
                },
                {
                  key: "email",
                  title: "Email",
                  render: (row) => (row.email ? <span>{row.email}</span> : <EmDash />),
                },
                {
                  key: "type",
                  title: "Type",
                  render: (row) => <ContactTypeBadge type={row.type} />,
                },
                {
                  key: "channel",
                  title: "Channel",
                  render: (row) => <span>{CHANNEL_LABELS[row.channel] ?? row.channel}</span>,
                },
                {
                  key: "location",
                  title: "Location",
                  render: (row) => (row.location ? <span>{row.location}</span> : <EmDash />),
                },
                {
                  key: "conversations",
                  title: "Conversations",
                  align: "end",
                  render: (row) => (
                    <span style={{ fontWeight: 700 }}>{row.conversationCount}</span>
                  ),
                },
              ]}
            />
          </s-stack>
        </s-section>
      </s-stack>

      <ContactsExportModal
        open={exportOpen}
        exporting={exportFetcher.state !== "idle"}
        onClose={() => setExportOpen(false)}
        onExport={runExport}
      />

      <ContactDetailPanel
        open={detailOpen}
        loading={detailFetcher.state !== "idle"}
        contact={detail?.contact ?? null}
        conversations={detail?.conversations ?? []}
        onClose={() => setDetailOpen(false)}
      />
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
