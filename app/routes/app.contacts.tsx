import { useEffect, useRef, useState } from "react";
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
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { TabPills } from "../components/ui/TabPills";
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
    const scopeRaw = String(formData.get("scope") ?? "page");
    const scope = scopeRaw === "all" || scopeRaw === "selected" ? scopeRaw : ("page" as const);
    const ids = String(formData.get("ids") ?? "").split(",").filter(Boolean);
    const page = Math.max(1, Number(formData.get("page") ?? 1) || 1);
    const perPage = Number(formData.get("perPage") ?? 0);
    const pageSize = [10, 25, 50].includes(perPage) ? perPage : undefined;
    const q = String(formData.get("q") ?? "");
    const sort: ContactSort = formData.get("sort") === "name" ? "name" : "created";
    const type = parseType(formData.get("type") as string | null);
    const csv = await exportContactsCsv(shopId, { scope, ids, page, pageSize, q, sort, type });
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
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(CONTACTS_PAGE_SIZE);
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

  // Rows keep the server order (created-desc). Search lives in DataTable with
  // the same contains-insensitive rule the export re-computes server-side.
  const rows = data.contacts;

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
      shopify.toast.show("Contacts exported");
    }
  }, [exportFetcher.state, exportFetcher.data, shopify]);

  const runExport = (scope: "all" | "page" | "selected", ids: string[] = []) => {
    exportFetcher.submit(
      {
        intent: "export",
        scope,
        ids: ids.join(","),
        page: String(page),
        perPage: String(perPage),
        q: query,
        sort: "created",
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
      <s-stack gap="base">
        <s-section heading="Overview">
          <StatGrid>
            <StatTile
              label="Total contacts"
              value={String(data.stats.total)}
              icon="person-list"
              tone="accent"
              sub="across all channels"
            />
            <StatTile
              label="Customers"
              value={String(data.stats.customers)}
              icon="cart"
              tone="success"
              sub="have placed an order"
            />
            <StatTile
              label="Leads"
              value={String(data.stats.leads)}
              icon="email"
              tone="info"
              sub="shared contact info"
            />
            <StatTile
              label="Anonymous"
              value={String(data.stats.anonymous)}
              icon="person"
              tone="neutral"
              sub="not yet identified"
            />
          </StatGrid>
        </s-section>

        <s-section>
          <s-stack gap="base">
            <DataTable
              rows={rows}
              emptyMessage="No contacts match your search."
              searchPlaceholder="Search by name or email"
              searchFn={(row, q) =>
                (row.name ?? "").toLowerCase().includes(q) ||
                (row.email ?? "").toLowerCase().includes(q)
              }
              search={query}
              onSearchChange={(value) => {
                setQuery(value);
                setPage(1);
              }}
              perPage={perPage}
              onPerPageChange={(next) => {
                setPerPage(next);
                setPage(1);
              }}
              page={page}
              onPageChange={setPage}
              onRowClick={openDetail}
              toolbar={<TabPills tabs={TABS} active={tab} onChange={setTab} />}
              toolbarEnd={
                <>
                  <s-button
                    variant="primary"
                    icon="export"
                    disabled={exportFetcher.state !== "idle"}
                    commandFor="contacts-export-menu"
                  >
                    Export
                  </s-button>
                  <s-menu id="contacts-export-menu" accessibilityLabel="Export contacts">
                    <s-button onClick={() => runExport("all")}>All contacts</s-button>
                    <s-button onClick={() => runExport("page")}>Current page</s-button>
                  </s-menu>
                </>
              }
              searchFieldBelow
              searchAlwaysOpen
              bulkActions={(ids, clear) => (
                <s-button
                  disabled={exportFetcher.state !== "idle"}
                  onClick={() => {
                    runExport("selected", ids);
                    clear();
                  }}
                >
                  Export selected
                </s-button>
              )}
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
