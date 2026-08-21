import { useEffect, useRef, useState } from "react";
import type {
  Meter,
  PoliciesPayload,
  SourceRow,
  TrainingActionResult,
} from "../routes/app.ai-agent.training";
import { BrowseModalShell } from "./BrowseProductsModal";
import { ChipInput } from "./ChipInput";
import { QuotaMeter } from "./QuotaMeter";
import { EmptyState } from "./ui/EmptyState";
import {
  LearnCard,
  StatusBadge,
  SubTabs,
  downloadText,
  useTrainingFetcher,
} from "./TrainingShared";

// Custom knowledge tab (spec 07, design #viewTraining → Custom knowledge):
// learn card, suggested-Q&A review banner, sources table with type filters +
// type-specific edit modals, and the five add-data entry points (Website URL,
// Manual Q&A, Import CSV, Upload file, Connect policies) with quota meters.

type SourceFilter = "all" | "url" | "manual" | "csv" | "file" | "pages";

const SAMPLE_CSV = [
  "question,answer",
  "What is your return policy?,You can return any item within 30 days of delivery for a full refund.",
  "Do you ship internationally?,Yes — we ship worldwide. International orders arrive in 7–14 business days.",
  "How do I track my order?,Use the tracking link in your shipping confirmation email.",
].join("\n");

const TYPE_LABEL: Record<string, string> = {
  url: "URL",
  manual: "Manual",
  csv: "CSV",
  file: "File",
  pages: "Pages",
};

interface QaDraft {
  id: string | null;
  question: string;
  synonyms: string[];
  answer: string;
  status: "active" | "inactive";
  unresolvedId?: string;
}

interface UrlDraft {
  id: string | null;
  url: string;
  crawlScope: "page" | "linked" | "sitemap";
  reCrawlWeekly: boolean;
  status: "active" | "inactive";
}

interface CsvDraft {
  id: string | null;
  csvText: string;
  fileName: string;
}

interface FileEditDraft {
  id: string;
  name: string;
  chunkCount: number;
  status: "active" | "inactive";
}

export function TrainingKnowledgeTab(props: {
  sources: SourceRow[];
  suggested: { id: string; question: string; answer: string; createdAt: string }[];
  chunkTotal: number;
  quotas: { crawlPages: Meter; manualQas: Meter; fileUploads: Meter; policyPages: Meter };
  csvRowCap: number;
  prefillQuestion: string;
  prefillUnresolvedId: string;
}) {
  const dt = useDateTime();
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [qaDraft, setQaDraft] = useState<QaDraft | null>(null);
  const [urlDraft, setUrlDraft] = useState<UrlDraft | null>(null);
  const [csvDraft, setCsvDraft] = useState<CsvDraft | null>(null);
  const [fileOpen, setFileOpen] = useState(false);
  const [filePick, setFilePick] = useState<{ name: string; mime: string; dataBase64: string } | null>(null);
  const [fileError, setFileError] = useState("");
  const [fileEdit, setFileEdit] = useState<FileEditDraft | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [policies, setPolicies] = useState<PoliciesPayload | null>(null);
  const [policySelection, setPolicySelection] = useState<Set<string>>(new Set());
  const [deleteId, setDeleteId] = useState<string | null>(null);

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
      case "source-add-manual":
      case "source-update":
        setQaDraft(null);
        setUrlDraft(null);
        setCsvDraft(null);
        setFileEdit(null);
        break;
      case "source-add-url":
        setUrlDraft(null);
        break;
      case "source-add-csv":
        setCsvDraft(null);
        break;
      case "source-add-file":
        setFileOpen(false);
        setFilePick(null);
        break;
      case "source-delete":
        setDeleteId(null);
        break;
    }
  });

  // "Add as Q&A" prefill from the review queue.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !props.prefillQuestion) return;
    prefilled.current = true;
    setQaDraft({
      id: null,
      question: props.prefillQuestion,
      synonyms: [],
      answer: "",
      status: "active",
      unresolvedId: props.prefillUnresolvedId || undefined,
    });
  }, [props.prefillQuestion, props.prefillUnresolvedId]);

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

  const openEdit = (source: SourceRow) => {
    switch (source.type) {
      case "manual":
        setQaDraft({
          id: source.id,
          question: source.question || source.name,
          synonyms: source.synonyms,
          answer: source.answer,
          status: source.status === "inactive" ? "inactive" : "active",
        });
        break;
      case "csv":
        setCsvDraft({ id: source.id, csvText: source.csvText, fileName: "" });
        break;
      case "url":
        setUrlDraft({
          id: source.id,
          url: source.url ?? source.name,
          crawlScope:
            source.crawlScope === "linked" || source.crawlScope === "sitemap"
              ? source.crawlScope
              : "page",
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
    };
    reader.readAsDataURL(file);
  };

  const onPickCsvFile = (file: File | null, draft: CsvDraft) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () =>
      setCsvDraft({ ...draft, csvText: String(reader.result ?? ""), fileName: file.name });
    reader.readAsText(file);
  };

  return (
    <s-stack gap="base">
      <LearnCard
        title="Custom knowledge"
        chip={`${props.chunkTotal} items learned`}
        description="Train your AI with custom Q&As, website URLs, and files for more accurate and personalized responses."
      />

      {props.suggested.length > 0 ? (
        <s-banner
          tone="info"
          heading={`${props.suggested.length} suggested Q&A${props.suggested.length === 1 ? "" : "s"} waiting for review`}
        >
          <s-paragraph>
            We generated {props.suggested.length} Q&A{props.suggested.length === 1 ? "" : "s"} from
            your store data. Review and add them to improve AI accuracy.
          </s-paragraph>
          <s-button onClick={() => setReviewOpen((v) => !v)}>
            {reviewOpen ? "Hide suggestions" : "Review now"}
          </s-button>
          {reviewOpen ? (
            <s-stack gap="small">
              {props.suggested.map((s) => (
                <s-box key={s.id} padding="small" borderWidth="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text>{s.question}</s-text>
                    <s-text tone="neutral">{s.answer}</s-text>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-button
                        variant="primary"
                        disabled={busy}
                        onClick={() => submit("suggested-approve", { id: s.id })}
                      >
                        Approve
                      </s-button>
                      <s-button
                        disabled={busy}
                        onClick={() => submit("suggested-dismiss", { id: s.id })}
                      >
                        Dismiss
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          ) : null}
        </s-banner>
      ) : null}

      <s-section heading="Manage data">
        <s-stack gap="base">
          <s-paragraph color="subdued">What the assistant knows. Knowledge is indexed when you add it.</s-paragraph>
          <SubTabs
            tabs={[
              { id: "all", label: "All" },
              { id: "url", label: "URL" },
              { id: "manual", label: "Manual" },
              { id: "csv", label: "CSV" },
              { id: "file", label: "File" },
              { id: "pages", label: "Pages" },
            ]}
            active={filter}
            onChange={setFilter}
          />

          {rows.length === 0 ? (
            <EmptyState
              icon="database-add"
              compact
              title={filter === "all" ? "No data sources yet" : "No sources of this type"}
              description={
                filter === "all"
                  ? "Add a website URL, a manual Q&A, a CSV or a file below."
                  : "Switch to All to see every source."
              }
            />
          ) : (
            <s-table>
              <s-table-header-row>
                {["Source", "Type", "Status", "Last synced", "Actions"].map((h, i) => (
                  <s-table-header key={h} format={i === 4 ? "numeric" : "base"}>
                    {h}
                  </s-table-header>
                ))}
              </s-table-header-row>
              <s-table-body>
                {rows.map((source) => (
                  <s-table-row key={source.id}>
                    <s-table-cell>
                      <s-stack gap="small-500">
                        <s-text type="strong">{source.name}</s-text>
                        <s-text color="subdued">
                          {source.chunkCount} chunk{source.chunkCount === 1 ? "" : "s"}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone="neutral">{TYPE_LABEL[source.type] ?? source.type}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <StatusBadge status={source.status} error={source.error} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-text tone="neutral">
                        {source.lastSyncedAt ? dt.dateTime(source.lastSyncedAt) : "—"}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-300" justifyContent="end">
                      <s-button variant="tertiary" onClick={() => openEdit(source)}>
                        Edit
                      </s-button>
                      {source.type === "url" || source.type === "pages" ? (
                        <s-button
                          variant="tertiary"
                          disabled={busy}
                          onClick={() => submit("source-resync", { id: source.id })}
                        >
                          Re-sync
                        </s-button>
                      ) : null}
                      {deleteId === source.id ? (
                        <>
                          <s-button
                            variant="primary"
                            tone="critical"
                            disabled={busy}
                            onClick={() => submit("source-delete", { id: source.id })}
                          >
                            Confirm
                          </s-button>
                          <s-button variant="tertiary" onClick={() => setDeleteId(null)}>
                            Keep
                          </s-button>
                        </>
                      ) : (
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() => setDeleteId(source.id)}
                        >
                          Delete
                        </s-button>
                      )}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          <s-text color="subdued">
            Re-sync re-reads a source and rebuilds its chunks — use it after your website content
            changes.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Add data">
        <s-stack gap="base">
          <s-paragraph color="subdued">Choose how to feed the assistant — pick any option.</s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="small-200">
            <AddTile
              title="Website URL"
              description="Crawl pages from your site"
              onClick={() =>
                setUrlDraft({
                  id: null,
                  url: "",
                  crawlScope: "page",
                  reCrawlWeekly: false,
                  status: "active",
                })
              }
            >
              <QuotaMeter
                used={props.quotas.crawlPages.used}
                quota={props.quotas.crawlPages.quota}
                label="pages used"
              />
            </AddTile>
            <AddTile
              title="Manual Q&A"
              description="Write your own answer"
              onClick={() =>
                setQaDraft({ id: null, question: "", synonyms: [], answer: "", status: "active" })
              }
            >
              <QuotaMeter
                used={props.quotas.manualQas.used}
                quota={props.quotas.manualQas.quota}
                label="used"
              />
            </AddTile>
            <AddTile
              title="Import CSV"
              description="Bulk add Q&As"
              onClick={() => setCsvDraft({ id: null, csvText: "", fileName: "" })}
            >
              <s-text color="subdued">Up to {props.csvRowCap} Q&A rows per file</s-text>
            </AddTile>
            <AddTile
              title="Upload file"
              description="TXT, JSON — guides, catalogs, FAQs (PDF/DOCX coming soon)"
              onClick={() => {
                setFilePick(null);
                setFileError("");
                setFileOpen(true);
              }}
            >
              <QuotaMeter
                used={props.quotas.fileUploads.used}
                quota={props.quotas.fileUploads.quota}
                label="used"
              />
            </AddTile>
          </s-grid>
          <AddTile
            wide
            title="Connect policies and pages"
            description="Shipping, returns, FAQ pages etc."
            onClick={openPolicies}
          >
            <QuotaMeter
              used={props.quotas.policyPages.used}
              quota={props.quotas.policyPages.quota}
              label="pages used"
            />
          </AddTile>
        </s-stack>
      </s-section>

      {/* ── Website URL modal (design #mSource) ──────────────────────────── */}
      <BrowseModalShell
        open={urlDraft !== null}
        title="Source URL"
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
                  const payload = JSON.stringify({
                    url: urlDraft.url,
                    crawlScope: urlDraft.crawlScope,
                    reCrawlWeekly: urlDraft.reCrawlWeekly,
                    status: urlDraft.status,
                  });
                  if (urlDraft.id) submit("source-update", { id: urlDraft.id, payload });
                  else submit("source-add-url", { payload });
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
              label="Website URL"
              placeholder="https://your-store.com/pages/faq"
              value={urlDraft.url}
              onInput={(e) => setUrlDraft({ ...urlDraft, url: e.currentTarget.value })}
            />
            <s-text tone="neutral">
              Paste a page from your store. We fetch it, strip it to text, and index it.
            </s-text>
            <s-choice-list
              label="What to crawl"
              name="crawl-scope"
              values={[urlDraft.crawlScope]}
              onChange={(e) => {
                const value = e.currentTarget.values[0];
                setUrlDraft({
                  ...urlDraft,
                  crawlScope: value === "linked" || value === "sitemap" ? value : "page",
                });
              }}
            >
              <s-choice value="page">
                This page only
                <s-text slot="details">Fastest. Just the URL above.</s-text>
              </s-choice>
              <s-choice value="linked">
                This page + linked pages
                <s-text slot="details">
                  Also follows same-site links from this page (up to {props.quotas.crawlPages.quota}{" "}
                  pages).
                </s-text>
              </s-choice>
              <s-choice value="sitemap">
                Entire site (via sitemap)
                <s-text slot="details">
                  Reads your site&apos;s sitemap.xml (up to {props.quotas.crawlPages.quota} pages).
                </s-text>
              </s-choice>
            </s-choice-list>
            <s-checkbox
              label="Re-crawl weekly — keep knowledge fresh as your site changes"
              checked={urlDraft.reCrawlWeekly}
              onChange={(e) => setUrlDraft({ ...urlDraft, reCrawlWeekly: e.currentTarget.checked })}
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

      {/* ── Manual Q&A modal (design #mQA) ───────────────────────────────── */}
      <BrowseModalShell
        open={qaDraft !== null}
        title="Question & answer"
        onClose={() => setQaDraft(null)}
        footer={
          qaDraft ? (
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
              <s-button onClick={() => setQaDraft(null)}>Cancel</s-button>
              <s-button
                variant="primary"
                disabled={busy || !qaDraft.question.trim() || !qaDraft.answer.trim()}
                loading={busy}
                onClick={() => {
                  const payload = JSON.stringify({
                    question: qaDraft.question,
                    synonyms: qaDraft.synonyms,
                    answer: qaDraft.answer,
                    status: qaDraft.status,
                    unresolvedId: qaDraft.unresolvedId,
                  });
                  if (qaDraft.id) submit("source-update", { id: qaDraft.id, payload });
                  else submit("source-add-manual", { payload });
                }}
              >
                Save
              </s-button>
            </span>
          ) : null
        }
      >
        {qaDraft ? (
          <s-stack gap="base">
            <s-text-field
              label="When a shopper asks…"
              placeholder="e.g. Do you offer gift wrapping?"
              value={qaDraft.question}
              maxLength={500}
              onInput={(e) => setQaDraft({ ...qaDraft, question: e.currentTarget.value })}
            />
            <s-text tone="neutral">
              Add a few phrasings below so the assistant matches more questions.
            </s-text>
            <ChipInput
              label="Also matches (synonyms)"
              values={qaDraft.synonyms}
              placeholder="e.g. gift wrap"
              onChange={(synonyms) => setQaDraft({ ...qaDraft, synonyms })}
            />
            <s-text-area
              label="Answer"
              rows={4}
              placeholder="e.g. Yes — add gift wrapping at checkout."
              value={qaDraft.answer}
              maxLength={10000}
              onInput={(e) => setQaDraft({ ...qaDraft, answer: e.currentTarget.value })}
            />
            <StatusSelect
              value={qaDraft.status}
              onChange={(status) => setQaDraft({ ...qaDraft, status })}
            />
          </s-stack>
        ) : null}
      </BrowseModalShell>

      {/* ── CSV modal (design #mUploadCSV / #mCSV) ───────────────────────── */}
      <BrowseModalShell
        open={csvDraft !== null}
        title={csvDraft?.id ? "CSV content" : "Import CSV"}
        onClose={() => setCsvDraft(null)}
        footer={
          csvDraft ? (
            <>
              {!csvDraft.id ? (
                <s-button
                  variant="tertiary"
                  onClick={() => downloadText("knowledge-sample.csv", SAMPLE_CSV)}
                >
                  Download a sample CSV
                </s-button>
              ) : null}
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
              <s-button onClick={() => setCsvDraft(null)}>Cancel</s-button>
              <s-button
                variant="primary"
                disabled={busy || !csvDraft.csvText.trim()}
                loading={busy}
                onClick={() => {
                  const payload = JSON.stringify({
                    csvText: csvDraft.csvText,
                    name: csvDraft.fileName || undefined,
                  });
                  if (csvDraft.id) submit("source-update", { id: csvDraft.id, payload });
                  else submit("source-add-csv", { payload });
                }}
              >
                {csvDraft.id ? "Save" : "Import"}
              </s-button>
            </span>
            </>
          ) : null
        }
      >
        {csvDraft ? (
          <s-stack gap="base">
            <s-text tone="neutral">
              question,answer per row — a header row is optional (columns are auto-detected). Up to{" "}
              {props.csvRowCap} rows per file.
            </s-text>
            {!csvDraft.id ? (
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Choose a CSV file"
                onChange={(e) => onPickCsvFile(e.currentTarget.files?.[0] ?? null, csvDraft)}
              />
            ) : null}
            <textarea
              aria-label="CSV content"
              rows={10}
              value={csvDraft.csvText}
              onChange={(e) => setCsvDraft({ ...csvDraft, csvText: e.currentTarget.value })}
              placeholder={"What is your return policy?,You can return any item within 30 days."}
              style={{
                width: "100%",
                boxSizing: "border-box",
                fontFamily: "ui-monospace, Menlo, monospace",
                fontSize: 12.5,
                padding: 10,
                borderRadius: 9,
                border: "1px solid var(--s-color-border, #d4d4d4)",
              }}
            />
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
              disabled={busy || !filePick}
              loading={busy}
              onClick={() =>
                filePick && submit("source-add-file", { payload: JSON.stringify(filePick) })
              }
            >
              Add
            </s-button>
          </span>
        }
      >
        <s-stack gap="base">
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
              accept=".txt,.json"
              aria-label="Choose a file"
              onChange={(e) => onPickFile(e.currentTarget.files?.[0] ?? null)}
            />
            {filePick ? <s-paragraph>Selected: {filePick.name}</s-paragraph> : null}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.9 }}>
            <li>Supported formats today: .txt, .json</li>
            <li>.pdf and .docx aren&apos;t supported yet — the parser is still pending</li>
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
              label="File"
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
        title="Connect store policies and pages"
        onClose={() => setPoliciesOpen(false)}
        footer={
          <span style={{ marginLeft: "auto" }}>
            <s-button onClick={() => setPoliciesOpen(false)}>Done</s-button>
          </span>
        }
      >
        {!policies ? (
          <s-box padding="large">
            <s-text tone="neutral">Loading your store policies and pages…</s-text>
          </s-box>
        ) : (
          <s-stack gap="base">
            <s-heading>Your store pages</s-heading>
            <s-text tone="neutral">
              We found these pages in your Shopify store. Turn a page on to import it for FAQ
              answers — it&apos;s indexed right away; turn it off to remove it.
            </s-text>
            <s-text tone="neutral">
              {policySelection.size} of {policies.quota} pages used
            </s-text>
            {policies.candidates.length === 0 ? (
              <s-text tone="neutral">
                No pages found — add policies or Online Store pages in your Shopify admin first.
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
                    onChange={(e) => {
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
                  <s-badge tone="neutral">{candidate.kind === "page" ? "Page" : "Policy"}</s-badge>
                </div>
              ))
            )}
          </s-stack>
        )}
      </BrowseModalShell>
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
      onChange={(e) =>
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
  wide?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <s-clickable
      onClick={props.onClick}
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
      accessibilityLabel={`${props.title} — ${props.description}`}
    >
      <s-stack gap="small-200" alignItems={props.wide ? "center" : "start"}>
        <s-stack gap="small-500" alignItems={props.wide ? "center" : "start"}>
          <s-text type="strong">{props.title}</s-text>
          <s-text color="subdued">{props.description}</s-text>
        </s-stack>
        {props.children ? <s-box inlineSize="100%">{props.children}</s-box> : null}
      </s-stack>
    </s-clickable>
  );
}

import { useDateTime } from "../lib/format/context";