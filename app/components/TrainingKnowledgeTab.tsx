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
import {
  LearnCard,
  StatusBadge,
  usePendingSources,
  useTrainingFetcher,
} from "./TrainingShared";

// Custom knowledge tab (spec 07, design #viewTraining → Custom knowledge):
// learn card, a paginated Manage sources table (one row per URL, file and
// policy) with a type-filter dropdown, and the three add-data
// entry points (URL source, Upload file, Connect policies) with quota meters. Manual Q&A and Import CSV moved to the FAQs
// tab (FAQ consolidation) — legacy manual/csv rows stay listed
// and deletable here, but nothing new of those types can be created.

// Legacy rows (manual / csv / combined pages) show under "All sources" only.
type SourceFilter = "all" | "url" | "file" | "policy";

const TYPE_LABEL: Record<string, string> = {
  url: "URL",
  file: "File",
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
  maxWidth: 360,
};

interface UrlDraft {
  id: string | null;
  /** The one URL — add and edit alike (one URL per entry). */
  url: string;
  reCrawlWeekly: boolean;
  status: "active" | "inactive";
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
  quotas: { crawlPages: Meter; fileUploads: Meter };
  /** Policies connected — there is no policy limit. */
  connectedPolicies: number;
  /** Plan gating for the add-data tiles (spec 15). Locked plan names are null
   *  when the current plan already includes the source; the *Next names are
   *  the plan that raises each quota, or null at the top tier. */
  planSignals: {
    fileUploadsNext: string | null;
    crawlPagesNext: string | null;
  };
}) {
  const dt = useDateTime();
  // Flip Pending → Active (or Error) without a page reload — every source type.
  usePendingSources(props.sources);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [urlDraft, setUrlDraft] = useState<UrlDraft | null>(null);
  const [fileOpen, setFileOpen] = useState(false);
  const [filePick, setFilePick] = useState<{ name: string; mime: string; dataBase64: string } | null>(null);
  const [fileError, setFileError] = useState("");
  // Required title — says what the file is in Manage sources.
  const [fileTitle, setFileTitle] = useState("");
  const [fileEdit, setFileEdit] = useState<FileEditDraft | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [policies, setPolicies] = useState<PoliciesPayload | null>(null);
  const [policySelection, setPolicySelection] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  // Last server-CONFIRMED policy selection — the revert target when an
  // optimistic toggle is rejected (QA D8). A ref, so it can't go stale
  // between a save and the next toggle.
  const confirmedPolicies = useRef<string[]>([]);
  const pendingPolicies = useRef<string[]>([]);

  const { submit, busy } = useTrainingFetcher((result: TrainingActionResult) => {
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
      setPolicies((prev) =>
        prev ? { ...prev, selectedTypes: pendingPolicies.current } : prev,
      );
      return;
    }
    switch (result.intent) {
      case "source-update":
        setUrlDraft(null);
        setFileEdit(null);
        break;
      case "source-add-url":
        setUrlDraft(null);
        break;
      case "source-add-file":
        setFileOpen(false);
        setFilePick(null);
        setFileTitle("");
        break;
    }
  });

  const rows =
    filter === "all" ? props.sources : props.sources.filter((s) => s.type === filter);

  const openPolicies = () => {
    setPolicies(null);
    setPoliciesOpen(true);
    submit("policies-list");
  };

  const savePolicies = (nextSelection: Set<string>) => {
    pendingPolicies.current = Array.from(nextSelection);
    submit("policies-save", { payload: JSON.stringify({ types: pendingPolicies.current }) });
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
    }
  };

  const onPickFile = (file: File | null) => {
    setFileError("");
    setFilePick(null);
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setFileError("File is too large — maximum size is 2MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      setFilePick({ name: file.name, mime: file.type, dataBase64: base64 });
      // Suggest the filename (minus extension) — the merchant can rewrite it.
      setFileTitle((current) => current || file.name.replace(/\.[^.]+$/, ""));
    };
    reader.readAsDataURL(file);
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
                setFilter(value === "url" || value === "file" || value === "policy" ? value : "all");
              }}
            >
              <s-option value="all">All sources</s-option>
              <s-option value="url">URL sources</s-option>
              <s-option value="file">Files</s-option>
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
                      <s-text tone="critical">
                        Removed in Shopify — nothing to learn. Delete this source.
                      </s-text>
                    ) : null}
                  </s-stack>
                ),
              },
              {
                key: "type",
                title: "Type",
                render: (source) => (
                  <s-badge tone="neutral">{TYPE_LABEL[source.type] ?? source.type}</s-badge>
                ),
              },
              {
                key: "chunks",
                title: "Learned",
                render: (source) => (
                  <s-text tone="neutral">
                    {source.chunkCount} chunk{source.chunkCount === 1 ? "" : "s"}
                  </s-text>
                ),
              },
              {
                key: "status",
                title: "Status",
                render: (source) => <StatusBadge status={source.status} error={source.error} />,
              },
              {
                key: "synced",
                title: "Last synced",
                render: (source) => (
                  <s-text tone="neutral">
                    {source.lastSyncedAt ? dt.dateTime(source.lastSyncedAt) : "—"}
                  </s-text>
                ),
              },
              {
                key: "actions",
                title: "Actions",
                align: "end",
                render: (source) => (
                  <s-stack direction="inline" gap="small-300" justifyContent="end">
                    {source.type === "url" || source.type === "file" ? (
                      <s-button variant="tertiary" onClick={() => openEdit(source)}>
                        Edit
                      </s-button>
                    ) : null}
                    {source.type === "url" || source.type === "policy" || source.type === "pages" ? (
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
              description="PDF, TXT, JSON — guides, catalogs, FAQs, Sizes."
              onClick={() => {
                setFilePick(null);
                setFileError("");
                setFileTitle("");
                setFileOpen(true);
              }}
            >
              <PlanMeter
                used={props.quotas.fileUploads.used}
                quota={props.quotas.fileUploads.quota}
                label="uploads"
                nextPlan={props.planSignals.fileUploadsNext}
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
                {props.connectedPolicies} polic{props.connectedPolicies === 1 ? "y" : "ies"} connected
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
              onInput={(e) => setUrlDraft({ ...urlDraft, reCrawlWeekly: e.currentTarget.checked })}
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
              disabled={busy || !filePick || !fileTitle.trim()}
              loading={busy}
              onClick={() =>
                filePick &&
                submit("source-add-file", {
                  payload: JSON.stringify({ ...filePick, title: fileTitle.trim() }),
                })
              }
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
              accept=".pdf,.txt,.json,application/pdf"
              aria-label="Choose a file"
              onChange={(e) => onPickFile(e.currentTarget.files?.[0] ?? null)}
            />
            {filePick ? <s-paragraph>Selected: {filePick.name}</s-paragraph> : null}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.9 }}>
            <li>Supported formats: .pdf, .txt, .json</li>
            <li>
              PDFs are read from their text layer — scanned or image-only PDFs (and tables inside
              images) can&apos;t be learned
            </li>
            <li>.docx isn&apos;t supported — save it as a PDF first</li>
            <li>Maximum file size: 2MB</li>
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
                    payload: JSON.stringify({ name: fileEdit.name, status: fileEdit.status }),
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
              Turn a policy on to teach it to the AI — each one appears as its own source in
              Manage sources and refreshes weekly. Store pages are on the Pages tab.
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
      onInput={(e) =>
        props.onChange(e.currentTarget.value === "inactive" ? "inactive" : "active")
      }
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