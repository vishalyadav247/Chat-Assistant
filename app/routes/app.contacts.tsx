import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigation,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import {
  contactDetail,
  contactStats,
  convertContactToShopifyCustomer,
  deleteContact,
  exportContactsCsv,
  listContacts,
  matchContactsToShopifyCustomers,
  reclassifyPendingContacts,
  updateContactInfo,
} from "../lib/contacts/contacts.server";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { TabPills } from "../components/ui/TabPills";
import { DataTable } from "../components/DataTable";
import {
  CHANNEL_LABELS,
  CONTACTS_PAGE_SIZE,
  compareContacts,
  ContactAvatar,
  ContactTypeBadge,
  contactDisplayName,
  EmDash,
  splitContactName,
  TYPE_LABELS,
  type ContactRowData,
  type ContactSort,
  type ContactSortDir,
  type ContactType,
} from "../components/ContactsShared";
import { ContactDetailPanel } from "../components/ContactDetailPanel";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";

// Contacts CRM (spec 11, design contacts.html): stat tiles, tabbed + searchable
// contact table with conversation counts, contact detail side panel, CSV export
// modal. Contacts are created by the storefront paths (pre-chat/handover lead
// capture in proxy.prechat.tsx, specs 05/10) — this page reads/classifies only.

const TAB_TYPES = ["customer", "lead", "anonymous"] as const;

// Native s-modal open/close seam (same pattern as ChatboxChatPage).
interface OverlayEl extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const overlay = (id: string) => document.getElementById(id) as OverlayEl | null;
const EXPORT_MODAL_ID = "contacts-export-modal";
const EDIT_MODAL_ID = "contacts-edit-modal";
const CONVERT_MODAL_ID = "contacts-convert-modal";
const DELETE_MODAL_ID = "contacts-delete-modal";

function parseType(raw: string | null): ContactType | undefined {
  return (TAB_TYPES as readonly string[]).includes(raw ?? "")
    ? (raw as ContactType)
    : undefined;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "contacts" });
  const { shopId } = access;
  const admin = await access.getAdmin();
  const type = parseType(new URL(request.url).searchParams.get("type"));

  // Opportunistic classification passes on every load (all no-ops once caught
  // up): upgrade contacts whose storefront customer id arrived late, and match
  // contact emails against Shopify customers (needs read_customers; fails
  // soft). No contact-less-conversation backfill here — deleted contacts must
  // stay deleted (see deleteContact); new conversations bind one at creation.
  await reclassifyPendingContacts(shopId);
  await matchContactsToShopifyCustomers(shopId, admin.graphql);

  const [stats, contacts] = await Promise.all([
    contactStats(shopId),
    listContacts(shopId, { type }),
  ]);
  return { stats, contacts, tab: type ?? ("all" as const) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "contacts" });
  const { shopId } = access;
  const admin = await access.getAdmin();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const joinedName = () =>
    `${String(formData.get("firstName") ?? "").trim()} ${String(
      formData.get("lastName") ?? "",
    ).trim()}`.trim();

  if (intent === "export") {
    const scope = formData.get("scope") === "all" ? ("all" as const) : ("page" as const);
    const page = Math.max(1, Number(formData.get("page") ?? 1) || 1);
    const perPage = Number(formData.get("perPage") ?? 0);
    const pageSize = [10, 25, 50].includes(perPage) ? perPage : undefined;
    const q = String(formData.get("q") ?? "");
    const sortRaw = String(formData.get("sort") ?? "created");
    const sort: ContactSort =
      sortRaw === "name" || sortRaw === "updated" ? sortRaw : "created";
    const dir: ContactSortDir = formData.get("dir") === "asc" ? "asc" : "desc";
    const type = parseType(formData.get("type") as string | null);
    const csv = await exportContactsCsv(shopId, { scope, page, pageSize, q, sort, dir, type });
    const stamp = new Date().toISOString().slice(0, 10);
    return { intent: "export" as const, filename: `contacts-${stamp}.csv`, csv };
  }

  if (intent === "detail") {
    const detail = await contactDetail(shopId, String(formData.get("id") ?? ""));
    return { intent: "detail" as const, detail };
  }

  // "Convert to customer" (contact3.png): creates the Shopify customer profile
  // too (write_customers) — or links the existing one if the email is taken.
  if (intent === "convert-customer") {
    const result = await convertContactToShopifyCustomer(
      shopId,
      String(formData.get("id") ?? ""),
      admin.graphql,
      {
        firstName: String(formData.get("firstName") ?? ""),
        lastName: String(formData.get("lastName") ?? ""),
        email: String(formData.get("email") ?? ""),
        phone: String(formData.get("phone") ?? ""),
      },
    );
    return { intent: "convert-customer" as const, ...result };
  }

  // "Convert to lead" (anonymous only): app-side upgrade, needs an email.
  if (intent === "convert-lead") {
    const email = String(formData.get("email") ?? "").trim();
    if (!email) return { intent: "convert-lead" as const, ok: false, error: "Email address is required." };
    const result = await updateContactInfo(shopId, String(formData.get("id") ?? ""), {
      name: joinedName(),
      email,
      phone: String(formData.get("phone") ?? ""),
    });
    const ok = result === true;
    return {
      intent: "convert-lead" as const,
      ok,
      error: ok ? undefined : typeof result === "object" ? result.error : "Contact not found.",
    };
  }

  if (intent === "contact-save") {
    const result = await updateContactInfo(shopId, String(formData.get("id") ?? ""), {
      name: joinedName(),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
    });
    const ok = result === true;
    return {
      intent: "contact-save" as const,
      ok,
      error: ok ? undefined : typeof result === "object" ? result.error : "Contact not found.",
    };
  }

  if (intent === "contact-delete") {
    const ok = await deleteContact(shopId, String(formData.get("id") ?? ""), admin.graphql);
    return { intent: "contact-delete" as const, ok };
  }

  return { intent: "unknown" as const };
};

const TABS: { id: "all" | ContactType; label: string }[] = [
  { id: "all", label: "All" },
  { id: "customer", label: "Customer" },
  { id: "lead", label: "Lead" },
  { id: "anonymous", label: "Anonymous" },
];

const SORT_OPTIONS: { id: ContactSort; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "created", label: "Added date" },
  { id: "updated", label: "Last updated" },
];

// Sort popover per contacts.png: radio list of sort keys + direction rows.
function SortMenu(props: {
  sort: ContactSort;
  dir: ContactSortDir;
  onChange: (sort: ContactSort, dir: ContactSortDir) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: "7px 8px",
    border: "none",
    background: "none",
    borderRadius: 8,
    cursor: "pointer",
    font: "inherit",
    fontSize: 13,
    textAlign: "left",
  };
  const dirLabels =
    props.sort === "name"
      ? { asc: "A to Z", desc: "Z to A" }
      : { asc: "Oldest first", desc: "Newest first" };

  return (
    // The wrapper carries the exact rendered styles of s-search-field's input
    // box (2rem min height, .5rem radius, inset hairline #8a8a8a, #fdfdfd bg —
    // lifted from the Polaris web components bundle) so button and field match
    // pixel-for-pixel; the row's align-items: stretch syncs the height. The
    // transparent s-clickable inside stays Polaris so interestFor tooltips work.
    <div
      ref={rootRef}
      style={{
        position: "relative",
        minHeight: "2rem",
        width: 32,
        flex: "none",
        borderRadius: "0.5rem",
        background: "rgba(253, 253, 253, 1)",
        boxShadow: "inset 0 0 0 0.04125rem #8a8a8a",
      }}
    >
      <s-clickable
        accessibilityLabel="Sort contacts"
        interestFor="contacts-sort-tooltip"
        borderRadius="base"
        blockSize="100%"
        inlineSize="100%"
        onClick={() => setOpen(!open)}
      >
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <s-icon type="sort" />
        </div>
      </s-clickable>
      <s-tooltip id="contacts-sort-tooltip">Sort by</s-tooltip>
      {open ? (
        <div
          role="dialog"
          aria-label="Sort contacts"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 30,
            width: 220,
            padding: 8,
            background: "var(--s-color-bg, #fff)",
            border: "1px solid var(--s-color-border, #e3e3e6)",
            borderRadius: 12,
            boxShadow: "0 8px 24px rgba(20,20,25,.14)",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 650, padding: "4px 8px 8px" }}>Sort by</div>
          {SORT_OPTIONS.map((opt) => {
            const active = props.sort === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                style={rowStyle}
                onClick={() => props.onChange(opt.id, props.dir)}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 16,
                    height: 16,
                    flex: "none",
                    borderRadius: "50%",
                    boxSizing: "border-box",
                    border: active
                      ? "5px solid var(--s-color-text, #303030)"
                      : "2px solid var(--s-color-border, #c9c9cf)",
                  }}
                />
                {opt.label}
              </button>
            );
          })}
          <div
            style={{
              height: 1,
              margin: "6px 0",
              background: "var(--s-color-border, #e9e9ec)",
            }}
          />
          {(["asc", "desc"] as const).map((dir) => {
            const active = props.dir === dir;
            return (
              <button
                key={dir}
                type="button"
                style={{
                  ...rowStyle,
                  fontWeight: active ? 650 : 400,
                  background: active ? "var(--s-color-bg-surface-secondary, #f3f3f5)" : "none",
                }}
                onClick={() => props.onChange(props.sort, dir)}
              >
                <s-icon type={dir === "asc" ? "arrow-up" : "arrow-down"} size="small" />
                {dirLabels[dir]}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default function ContactsPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseType(searchParams.get("type")) ?? "all";
  // Tab switches navigate (loader re-runs its classification passes) — the
  // stale table stays visible under a centered spinner until fresh rows land.
  const tableLoading = navigation.state === "loading";

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(CONTACTS_PAGE_SIZE);
  const [detailOpen, setDetailOpen] = useState(false);
  const [sort, setSort] = useState<ContactSort>("created");
  const [sortDir, setSortDir] = useState<ContactSortDir>("desc");
  const [exportScope, setExportScope] = useState<"page" | "all">("page");
  const [editState, setEditState] = useState({
    id: "",
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [deleteTarget, setDeleteTarget] = useState<ContactRowData | null>(null);
  // Convert modal (contact3.png): mode "customer" creates the Shopify profile
  // (from a lead), mode "lead" upgrades an anonymous contact app-side.
  const [convertState, setConvertState] = useState({
    mode: "customer" as "customer" | "lead",
    id: "",
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [convertError, setConvertError] = useState<string | null>(null);

  const exportFetcher = useFetcher<typeof action>();
  const detailFetcher = useFetcher<typeof action>();
  const rowFetcher = useFetcher<typeof action>();

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

  // Sorted client-side with the same comparator the export re-runs server-side
  // (listContacts), so "current page" exports match the visible page. Search
  // lives in DataTable with the same contains-insensitive rule.
  const rows = useMemo(
    () => [...data.contacts].sort((a, b) => compareContacts(a, b, sort, sortDir)),
    [data.contacts, sort, sortDir],
  );

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
      overlay(EXPORT_MODAL_ID)?.hideOverlay();
      shopify.toast.show("Contacts exported");
    }
  }, [exportFetcher.state, exportFetcher.data, shopify]);

  // Edit / delete / convert completion → close the modal, toast, refresh the
  // open detail panel; the loader revalidation refreshes the table.
  const processedRow = useRef<unknown>(null);
  useEffect(() => {
    const result = rowFetcher.data;
    if (rowFetcher.state !== "idle" || !result || processedRow.current === result) return;
    processedRow.current = result;
    if (result.intent === "contact-save" && result.ok) {
      overlay(EDIT_MODAL_ID)?.hideOverlay();
      shopify.toast.show("Contact updated");
    } else if (result.intent === "contact-delete" && result.ok) {
      overlay(DELETE_MODAL_ID)?.hideOverlay();
      setDeleteTarget(null);
      setDetailOpen(false);
      shopify.toast.show("Contact deleted");
    } else if (result.intent === "convert-customer" || result.intent === "convert-lead") {
      if (result.ok) {
        overlay(CONVERT_MODAL_ID)?.hideOverlay();
        shopify.toast.show(
          result.intent === "convert-customer"
            ? "Customer created in Shopify"
            : "Converted to lead",
        );
        if (detailOpen && convertState.id) {
          detailFetcher.submit({ intent: "detail", id: convertState.id }, { method: "post" });
        }
      } else {
        setConvertError(result.error ?? "Something went wrong. Please try again.");
      }
    }
  }, [rowFetcher.state, rowFetcher.data, shopify, detailOpen, convertState.id, detailFetcher]);

  const runExport = (scope: "all" | "page") => {
    exportFetcher.submit(
      {
        intent: "export",
        scope,
        page: String(page),
        perPage: String(perPage),
        q: query,
        sort,
        dir: sortDir,
        type: tab === "all" ? "" : tab,
      },
      { method: "post" },
    );
  };

  const [requestedDetailId, setRequestedDetailId] = useState<string | null>(null);
  const openDetail = (row: ContactRowData) => {
    setRequestedDetailId(row.id);
    setDetailOpen(true);
    detailFetcher.submit({ intent: "detail", id: row.id }, { method: "post" });
  };

  const detail =
    detailFetcher.data?.intent === "detail" ? detailFetcher.data.detail : null;
  // Loading = "the requested contact's data isn't here yet" — NOT the fetcher
  // state, which stays busy through page revalidation after the data already
  // arrived and made the panel flip content→skeleton→content.
  const detailReady = detail?.contact?.id === requestedDetailId;

  // Panel-header actions: the convert modal pre-fills from the contact (name
  // split into first/last — Shopify customers use both).
  const openConvert = (contact: ContactRowData) => {
    const { firstName, lastName } = splitContactName(contact.name);
    setConvertError(null);
    setConvertState({
      mode: contact.type === "anonymous" ? "lead" : "customer",
      id: contact.id,
      firstName,
      lastName,
      email: contact.email ?? "",
      phone: contact.phone ?? "",
    });
    overlay(CONVERT_MODAL_ID)?.showOverlay();
  };
  const converting = rowFetcher.state !== "idle" &&
    ["convert-customer", "convert-lead"].includes(String(rowFetcher.formData?.get("intent")));

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
              sub="in your Shopify customers"
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
              loading={tableLoading}
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
                <s-button
                  variant="primary"
                  icon="export"
                  onClick={() => overlay(EXPORT_MODAL_ID)?.showOverlay()}
                >
                  Export
                </s-button>
              }
              searchFieldBelow
              searchAlwaysOpen
              searchRowEnd={
                <SortMenu
                  sort={sort}
                  dir={sortDir}
                  onChange={(nextSort, nextDir) => {
                    setSort(nextSort);
                    setSortDir(nextDir);
                    setPage(1);
                  }}
                />
              }
              rowActions={(row) => (
                <>
                  {/* Customers aren't editable here: their identity lives on
                      the Shopify customer profile, and a local edit (e.g. a
                      new email) would silently disagree with it. Manage them
                      in the Shopify customers admin instead. */}
                  {row.type !== "customer" ? (
                    <s-button
                      variant="tertiary"
                      icon="edit"
                      accessibilityLabel="Edit contact"
                      onClick={() => {
                        const { firstName, lastName } = splitContactName(row.name);
                        setEditState({
                          id: row.id,
                          firstName,
                          lastName,
                          email: row.email ?? "",
                          phone: row.phone ?? "",
                        });
                        overlay(EDIT_MODAL_ID)?.showOverlay();
                      }}
                    />
                  ) : null}
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    icon="delete"
                    accessibilityLabel="Delete contact"
                    onClick={() => {
                      setDeleteTarget(row);
                      overlay(DELETE_MODAL_ID)?.showOverlay();
                    }}
                  />
                </>
              )}
              columns={[
                {
                  key: "name",
                  title: "Name",
                  render: (row) => {
                    const displayName = contactDisplayName(row);
                    return (
                      <span style={{ display: "flex", alignItems: "center", gap: 11 }}>
                        <ContactAvatar id={row.id} displayName={displayName} type={row.type} />
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

      {/* Export modal per contact2.png: radio scope + Cancel/Export footer. */}
      <s-modal id={EXPORT_MODAL_ID} heading="Export contacts">
        <s-choice-list
          label="Select contacts to export"
          name="contacts-export-scope"
          values={[exportScope]}
          onChange={(e) => {
            const value = e.currentTarget.values[0];
            setExportScope(value === "all" ? "all" : "page");
          }}
        >
          <s-choice value="page">Current page</s-choice>
          <s-choice value="all">All contacts</s-choice>
        </s-choice-list>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={exportFetcher.state !== "idle"}
          onClick={() => runExport(exportScope)}
        >
          Export
        </s-button>
        <s-button slot="secondary-actions" onClick={() => overlay(EXPORT_MODAL_ID)?.hideOverlay()}>
          Cancel
        </s-button>
      </s-modal>

      <s-modal id={EDIT_MODAL_ID} heading="Edit contact">
        <s-stack gap="base">
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <s-text-field
                label="First name"
                value={editState.firstName}
                onInput={(e) => {
                  const firstName = e.currentTarget.value;
                  setEditState((s) => ({ ...s, firstName }));
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <s-text-field
                label="Last name"
                value={editState.lastName}
                onInput={(e) => {
                  const lastName = e.currentTarget.value;
                  setEditState((s) => ({ ...s, lastName }));
                }}
              />
            </div>
          </div>
          <s-text-field
            label="Email"
            value={editState.email}
            details="Adding an email to an anonymous contact makes them a lead."
            onInput={(e) => {
              const email = e.currentTarget.value;
              setEditState((s) => ({ ...s, email }));
            }}
          />
          <s-text-field
            label="Phone"
            value={editState.phone}
            onInput={(e) => {
              const phone = e.currentTarget.value;
              setEditState((s) => ({ ...s, phone }));
            }}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={
            rowFetcher.state !== "idle" && rowFetcher.formData?.get("intent") === "contact-save"
          }
          onClick={() =>
            rowFetcher.submit({ intent: "contact-save", ...editState }, { method: "post" })
          }
        >
          Save
        </s-button>
        <s-button slot="secondary-actions" onClick={() => overlay(EDIT_MODAL_ID)?.hideOverlay()}>
          Cancel
        </s-button>
      </s-modal>

      {/* Convert modal (contact3.png): first/last/email/phone → Create. */}
      <s-modal
        id={CONVERT_MODAL_ID}
        heading={convertState.mode === "customer" ? "Create customer" : "Convert to lead"}
      >
        <s-stack gap="base">
          <s-paragraph>
            {convertState.mode === "customer"
              ? "Create a Shopify profile with their email to update their details & order history."
              : "Add their contact details to turn this anonymous visitor into a lead."}
          </s-paragraph>
          {convertError ? <s-banner tone="critical">{convertError}</s-banner> : null}
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <s-text-field
                label="First name"
                value={convertState.firstName}
                onInput={(e) => {
                  const firstName = e.currentTarget.value;
                  setConvertState((s) => ({ ...s, firstName }));
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <s-text-field
                label="Last name"
                value={convertState.lastName}
                onInput={(e) => {
                  const lastName = e.currentTarget.value;
                  setConvertState((s) => ({ ...s, lastName }));
                }}
              />
            </div>
          </div>
          <s-text-field
            label="Email address"
            value={convertState.email}
            onInput={(e) => {
              const email = e.currentTarget.value;
              setConvertState((s) => ({ ...s, email }));
            }}
          />
          <s-text-field
            label="Phone (optional)"
            value={convertState.phone}
            onInput={(e) => {
              const phone = e.currentTarget.value;
              setConvertState((s) => ({ ...s, phone }));
            }}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!convertState.email.trim()}
          loading={converting}
          onClick={() => {
            const { mode, ...fields } = convertState;
            rowFetcher.submit(
              { intent: mode === "customer" ? "convert-customer" : "convert-lead", ...fields },
              { method: "post" },
            );
          }}
        >
          {convertState.mode === "customer" ? "Create" : "Convert"}
        </s-button>
        <s-button slot="secondary-actions" onClick={() => overlay(CONVERT_MODAL_ID)?.hideOverlay()}>
          Cancel
        </s-button>
      </s-modal>

      {/* Delete confirm (contact4.png) — an s-modal so it renders at exactly
          the same width as the Create/Convert modal. Deletes conversations. */}
      <s-modal
        id={DELETE_MODAL_ID}
        heading={`Delete ${deleteTarget ? (TYPE_LABELS[deleteTarget.type] ?? "contact").toLowerCase() : "contact"}?`}
      >
        <s-paragraph>
          {`This will delete ${
            deleteTarget ? contactDisplayName(deleteTarget) : "this contact"
          } along with their customer profile in Shopify (if one is linked) and all their linked conversations. This action can't be undone.`}
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={
            rowFetcher.state !== "idle" && rowFetcher.formData?.get("intent") === "contact-delete"
          }
          onClick={() => {
            if (!deleteTarget) return;
            rowFetcher.submit(
              { intent: "contact-delete", id: deleteTarget.id },
              { method: "post" },
            );
          }}
        >
          Delete
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => {
            overlay(DELETE_MODAL_ID)?.hideOverlay();
            setDeleteTarget(null);
          }}
        >
          Cancel
        </s-button>
      </s-modal>

      <ContactDetailPanel
        open={detailOpen}
        loading={!detailReady}
        contact={detailReady ? detail.contact : null}
        conversations={detailReady ? detail.conversations : []}
        activities={detailReady ? detail.activities : []}
        onClose={() => setDetailOpen(false)}
        onDelete={(contact) => {
          setDeleteTarget(contact);
          overlay(DELETE_MODAL_ID)?.showOverlay();
        }}
        onConvert={openConvert}
      />
    </s-page>
  );
}

export function ErrorBoundary() {
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
