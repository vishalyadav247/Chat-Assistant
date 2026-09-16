import { useRef, useState } from "react";
import type {
  Meter,
  PoliciesPayload,
  SourceRow,
  TrainingActionResult,
} from "../routes/app.ai-agent.training";
import { BrowseModalShell } from "./BrowseProductsModal";
import { DataTable } from "./DataTable";
import { PlanBadge, PlanMeter } from "./ui/PlanGate";
import { ConfirmDeleteModal } from "./ui/ConfirmDeleteModal";
import { useAppBridge } from "../lib/ui/surface";
import { LookupTableMapping, type MappingColumn } from "./LookupTableMapping";
import {
  detectDelimiter,
  detectRanges,
  guessRoles,
  iterateCsv,
  mappingProblem,
  MAX_TABLE_COLUMNS,
  TABLE_DESCRIPTION_MAX,
  TABLE_FILE_MAX_BYTES,
  TABLE_UPLOAD_MAX_BYTES,
  uniqueHeaders,
} from "../lib/lookup/lookup-shared";
import { LearnCard, StatusBadge, usePendingSources, useTrainingFetcher } from "./TrainingShared";

// Custom knowledge tab (spec 07, design #viewTraining → Custom knowledge):
// learn card, a paginated Manage sources table (one row per URL, file and
// policy) with a type-filter dropdown, and the three add-data
// entry points (URL source, Upload file, Connect policies) with quota meters. Manual Q&A and Import CSV moved to the FAQs
// tab (FAQ consolidation) — legacy manual/csv rows stay listed
// and deletable here, but nothing new of those types can be created.

// Legacy rows (manual / csv / combined pages) show under "All sources" only.
type SourceFilter = "all" | "url" | "file" | "table" | "policy";

const TYPE_LABEL: Record<string, string> = {
  url: "URL",
  file: "File",
  table: "Lookup table",
  policy: "Policy",
  manual: "Manual (legacy)",
  csv: "CSV (legacy)",
  pages: "Policies & pages (legacy)",
};

/** Line clamp for the Source cell — WebkitLineClamp is set per use. URLs have
 *  no spaces, so they must be allowed to break anywhere or they never wrap. */
const CLAMP: React.CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  overflowWrap: "anywhere",
  // Up to 280px (owner, 2026-09-16): a long title or URL used to take the room
  // the other columns need and push their values onto a second line.
  maxWidth: 280,
};

/** The short columns stay on one line; only the Source column wraps. */
const NOWRAP: React.CSSProperties = { whiteSpace: "nowrap" };

interface UrlDraft {
  id: string | null;
  /** The one URL — add and edit alike (one URL per entry). */
  url: string;
  reCrawlWeekly: boolean;
  status: "active" | "inactive";
}

interface CsvPreview {
  file: File;
  columns: MappingColumn[];
  rows: number;
  /** Range pairs detected from the headers ("Year" from Year From/To). */
  ranges: string[];
}

interface TableEditDraft {
  id: string;
  name: string;
  description: string;
  rows: number;
  status: "active" | "inactive";
  columns: MappingColumn[];
  ranges: string[];
}

interface FileEditDraft {
  id: string;
  name: string;
  chunkCount: number;
  status: "active" | "inactive";
}

export function TrainingKnowledgeTab(props: {
  sources: SourceRow[];
  chunkTotal: number;
  quotas: { crawlPages: Meter; fileUploads: Meter; lookupRows: Meter };
  /** Policies connected — there is no policy limit. */
  connectedPolicies: number;
  /** Plan gating for the add-data tiles (spec 15). Locked plan names are null
   *  when the current plan already includes the source; the *Next names are
   *  the plan that raises each quota, or null at the top tier. */
  planSignals: {
    fileUploadsNext: string | null;
    crawlPagesNext: string | null;
    /** Largest CSV this plan accepts, in bytes (0 = CSV not included). */
    csvMaxBytes: number;
    /** Plan that allows a bigger CSV, or null at the top. */
    csvUploadNext: string | null;
    /** Plan with more lookup-table rows, or null at the top. */
    lookupRowsNext: string | null;
  };
}) {
  const dt = useDateTime();
  // Flip Pending → Active (or Error) without a page reload — every source type.
  usePendingSources(props.sources);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [urlDraft, setUrlDraft] = useState<UrlDraft | null>(null);
  const [fileOpen, setFileOpen] = useState(false);
  const [filePick, setFilePick] = useState<{
    name: string;
    mime: string;
    dataBase64: string;
  } | null>(null);
  const [fileError, setFileError] = useState("");
  // Required title — says what the file is in Manage sources.
  const [fileTitle, setFileTitle] = useState("");
  const [fileEdit, setFileEdit] = useState<FileEditDraft | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [policies, setPolicies] = useState<PoliciesPayload | null>(null);
  const [policySelection, setPolicySelection] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // CSV upload (spec 28): a lookup table (rows the AI filters) or reference text.
  const [csv, setCsv] = useState<CsvPreview | null>(null);
  const [csvMode, setCsvMode] = useState<"table" | "text">("table");
  const [csvReading, setCsvReading] = useState(false);
  const [tableDescription, setTableDescription] = useState("");
  const [tableEdit, setTableEdit] = useState<TableEditDraft | null>(null);
  const [downloading, setDownloading] = useState(false);
  const shopify = useAppBridge();

  // The stored file comes back gzip-encoded and the browser inflates it; the
  // fetch goes through App Bridge (embedded) or the web session cookie.
  const downloadTableCsv = async (id: string) => {
    setDownloading(true);
    try {
      const res = await fetch(`/app/lookup-download?id=${encodeURIComponent(id)}`);
      if (!res.ok || res.redirected) throw new Error(`download ${res.status}`);
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "table.csv";
      const url = URL.createObjectURL(await res.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      shopify.toast.show("The CSV couldn't be downloaded — try again.", {
        isError: true,
      });
    } finally {
      setDownloading(false);
    }
  };

  // Last server-CONFIRMED policy selection — the revert target when an
  // optimistic toggle is rejected (QA D8). A ref, so it can't go stale
  // between a save and the next toggle.
  const confirmedPolicies = useRef<string[]>([]);
  const pendingPolicies = useRef<string[]>([]);

  const { submit, submitForm, busy } = useTrainingFetcher((result: TrainingActionResult) => {
    if (result.intent === "policies-list" && result.ok && result.policies) {
      setPolicies(result.policies);
      setPolicySelection(new Set(result.policies.selectedTypes));
      confirmedPolicies.current = result.policies.selectedTypes;
      return;
    }
    if (result.intent === "source-delete") setDeleteTarget(null);
    if (!result.ok) {
      // The policies switch flips optimistically; a rejected save (quota, no
      // matching pages) must put it back or the UI lies about what's
      // connected and the "N of M pages used" meter drifts.
      if (result.intent === "policies-save") {
        setPolicySelection(new Set(confirmedPolicies.current));
      }
      return;
    }
    if (result.intent === "policies-save") {
      confirmedPolicies.current = pendingPolicies.current;
      setPolicies((prev) => (prev ? { ...prev, selectedTypes: pendingPolicies.current } : prev));
      return;
    }
    switch (result.intent) {
      case "source-update":
        setUrlDraft(null);
        setFileEdit(null);
        setTableEdit(null);
        break;
      case "source-add-url":
        setUrlDraft(null);
        break;
      case "source-add-file":
      case "source-add-table":
        setFileOpen(false);
        setFilePick(null);
        setFileTitle("");
        setCsv(null);
        setTableDescription("");
        break;
    }
  });

  const csvMaxBytes = props.planSignals.csvMaxBytes;
  const csvMb = Math.round((csvMaxBytes / (1024 * 1024)) * 10) / 10;
  const csvNext = props.planSignals.csvUploadNext;

  const rows = filter === "all" ? props.sources : props.sources.filter((s) => s.type === filter);

  const openPolicies = () => {
    setPolicies(null);
    setPoliciesOpen(true);
    submit("policies-list");
  };

  const savePolicies = (nextSelection: Set<string>) => {
    pendingPolicies.current = Array.from(nextSelection);
    submit("policies-save", {
      payload: JSON.stringify({ types: pendingPolicies.current }),
    });
  };

  // Legacy manual/csv rows have no edit modal any more — Edit is only
  // rendered for url/pages/file rows.
  const openEdit = (source: SourceRow) => {
    switch (source.type) {
      case "url":
        setUrlDraft({
          id: source.id,
          url: source.url ?? source.name,
          reCrawlWeekly: source.reCrawlWeekly,
          status: source.status === "inactive" ? "inactive" : "active",
        });
        break;
      case "pages":
        openPolicies();
        break;
      case "file":
        setFileEdit({
          id: source.id,
          name: source.name,
          chunkCount: source.chunkCount,
          status: source.status === "inactive" ? "inactive" : "active",
        });
        break;
      case "table":
        if (!source.table) break;
        setTableEdit({
          id: source.id,
          name: source.name,
          description: source.table.description,
          rows: source.chunkCount,
          status: source.status === "inactive" ? "inactive" : "active",
          columns: source.table.columns,
          ranges: source.table.ranges.map((r) => r.name),
        });
        break;
    }
  };

  const readAsBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const onPickFile = (file: File | null) => {
    setFileError("");
    setFilePick(null);
    setCsv(null);
    if (!file) return;
    // Suggest the filename (minus extension) — the merchant can rewrite it.
    const suggestTitle = () =>
      setFileTitle((current) => current || file.name.replace(/\.[^.]+$/, ""));
    if (/\.csv$/i.test(file.name)) {
      // Read it here to show the columns; the size check depends on the mode chosen.
      if (file.size > TABLE_FILE_MAX_BYTES) {
        setFileError(`CSV is too large — the limit is ${TABLE_FILE_MAX_BYTES / (1024 * 1024)}MB.`);
        return;
      }
      setCsvReading(true);
      file
        .text()
        .then((text) => {
          const delimiter = detectDelimiter(text);
          let headers: string[] | null = null;
          const sample: string[][] = [];
          let rowCount = 0;
          for (const record of iterateCsv(text, delimiter)) {
            if (!headers) headers = uniqueHeaders(record);
            else {
              rowCount++;
              if (sample.length < 300) sample.push(record);
            }
          }
          if (!headers || rowCount === 0) {
            setFileError("The CSV needs a header row and at least one data row.");
            return;
          }
          const roles = guessRoles(headers, sample);
          const columns = headers.map((name, i) => ({
            key: `c${i}`,
            name,
            role: roles[i],
            samples: [...new Set(sample.map((r) => (r[i] ?? "").trim()).filter(Boolean))].slice(
              0,
              5,
            ),
          }));
          setCsv({
            file,
            columns,
            rows: rowCount,
            ranges: detectRanges(columns).map((r) => r.name),
          });
          suggestTitle();
        })
        .catch(() => setFileError("The file could not be read."))
        .finally(() => setCsvReading(false));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setFileError("File is too large — maximum size is 2MB.");
      return;
    }
    readAsBase64(file).then((dataBase64) => {
      setFilePick({ name: file.name, mime: file.type, dataBase64 });
      suggestTitle();
    });
  };

  const lookupRowsLeft = Math.max(props.quotas.lookupRows.quota - props.quotas.lookupRows.used, 0);
  const lookupNext = props.planSignals.lookupRowsNext;
  // Why the chosen CSV mode can't be added, or "" when it can.
  const csvProblem = !csv
    ? ""
    : csvMode === "table"
      ? csv.columns.length > MAX_TABLE_COLUMNS
        ? `The CSV has ${csv.columns.length} columns — the limit is ${MAX_TABLE_COLUMNS}.`
        : csv.rows > lookupRowsLeft
          ? `This file has ${csv.rows.toLocaleString()} rows, and your plan has room for ${lookupRowsLeft.toLocaleString()} more lookup-table rows${lookupNext ? ` — upgrade to ${lookupNext} for more` : ""}.`
          : (mappingProblem(csv.columns.map((c) => c.role)) ?? "")
      : csvMaxBytes === 0
        ? `Reference-text CSVs aren't included in your plan${csvNext ? ` — available on ${csvNext}` : ""}.`
        : csv.file.size > csvMaxBytes
          ? `As reference text, your plan allows CSVs up to ${csvMb}MB${csvNext ? ` (larger on ${csvNext})` : ""}. A lookup table can be bigger.`
          : "";

  const addFile = async () => {
    if (!csv) {
      if (filePick)
        submit("source-add-file", {
          payload: JSON.stringify({ ...filePick, title: fileTitle.trim() }),
        });
      return;
    }
    if (csvMode === "text") {
      const dataBase64 = await readAsBase64(csv.file);
      submit("source-add-file", {
        payload: JSON.stringify({
          name: csv.file.name,
          mime: csv.file.type,
          dataBase64,
          title: fileTitle.trim(),
        }),
      });
      return;
    }
    // Gzip in the browser: a 200,000-row CSV is ~20MB of text but ~2MB compressed.
    const form = new FormData();
    let body: Blob = csv.file;
    let encoding = "identity";
    if (typeof CompressionStream !== "undefined") {
      body = await new Response(
        csv.file.stream().pipeThrough(new CompressionStream("gzip")),
      ).blob();
      encoding = "gzip";
    }
    if (body.size > TABLE_UPLOAD_MAX_BYTES) {
      setFileError(
        encoding === "gzip"
          ? `This file is too large to upload (${Math.round(body.size / (1024 * 1024))}MB compressed; the limit is ${TABLE_UPLOAD_MAX_BYTES / (1024 * 1024)}MB).`
          : "This browser can't compress the file before upload — use a current Chrome, Edge, Safari or Firefox.",
      );
      return;
    }
    form.set("file", body, csv.file.name);
    form.set("encoding", encoding);
    form.set(
      "payload",
      JSON.stringify({
        title: fileTitle.trim(),
        description: tableDescription.trim(),
        filename: csv.file.name,
        roles: csv.columns.map((c) => c.role),
      }),
    );
    submitForm("source-add-table", form);
  };

  return (
    <s-stack gap="base">
      <LearnCard
        title="Custom knowledge"
        chip={`${props.chunkTotal} items learned`}
        description="Train your AI with web pages, files and your store policies for more accurate, personalized answers. Q&As live in the FAQs tab; store pages and blogs have their own tabs."
      />

      {/* Manage sources: one row per URL, file and policy, on the
          shared paginated DataTable; the type filter is a dropdown to the right
          of the title + description. */}
      <s-section>
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
            <s-stack gap="small-200">
              <s-heading>Manage sources</s-heading>
              <s-paragraph color="subdued">
                Everything the assistant learns from beyond your catalogue. Each URL, file and
                policy is its own source.
              </s-paragraph>
            </s-stack>
            <s-select
              label="Filter sources"
              labelAccessibilityVisibility="exclusive"
              value={filter}
              onInput={(e) => {
                const value = e.currentTarget.value;
                setFilter(
                  value === "url" || value === "file" || value === "table" || value === "policy"
                    ? value
                    : "all",
                );
              }}
            >
              <s-option value="all">All sources</s-option>
              <s-option value="url">URL sources</s-option>
              <s-option value="file">Files</s-option>
              <s-option value="table">Lookup tables</s-option>
              <s-option value="policy">Policies</s-option>
            </s-select>
          </s-grid>

          <DataTable
            rows={rows}
            perPage={10}
            searchAlwaysOpen
            searchPlaceholder="Search sources"
            searchFn={(row, q) =>
              row.name.toLowerCase().includes(q) || (row.detail ?? "").toLowerCase().includes(q)
            }
            emptyMessage={
              filter === "all"
                ? "No sources yet — add a URL, upload a file, or connect your policies below."
                : "No sources of this type. Switch the filter to All sources to see everything."
            }
            columns={[
              {
                key: "source",
                title: "Source",
                render: (source) => (
                  <s-stack gap="small-500">
                    {/* Max height (user): title ≤ 2 lines, URL/filename 1 line,
                        full text on hover — a long URL or title used to stretch
                        the row and push the other columns around. */}
                    <div title={source.name} style={{ ...CLAMP, WebkitLineClamp: 2 }}>
                      <s-text type="strong">{source.name}</s-text>
                    </div>
                    {source.detail ? (
                      <div title={source.detail} style={{ ...CLAMP, WebkitLineClamp: 1 }}>
                        <s-text color="subdued">{source.detail}</s-text>
                      </div>
                    ) : null}
                    {source.removedInShopify ? (
                      <div style={{ maxWidth: 280 }}>
                        <s-text tone="critical">
                          Removed in Shopify — nothing to learn. Delete this source.
                        </s-text>
                      </div>
                    ) : null}
                  </s-stack>
                ),
              },
              {
                key: "type",
                title: "Type",
                render: (source) => (
                  <span style={NOWRAP}>
                    <s-badge tone="neutral">{TYPE_LABEL[source.type] ?? source.type}</s-badge>
                  </span>
                ),
              },
              {
                key: "chunks",
                title: "Learned",
                render: (source) => (
                  <span style={NOWRAP}>
                    <s-text tone="neutral">
                      {source.type === "table"
                        ? `${source.chunkCount.toLocaleString()} row${source.chunkCount === 1 ? "" : "s"}`
                        : `${source.chunkCount} chunk${source.chunkCount === 1 ? "" : "s"}`}
                    </s-text>
                  </span>
                ),
              },
              {
                key: "status",
                title: "Status",
                render: (source) => (
                  <span style={NOWRAP}>
                    <StatusBadge status={source.status} error={source.error} />
                  </span>
                ),
              },
              {
                key: "synced",
                title: "Last synced",
                render: (source) => (
                  <span style={NOWRAP}>
                    <s-text tone="neutral">
                      {source.lastSyncedAt ? dt.dateTime(source.lastSyncedAt) : "—"}
                    </s-text>
                  </span>
                ),
              },
              {
                key: "actions",
                title: "Actions",
                align: "end",
                render: (source) => (
                  <s-stack direction="inline" gap="small-300" justifyContent="end">
                    {source.type === "url" ||
                    source.type === "file" ||
                    (source.type === "table" && source.table) ? (
                      <s-button variant="tertiary" onClick={() => openEdit(source)}>
                        Edit
                      </s-button>
                    ) : null}
                    {source.type === "url" ||
                    source.type === "policy" ||
                    source.type === "pages" ? (
                      <s-button
                        variant="tertiary"
                        icon="refresh"
                        accessibilityLabel={`Re-sync ${source.name}`}
                        disabled={busy}
                        onClick={() => submit("source-resync", { id: source.id })}
                      />
                    ) : null}
                    {/* Confirmed in the shared ConfirmDeleteModal below. */}
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      icon="delete"
                      accessibilityLabel={`Delete ${source.name}`}
                      onClick={() => setDeleteTarget({ id: source.id, name: source.name })}
                    />
                  </s-stack>
                ),
              },
            ]}
          />
          <s-text color="subdued">
            Re-sync re-reads a source and rebuilds what the assistant learned from it — use it after
            the page or policy changes.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Add data">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Choose how to feed the assistant — pick any option. To add Q&As (manually or by CSV
            import), use the FAQs tab.
          </s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="small-200">
            <AddTile
              title="URL source"
              description="Add pages from any website — each URL is read as one page"
              onClick={() =>
                setUrlDraft({
                  id: null,
                  url: "",
                  reCrawlWeekly: false,
                  status: "active",
                })
              }
            >
              <PlanMeter
                used={props.quotas.crawlPages.used}
                quota={props.quotas.crawlPages.quota}
                label="URLs"
                nextPlan={props.planSignals.crawlPagesNext}
              />
            </AddTile>
            <AddTile
              title="Upload file"
              description="PDF, TXT, JSON, CSV — documents and data tables."
              onClick={() => {
                setFilePick(null);
                setFileError("");
                setFileTitle("");
                setCsv(null);
                setCsvMode("table");
                setTableDescription("");
                setFileOpen(true);
              }}
            >
              <PlanMeter
                used={props.quotas.fileUploads.used}
                quota={props.quotas.fileUploads.quota}
                label="uploads"
                nextPlan={props.planSignals.fileUploadsNext}
              />
              <PlanMeter
                used={props.quotas.lookupRows.used}
                quota={props.quotas.lookupRows.quota}
                label="lookup-table rows"
                nextPlan={props.planSignals.lookupRowsNext}
              />
            </AddTile>
            {/* In the same row as the other two — it used
                to be a full-width tile underneath. */}
            <AddTile
              title="Connect policies"
              description="Refund, shipping, privacy, terms and more — each policy is its own source"
              onClick={openPolicies}
            >
              {/* No limit (Shopify has at most 8 policy types), so a count
                  rather than a meter. The store's own total needs a Shopify
                  call, so it is shown in the modal, which already makes one. */}
              <s-text color="subdued">
                {props.connectedPolicies} polic
                {props.connectedPolicies === 1 ? "y" : "ies"} connected
              </s-text>
            </AddTile>
          </s-grid>
        </s-stack>
      </s-section>

      {/* ── Website URL modal (design #mSource) ──────────────────────────── */}
      <BrowseModalShell
        open={urlDraft !== null}
        title={urlDraft?.id ? "Edit URL source" : "Add URL source"}
        onClose={() => setUrlDraft(null)}
        footer={
          urlDraft ? (
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
              <s-button onClick={() => setUrlDraft(null)}>Cancel</s-button>
              <s-button
                variant="primary"
                disabled={busy || !urlDraft.url.trim()}
                loading={busy}
                onClick={() => {
                  if (urlDraft.id) {
                    submit("source-update", {
                      id: urlDraft.id,
                      payload: JSON.stringify({
                        url: urlDraft.url.trim(),
                        reCrawlWeekly: urlDraft.reCrawlWeekly,
                        status: urlDraft.status,
                      }),
                    });
                    return;
                  }
                  // One URL per entry — each Save adds one
                  // source row; add another for the next URL.
                  submit("source-add-url", {
                    payload: JSON.stringify({
                      urls: [urlDraft.url.trim()],
                      reCrawlWeekly: urlDraft.reCrawlWeekly,
                      status: urlDraft.status,
                    }),
                  });
                }}
              >
                Save
              </s-button>
            </span>
          ) : null
        }
      >
        {urlDraft ? (
          <s-stack gap="base">
            <s-text-field
              label="URL"
              placeholder="https://example.com/help/shipping"
              details={
                urlDraft.id
                  ? undefined
                  : `Each URL is its own source (${props.quotas.crawlPages.used} of ${props.quotas.crawlPages.quota} used).`
              }
              value={urlDraft.url}
              onInput={(e) => setUrlDraft({ ...urlDraft, url: e.currentTarget.value })}
            />
            {/* Single page only (spec 22, user decision): the linked-pages and
                whole-site options are gone. Store pages and blog articles come
                from the Pages and Blogs tabs, synced from Shopify with none of a
                scraped page's header/footer noise. */}
            <s-text tone="neutral">
              We read each page on its own, strip it to text, and index it. For your store&apos;s
              pages and blog articles, use the Pages and Blogs tabs — they sync straight from
              Shopify.
            </s-text>
            <s-checkbox
              label="Re-crawl weekly — keep knowledge fresh as your site changes"
              checked={urlDraft.reCrawlWeekly}
              onInput={(e) =>
                setUrlDraft({
                  ...urlDraft,
                  reCrawlWeekly: e.currentTarget.checked,
                })
              }
            />
            <StatusSelect
              value={urlDraft.status}
              onChange={(status) => setUrlDraft({ ...urlDraft, status })}
            />
            <s-box padding="small" borderWidth="base" borderRadius="base">
              <s-text tone="neutral">
                We&apos;ll read this page and generate answerable content the assistant can cite.
              </s-text>
            </s-box>
          </s-stack>
        ) : null}
      </BrowseModalShell>

      {/* ── Upload file modal (design #mUploadFile) ──────────────────────── */}
      <BrowseModalShell
        open={fileOpen}
        title="Add file"
        onClose={() => setFileOpen(false)}
        footer={
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            <s-button onClick={() => setFileOpen(false)}>Back</s-button>
            <s-button
              variant="primary"
              disabled={
                busy ||
                csvReading ||
                !fileTitle.trim() ||
                (csv
                  ? Boolean(csvProblem) || (csvMode === "table" && !tableDescription.trim())
                  : !filePick)
              }
              loading={busy}
              onClick={() => {
                setFileError("");
                addFile().catch(() => setFileError("The file could not be read."));
              }}
            >
              Add
            </s-button>
          </span>
        }
      >
        <s-stack gap="base">
          <s-text-field
            label="Title"
            required
            placeholder="e.g. Size guide for rings and bracelets"
            details="What this file is about — shown in Manage sources."
            maxLength={200}
            value={fileTitle}
            onInput={(e) => setFileTitle(e.currentTarget.value)}
          />
          <div
            style={{
              border: "1.5px dashed var(--s-color-border, #d4d4d4)",
              borderRadius: 12,
              padding: 32,
              textAlign: "center",
            }}
          >
            <input
              type="file"
              accept=".pdf,.txt,.json,.csv,application/pdf,text/csv"
              aria-label="Choose a file"
              onChange={(e) => onPickFile(e.currentTarget.files?.[0] ?? null)}
            />
            {filePick ? <s-paragraph>Selected: {filePick.name}</s-paragraph> : null}
            {csvReading ? <s-paragraph>Reading the CSV…</s-paragraph> : null}
            {csv ? (
              <s-paragraph>
                Selected: {csv.file.name} — {csv.rows.toLocaleString()} rows, {csv.columns.length}{" "}
                columns
              </s-paragraph>
            ) : null}
          </div>

          {csv ? (
            <s-stack gap="base">
              <s-choice-list
                label="How should the AI use this CSV?"
                values={[csvMode]}
                onChange={(e) => {
                  const value = e.currentTarget.values?.[0];
                  setCsvMode(value === "text" ? "text" : "table");
                }}
              >
                <s-choice value="table">
                  Lookup table — the AI finds the exact matching rows
                  <span slot="details">
                    Best for structured data looked up by exact values — one row per item or
                    combination. Up to {props.quotas.lookupRows.quota.toLocaleString()} rows on your
                    plan ({props.quotas.lookupRows.used.toLocaleString()} used).
                  </span>
                </s-choice>
                <s-choice value="text">
                  Reference text — the AI reads it like a document
                  <span slot="details">
                    For CSVs that are mostly sentences (care notes, store locations with
                    descriptions).{" "}
                    {csvMaxBytes === 0
                      ? "Not included in your plan."
                      : `Up to ${csvMb}MB on your plan.`}
                  </span>
                </s-choice>
              </s-choice-list>
              {csvMode === "table" ? (
                <>
                  <s-text-area
                    label="What is this table for?"
                    required
                    rows={2}
                    maxLength={TABLE_DESCRIPTION_MAX}
                    placeholder="e.g. Which product matches each combination of options in this table"
                    details="The AI reads this to know when to look rows up."
                    value={tableDescription}
                    onInput={(e) => setTableDescription(e.currentTarget.value)}
                  />
                  <LookupTableMapping
                    columns={csv.columns}
                    ranges={csv.ranges}
                    onChange={(key, role) =>
                      setCsv({
                        ...csv,
                        columns: csv.columns.map((c) => (c.key === key ? { ...c, role } : c)),
                      })
                    }
                  />
                </>
              ) : null}
              {csvProblem &&
              !(csvMode === "table" && mappingProblem(csv.columns.map((c) => c.role))) ? (
                <s-text tone="critical">{csvProblem}</s-text>
              ) : null}
            </s-stack>
          ) : null}

          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12.5,
              lineHeight: 1.9,
            }}
          >
            <li>Supported formats: .pdf, .txt, .json, .csv</li>
            <li>
              PDFs are read from their text layer — scanned or image-only PDFs (and tables inside
              images) can&apos;t be learned
            </li>
            <li>CSV: the first row must be the column headers</li>
            <li>.docx isn&apos;t supported — save it as a PDF first</li>
            <li>Maximum file size: 2MB for PDF, TXT and JSON</li>
          </ul>
          {fileError ? <s-text tone="critical">{fileError}</s-text> : null}
        </s-stack>
      </BrowseModalShell>

      {/* ── Edit file modal (design #mFileEdit) ──────────────────────────── */}
      <BrowseModalShell
        open={fileEdit !== null}
        title="Edit file"
        onClose={() => setFileEdit(null)}
        footer={
          fileEdit ? (
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
              <s-button onClick={() => setFileEdit(null)}>Cancel</s-button>
              <s-button
                variant="primary"
                disabled={busy || !fileEdit.name.trim()}
                loading={busy}
                onClick={() =>
                  submit("source-update", {
                    id: fileEdit.id,
                    payload: JSON.stringify({
                      name: fileEdit.name,
                      status: fileEdit.status,
                    }),
                  })
                }
              >
                Save
              </s-button>
            </span>
          ) : null
        }
      >
        {fileEdit ? (
          <s-stack gap="base">
            <s-text-field
              label="Title"
              value={fileEdit.name}
              maxLength={200}
              details={`${fileEdit.chunkCount} chunk${fileEdit.chunkCount === 1 ? "" : "s"}`}
              onInput={(e) => setFileEdit({ ...fileEdit, name: e.currentTarget.value })}
            />
            <StatusSelect
              value={fileEdit.status}
              onChange={(status) => setFileEdit({ ...fileEdit, status })}
            />
          </s-stack>
        ) : null}
      </BrowseModalShell>

      {/* ── Edit lookup table modal (spec 28) ────────────────────────────── */}
      <BrowseModalShell
        open={tableEdit !== null}
        title="Edit lookup table"
        onClose={() => setTableEdit(null)}
        footer={
          tableEdit ? (
            <>
              {/* Left side: the file exactly as it was uploaded. */}
              <s-button
                icon="download"
                loading={downloading}
                disabled={downloading}
                onClick={() => downloadTableCsv(tableEdit.id)}
              >
                Download CSV
              </s-button>
              <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                <s-button onClick={() => setTableEdit(null)}>Cancel</s-button>
                <s-button
                  variant="primary"
                  disabled={
                    busy ||
                    !tableEdit.name.trim() ||
                    !tableEdit.description.trim() ||
                    Boolean(mappingProblem(tableEdit.columns.map((c) => c.role)))
                  }
                  loading={busy}
                  onClick={() =>
                    submit("source-update", {
                      id: tableEdit.id,
                      payload: JSON.stringify({
                        name: tableEdit.name,
                        description: tableEdit.description,
                        roles: Object.fromEntries(tableEdit.columns.map((c) => [c.key, c.role])),
                        status: tableEdit.status,
                      }),
                    })
                  }
                >
                  Save
                </s-button>
              </span>
            </>
          ) : null
        }
      >
        {tableEdit ? (
          <s-stack gap="base">
            <s-text-field
              label="Title"
              value={tableEdit.name}
              maxLength={200}
              details={`${tableEdit.rows.toLocaleString()} rows. To change the data, delete this table and upload the new file.`}
              onInput={(e) => setTableEdit({ ...tableEdit, name: e.currentTarget.value })}
            />
            <s-text-area
              label="What is this table for?"
              rows={2}
              maxLength={TABLE_DESCRIPTION_MAX}
              value={tableEdit.description}
              onInput={(e) =>
                setTableEdit({
                  ...tableEdit,
                  description: e.currentTarget.value,
                })
              }
            />
            <LookupTableMapping
              columns={tableEdit.columns}
              ranges={tableEdit.ranges}
              onChange={(key, role) =>
                setTableEdit({
                  ...tableEdit,
                  columns: tableEdit.columns.map((c) => (c.key === key ? { ...c, role } : c)),
                })
              }
            />
            <StatusSelect
              value={tableEdit.status}
              onChange={(status) => setTableEdit({ ...tableEdit, status })}
            />
          </s-stack>
        ) : null}
      </BrowseModalShell>

      {/* ── Connect policies modal (design #mPolicies) ───────────────────── */}
      <BrowseModalShell
        open={policiesOpen}
        title="Connect store policies"
        onClose={() => setPoliciesOpen(false)}
        footer={
          <span style={{ marginLeft: "auto" }}>
            <s-button onClick={() => setPoliciesOpen(false)}>Done</s-button>
          </span>
        }
      >
        {!policies ? (
          <s-box padding="large">
            <s-text tone="neutral">Loading your store policies…</s-text>
          </s-box>
        ) : (
          <s-stack gap="base">
            <s-heading>Your store policies</s-heading>
            <s-text tone="neutral">
              Turn a policy on to teach it to the AI — each one appears as its own source in Manage
              sources and refreshes weekly. Store pages are on the Pages tab.
            </s-text>
            <s-text tone="neutral">
              {policySelection.size} of {policies.candidates.length} policies connected
            </s-text>
            {policies.candidates.length === 0 ? (
              <s-text tone="neutral">
                No policies found — add them in your Shopify admin under Settings → Policies.
              </s-text>
            ) : (
              policies.candidates.map((candidate) => (
                <div
                  key={candidate.type}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 4px",
                    borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
                  }}
                >
                  <s-switch
                    label={`Connect ${candidate.title}`}
                    labelAccessibilityVisibility="exclusive"
                    checked={policySelection.has(candidate.type)}
                    disabled={busy}
                    onInput={(e) => {
                      const next = new Set(policySelection);
                      if (e.currentTarget.checked) next.add(candidate.type);
                      else next.delete(candidate.type);
                      setPolicySelection(next);
                      savePolicies(next);
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{candidate.title}</div>
                    {candidate.url ? (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--s-color-text-secondary, #9a9aa2)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {candidate.url}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </s-stack>
        )}
      </BrowseModalShell>

      <ConfirmDeleteModal
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.name || "this source"}?`}
        body="The AI stops using its content immediately. This can't be undone."
        loading={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && submit("source-delete", { id: deleteTarget.id })}
      />
    </s-stack>
  );
}

function StatusSelect(props: {
  value: "active" | "inactive";
  onChange: (value: "active" | "inactive") => void;
}) {
  return (
    <s-select
      label="Status"
      value={props.value}
      onInput={(e) => props.onChange(e.currentTarget.value === "inactive" ? "inactive" : "active")}
    >
      <s-option value="active">Active</s-option>
      <s-option value="inactive">Inactive</s-option>
    </s-select>
  );
}

function AddTile(props: {
  title: string;
  description: string;
  onClick: () => void;
  /** Plan required to use this source; non-null renders it locked. */
  lockedPlan?: string | null;
  children?: React.ReactNode;
}) {
  const locked = Boolean(props.lockedPlan);
  return (
    <s-clickable
      // Locked tiles still render — a source the merchant can't see is a
      // source they can never decide to pay for. The click is what's gated.
      onClick={locked ? () => {} : props.onClick}
      disabled={locked}
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
      accessibilityLabel={`${props.title} — ${props.description}${locked ? ` (requires the ${props.lockedPlan} plan)` : ""}`}
    >
      <s-stack gap="small-200" alignItems="start">
        <s-stack gap="small-500" alignItems="start">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">{props.title}</s-text>
            <PlanBadge plan={props.lockedPlan ?? null} />
          </s-stack>
          <s-text color="subdued">{props.description}</s-text>
        </s-stack>
        {props.children ? <s-box inlineSize="100%">{props.children}</s-box> : null}
      </s-stack>
    </s-clickable>
  );
}

import { useDateTime } from "../lib/format/context";
