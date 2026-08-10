import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { FaqCategoryData, FaqRowData } from "../lib/faq/faq.server";
import type { TrainingActionResult } from "../routes/app.ai-agent.training";
import { BrowseModalShell } from "./BrowseProductsModal";
import { downloadText, useTrainingFetcher } from "./TrainingShared";

// FAQs tab (spec 07, design #viewTraining → FAQs): toolbar (import / export /
// add FAQ / add category), search + Status/Featured filters, category tree
// with per-row featured stars and up/down reorder, category + FAQ modals.
// Answers are stored as sanitized HTML (rich-text editor deferred — textarea
// v1, same delta as spec 06 starter answers).

const ICON_PRESETS = ["🛒", "🔁", "💳", "🚚", "📄", "❓"];

// Row hover elevation (design faq.png — Chatty-style): inline styles can't
// express :hover, so the table ships a tiny scoped stylesheet instead.
const TABLE_CSS = `
.ccfaq-row {
  position: relative;
  transition: box-shadow .15s ease, background-color .15s ease;
}
.ccfaq-row:hover {
  background: var(--s-color-bg-surface-hover, #fafafa);
  box-shadow: 0 2px 10px rgba(26, 26, 26, .14);
  z-index: 1;
}
`;

const SAMPLE_CSV = [
  "question,answer",
  "What is your return policy?,You can return any item within 30 days of delivery for a full refund.",
  "Do you ship internationally?,Yes — we ship worldwide. International orders arrive in 7–14 business days.",
  "How do I track my order?,Once your order ships we email you a tracking link.",
].join("\r\n");

interface FaqDraft {
  id: string | null;
  question: string;
  answerHtml: string;
  status: "published" | "draft";
  categoryId: string;
  featured: boolean;
  unresolvedId?: string;
}

type DragItem = { kind: "category"; id: string } | { kind: "faq"; id: string };
type DropEdge = "before" | "after" | "into";

interface CategoryDraft {
  id: string | null;
  name: string;
  icon: string;
  position: number; // 1-based
  status: "published" | "draft";
  featured: boolean;
  isDefault: boolean;
}

export function FaqManager(props: {
  tree: FaqCategoryData[];
  prefillQuestion: string;
  prefillUnresolvedId: string;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "published" | "draft">("");
  const [featuredFilter, setFeaturedFilter] = useState<"" | "yes" | "no">("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [faqDraft, setFaqDraft] = useState<FaqDraft | null>(null);
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importCsv, setImportCsv] = useState<{ name: string; text: string } | null>(null);
  const [importError, setImportError] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"all" | "published">("all");

  const defaultCategoryId =
    props.tree.find((c) => c.isDefault)?.id ?? props.tree[0]?.id ?? "";

  const { submit, busy, pendingIntent } = useTrainingFetcher((result: TrainingActionResult) => {
    if (!result.ok) return;
    switch (result.intent) {
      case "faq-save":
      case "faq-delete":
        setFaqDraft(null);
        setConfirmDelete(false);
        break;
      case "category-save":
        setCategoryDraft(null);
        break;
      case "faq-import":
        setImportOpen(false);
        setImportCsv(null);
        break;
      case "faq-export":
        if (result.csv !== undefined) downloadText(result.filename ?? "faqs.csv", result.csv);
        setExportOpen(false);
        break;
    }
  });

  // "Add as FAQ" prefill from the review queue (spec 07 review actions).
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !props.prefillQuestion || !defaultCategoryId) return;
    prefilled.current = true;
    setFaqDraft({
      id: null,
      question: props.prefillQuestion,
      answerHtml: "",
      status: "draft",
      categoryId: defaultCategoryId,
      featured: false,
      unresolvedId: props.prefillUnresolvedId || undefined,
    });
  }, [props.prefillQuestion, props.prefillUnresolvedId, defaultCategoryId]);

  // Deferred so typing in the search field never blocks on re-filtering the
  // tree (Polaris-smooth search; React keeps the input responsive).
  const deferredSearch = useDeferredValue(search);
  const query = deferredSearch.trim().toLowerCase();
  const anyFilter = Boolean(query || statusFilter || featuredFilter);
  const faqPasses = (faq: FaqRowData) => {
    if (statusFilter && faq.status !== statusFilter) return false;
    if (featuredFilter && faq.featured !== (featuredFilter === "yes")) return false;
    if (query && !faq.question.toLowerCase().includes(query)) return false;
    return true;
  };

  const visibleTree = props.tree
    .map((category) => ({ category, faqs: category.faqs.filter(faqPasses) }))
    .filter(
      ({ category, faqs }) =>
        !anyFilter || faqs.length > 0 || (query && category.name.toLowerCase().includes(query)),
    );

  // ── Drag-and-drop reorder (design faq.png) ────────────────────────────────
  // Categories reorder among themselves; FAQs reorder within/across categories
  // (dropping on a category header appends to it). Disabled while a filter is
  // active (row indexes would be ambiguous) or a mutation is in flight. Drag
  // handles stay keyboard-accessible via ArrowUp/ArrowDown → the move intents.
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [dropHint, setDropHint] = useState<{ key: string; edge: DropEdge } | null>(null);
  const dragEnabled = !anyFilter && !busy;

  const edgeFor = (e: React.DragEvent<HTMLElement>): "before" | "after" => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const clearDrag = () => {
    setDragging(null);
    setDropHint(null);
  };

  const dropCategoryOnCategory = (targetId: string, edge: "before" | "after") => {
    if (!dragging || dragging.kind !== "category" || dragging.id === targetId) return;
    const without = props.tree.filter((c) => c.id !== dragging.id);
    const index = without.findIndex((c) => c.id === targetId);
    if (index < 0) return;
    const insert = edge === "before" ? index : index + 1;
    submit("category-place", { id: dragging.id, position: String(insert + 1) });
  };

  const dropFaqOnFaq = (categoryId: string, targetFaqId: string, edge: "before" | "after") => {
    if (!dragging || dragging.kind !== "faq" || dragging.id === targetFaqId) return;
    const category = props.tree.find((c) => c.id === categoryId);
    if (!category) return;
    const without = category.faqs.filter((f) => f.id !== dragging.id);
    const index = without.findIndex((f) => f.id === targetFaqId);
    if (index < 0) return;
    submit("faq-place", {
      id: dragging.id,
      categoryId,
      position: String(edge === "before" ? index : index + 1),
    });
  };

  const dropFaqOnCategory = (categoryId: string) => {
    if (!dragging || dragging.kind !== "faq") return;
    const category = props.tree.find((c) => c.id === categoryId);
    if (!category) return;
    submit("faq-place", {
      id: dragging.id,
      categoryId,
      position: String(category.faqs.filter((f) => f.id !== dragging.id).length),
    });
  };

  const openAddFaq = (categoryId?: string) =>
    setFaqDraft({
      id: null,
      question: "",
      answerHtml: "",
      status: "draft",
      categoryId: categoryId ?? defaultCategoryId,
      featured: false,
    });

  const openEditFaq = (faq: FaqRowData, categoryId: string) => {
    setConfirmDelete(false);
    setFaqDraft({
      id: faq.id,
      question: faq.question,
      answerHtml: faq.answerHtml,
      status: faq.status === "published" ? "published" : "draft",
      categoryId,
      featured: faq.featured,
    });
  };

  const openAddCategory = () =>
    setCategoryDraft({
      id: null,
      name: "",
      icon: "📄",
      position: props.tree.length + 1,
      status: "published",
      featured: false,
      isDefault: false,
    });

  const openEditCategory = (category: FaqCategoryData) =>
    setCategoryDraft({
      id: category.id,
      name: category.name,
      icon: category.icon,
      position: props.tree.findIndex((c) => c.id === category.id) + 1,
      status: category.status === "draft" ? "draft" : "published",
      featured: category.featured,
      isDefault: category.isDefault,
    });

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onImportFile = (file: File | null) => {
    setImportError("");
    setImportCsv(null);
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setImportError("File is too large — maximum size is 1MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImportCsv({ name: file.name, text: String(reader.result ?? "") });
    reader.readAsText(file);
  };

  return (
    <s-section heading="Manage FAQs">
      <s-stack gap="base">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <s-paragraph>
              Create and publish FAQs to build your FAQs page or provide knowledge for training
              the AI agent.
            </s-paragraph>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <s-button commandFor="faq-more-actions-menu">More actions</s-button>
            <s-menu id="faq-more-actions-menu" accessibilityLabel="More actions">
              <s-button icon="import" onClick={() => setImportOpen(true)}>
                Import CSV
              </s-button>
              <s-button icon="export" onClick={() => setExportOpen(true)}>
                Export
              </s-button>
            </s-menu>
            <s-button variant="primary" commandFor="faq-add-new-menu">
              Add new
            </s-button>
            <s-menu id="faq-add-new-menu" accessibilityLabel="Add new">
              <s-button icon="plus" onClick={() => openAddFaq()}>
                Add FAQ
              </s-button>
              <s-button icon="plus" onClick={openAddCategory}>
                Add category
              </s-button>
            </s-menu>
          </div>
        </div>

        <s-search-field
          label="Search FAQs"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search all categories and FAQs"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <s-clickable-chip
            commandFor="faq-status-filter"
            accessibilityLabel="Filter by status"
            color={statusFilter ? "strong" : "base"}
            removable={Boolean(statusFilter)}
            onRemove={() => setStatusFilter("")}
          >
            {statusFilter ? `Status: ${statusFilter === "published" ? "Published" : "Draft"}` : "Status"}
          </s-clickable-chip>
          <s-popover id="faq-status-filter">
            <s-box padding="base" minInlineSize="180px">
              <s-choice-list
                label="Status"
                labelAccessibilityVisibility="exclusive"
                name="faq-status-filter-choice"
                values={[statusFilter || "all"]}
                onChange={(e) => {
                  const v = e.currentTarget.values[0];
                  setStatusFilter(v === "published" || v === "draft" ? v : "");
                }}
              >
                <s-choice value="all">All</s-choice>
                <s-choice value="published">Published</s-choice>
                <s-choice value="draft">Draft</s-choice>
              </s-choice-list>
            </s-box>
          </s-popover>
          <s-clickable-chip
            commandFor="faq-featured-filter"
            accessibilityLabel="Filter by featured"
            color={featuredFilter ? "strong" : "base"}
            removable={Boolean(featuredFilter)}
            onRemove={() => setFeaturedFilter("")}
          >
            {featuredFilter
              ? `Featured: ${featuredFilter === "yes" ? "Yes" : "No"}`
              : "Featured"}
          </s-clickable-chip>
          <s-popover id="faq-featured-filter">
            <s-box padding="base" minInlineSize="180px">
              <s-choice-list
                label="Featured"
                labelAccessibilityVisibility="exclusive"
                name="faq-featured-filter-choice"
                values={[featuredFilter || "all"]}
                onChange={(e) => {
                  const v = e.currentTarget.values[0];
                  setFeaturedFilter(v === "yes" || v === "no" ? v : "");
                }}
              >
                <s-choice value="all">All</s-choice>
                <s-choice value="yes">Featured</s-choice>
                <s-choice value="no">Not featured</s-choice>
              </s-choice-list>
            </s-box>
          </s-popover>
        </div>

        <style>{TABLE_CSS}</style>
        <div
          style={{
            border: "1px solid var(--s-color-border, #e3e3e3)",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) 140px 110px",
            gap: 12,
            padding: "10px 14px",
            background: "var(--s-color-bg-surface-secondary, #fafafa)",
            borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--s-color-text-secondary, #616161)",
          }}
        >
          <span>FAQs</span>
          <span style={{ textAlign: "center" }}>Status</span>
          <span style={{ textAlign: "center" }}>Featured</span>
        </div>

        {visibleTree.length === 0 ? (
          <s-box padding="large">
            <s-text tone="neutral">No FAQs match your filters.</s-text>
          </s-box>
        ) : (
          visibleTree.map(({ category, faqs }, categoryIndex) => (
            <div
              key={category.id}
              style={{
                borderTop: categoryIndex === 0 ? "none" : "1px solid var(--s-color-border, #e3e3e3)",
              }}
            >
              <TreeRow
                main={
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <button
                      type="button"
                      aria-label={collapsed.has(category.id) ? "Expand category" : "Collapse category"}
                      onClick={() => toggleCollapsed(category.id)}
                      style={chevronStyle}
                    >
                      <s-icon
                        type={collapsed.has(category.id) ? "chevron-right" : "chevron-down"}
                        size="small"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditCategory(category)}
                      style={{ ...linkButtonStyle, fontWeight: 700 }}
                    >
                      {category.icon} {category.name}
                    </button>
                    <s-text tone="neutral">({faqs.length} FAQs)</s-text>
                    {category.isDefault ? <s-badge tone="neutral">Default</s-badge> : null}
                  </span>
                }
                status={category.status}
                featured={category.featured}
                onFeature={(next) =>
                  submit("category-feature", { id: category.id, featured: String(next) })
                }
                onKeyMove={(direction) =>
                  submit("category-move", { id: category.id, direction })
                }
                busy={busy}
                drag={{
                  enabled: dragEnabled,
                  isSource: dragging?.kind === "category" && dragging.id === category.id,
                  edge: dropHint?.key === `cat:${category.id}` ? dropHint.edge : null,
                  onDragStart: (e) => {
                    setDragging({ kind: "category", id: category.id });
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", category.id);
                  },
                  onDragOver: (e) => {
                    if (!dragging) return;
                    if (dragging.kind === "category" && dragging.id === category.id) return;
                    e.preventDefault();
                    setDropHint({
                      key: `cat:${category.id}`,
                      edge: dragging.kind === "category" ? edgeFor(e) : "into",
                    });
                  },
                  onDragLeave: () =>
                    setDropHint((h) => (h?.key === `cat:${category.id}` ? null : h)),
                  onDrop: (e) => {
                    e.preventDefault();
                    if (dragging?.kind === "category") {
                      dropCategoryOnCategory(category.id, edgeFor(e));
                    } else {
                      dropFaqOnCategory(category.id);
                    }
                    clearDrag();
                  },
                  onDragEnd: clearDrag,
                }}
              />
              {!collapsed.has(category.id) ? (
                <div>
                  {faqs.map((faq) => (
                    <TreeRow
                      key={faq.id}
                      indent
                      main={
                        <button
                          type="button"
                          onClick={() => openEditFaq(faq, category.id)}
                          style={linkButtonStyle}
                        >
                          {faq.question}
                        </button>
                      }
                      status={faq.status}
                      featured={faq.featured}
                      onFeature={(next) =>
                        submit("faq-feature", { id: faq.id, featured: String(next) })
                      }
                      onKeyMove={(direction) => submit("faq-move", { id: faq.id, direction })}
                      busy={busy}
                      drag={{
                        enabled: dragEnabled,
                        isSource: dragging?.kind === "faq" && dragging.id === faq.id,
                        edge: dropHint?.key === `faq:${faq.id}` ? dropHint.edge : null,
                        onDragStart: (e) => {
                          setDragging({ kind: "faq", id: faq.id });
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", faq.id);
                        },
                        onDragOver: (e) => {
                          if (dragging?.kind !== "faq" || dragging.id === faq.id) return;
                          e.preventDefault();
                          setDropHint({ key: `faq:${faq.id}`, edge: edgeFor(e) });
                        },
                        onDragLeave: () =>
                          setDropHint((h) => (h?.key === `faq:${faq.id}` ? null : h)),
                        onDrop: (e) => {
                          e.preventDefault();
                          dropFaqOnFaq(category.id, faq.id, edgeFor(e));
                          clearDrag();
                        },
                        onDragEnd: clearDrag,
                      }}
                    />
                  ))}
                  <div
                    style={{
                      padding: "8px 14px 12px 34px",
                      borderTop: "1px solid var(--s-color-border-secondary, #f1f1f1)",
                    }}
                  >
                    <s-button variant="tertiary" onClick={() => openAddFaq(category.id)}>
                      + Add FAQ
                    </s-button>
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}
        </div>
      </s-stack>

      {/* ── FAQ modal (design #mFaq) ─────────────────────────────────────── */}
      <BrowseModalShell
        open={faqDraft !== null}
        title={faqDraft?.id ? "Edit FAQ" : "Add FAQ"}
        onClose={() => setFaqDraft(null)}
        footer={
          faqDraft ? (
            <>
              {faqDraft.id && !confirmDelete ? (
                <s-button tone="critical" variant="tertiary" onClick={() => setConfirmDelete(true)}>
                  Delete FAQ
                </s-button>
              ) : null}
              <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                <s-button onClick={() => setFaqDraft(null)}>Cancel</s-button>
                <s-button
                  variant="primary"
                  disabled={busy || !faqDraft.question.trim()}
                  loading={pendingIntent === "faq-save"}
                  onClick={() =>
                    submit("faq-save", {
                      payload: JSON.stringify({ ...faqDraft, id: faqDraft.id ?? undefined }),
                    })
                  }
                >
                  Save FAQ
                </s-button>
              </span>
            </>
          ) : null
        }
      >
        {faqDraft ? (
          <s-stack gap="base">
            {confirmDelete && faqDraft.id ? (
              <s-banner tone="critical" heading="Delete this FAQ?">
                <s-paragraph>This can&apos;t be undone.</s-paragraph>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <s-button
                    variant="primary"
                    tone="critical"
                    disabled={busy}
                    loading={pendingIntent === "faq-delete"}
                    onClick={() => submit("faq-delete", { id: faqDraft.id! })}
                  >
                    Delete
                  </s-button>
                  <s-button onClick={() => setConfirmDelete(false)}>Keep it</s-button>
                </div>
              </s-banner>
            ) : null}
            <s-text-field
              label="Question"
              value={faqDraft.question}
              maxLength={500}
              onInput={(e) => setFaqDraft({ ...faqDraft, question: e.currentTarget.value })}
            />
            <s-text-area
              label="Answer"
              details="Basic HTML formatting is kept (bold, lists, links) — a rich-text editor is coming."
              rows={7}
              value={faqDraft.answerHtml}
              onInput={(e) => setFaqDraft({ ...faqDraft, answerHtml: e.currentTarget.value })}
            />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <s-select
                label="Status"
                value={faqDraft.status}
                onChange={(e) =>
                  setFaqDraft({
                    ...faqDraft,
                    status: e.currentTarget.value === "published" ? "published" : "draft",
                  })
                }
              >
                <s-option value="published">Published</s-option>
                <s-option value="draft">Draft</s-option>
              </s-select>
              <s-select
                label="Category"
                value={faqDraft.categoryId}
                onChange={(e) => setFaqDraft({ ...faqDraft, categoryId: e.currentTarget.value })}
              >
                {props.tree.map((category) => (
                  <s-option key={category.id} value={category.id}>
                    {category.name}
                  </s-option>
                ))}
              </s-select>
            </div>
            <s-checkbox
              label="Featured question"
              details="Enable to show this question on the first page of chatbox. If not, it will only be shown in category."
              checked={faqDraft.featured}
              onChange={(e) => setFaqDraft({ ...faqDraft, featured: e.currentTarget.checked })}
            />
          </s-stack>
        ) : null}
      </BrowseModalShell>

      {/* ── Category modal (design #mCat) ────────────────────────────────── */}
      <BrowseModalShell
        open={categoryDraft !== null}
        title={categoryDraft?.id ? "Edit category" : "Add category"}
        onClose={() => setCategoryDraft(null)}
        footer={
          categoryDraft ? (
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
              <s-button onClick={() => setCategoryDraft(null)}>Cancel</s-button>
              <s-button
                variant="primary"
                disabled={busy || !categoryDraft.name.trim()}
                loading={pendingIntent === "category-save"}
                onClick={() =>
                  submit("category-save", {
                    payload: JSON.stringify({
                      ...categoryDraft,
                      id: categoryDraft.id ?? undefined,
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
        {categoryDraft ? (
          <s-stack gap="base">
            <s-text-field
              label="Category name"
              value={categoryDraft.name}
              maxLength={100}
              disabled={categoryDraft.isDefault}
              details={
                categoryDraft.isDefault ? "The default category can't be renamed." : undefined
              }
              onInput={(e) => setCategoryDraft({ ...categoryDraft, name: e.currentTarget.value })}
            />
            <s-stack gap="small">
              <s-text>Icon</s-text>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {ICON_PRESETS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    aria-label={`Icon ${icon}`}
                    onClick={() => setCategoryDraft({ ...categoryDraft, icon })}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 10,
                      fontSize: 20,
                      cursor: "pointer",
                      background: "var(--s-color-bg, #fff)",
                      border:
                        categoryDraft.icon === icon
                          ? "2px solid var(--s-color-border-emphasis, #303030)"
                          : "1px solid var(--s-color-border, #d4d4d4)",
                    }}
                  >
                    {icon}
                  </button>
                ))}
                <input
                  type="text"
                  aria-label="Custom emoji icon"
                  value={categoryDraft.icon}
                  maxLength={4}
                  onChange={(e) =>
                    setCategoryDraft({ ...categoryDraft, icon: e.currentTarget.value })
                  }
                  style={{
                    width: 64,
                    padding: "10px 8px",
                    borderRadius: 10,
                    border: "1px solid var(--s-color-border, #d4d4d4)",
                    font: "inherit",
                    fontSize: 18,
                    textAlign: "center",
                  }}
                />
              </div>
            </s-stack>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <s-select
                label="Position"
                value={String(categoryDraft.position)}
                onChange={(e) =>
                  setCategoryDraft({
                    ...categoryDraft,
                    position: Number(e.currentTarget.value) || 1,
                  })
                }
              >
                {Array.from(
                  { length: categoryDraft.id ? props.tree.length : props.tree.length + 1 },
                  (_, i) => (
                    <s-option key={i + 1} value={String(i + 1)}>
                      {String(i + 1)}
                    </s-option>
                  ),
                )}
              </s-select>
              <s-select
                label="Status"
                value={categoryDraft.status}
                onChange={(e) =>
                  setCategoryDraft({
                    ...categoryDraft,
                    status: e.currentTarget.value === "draft" ? "draft" : "published",
                  })
                }
              >
                <s-option value="published">Published</s-option>
                <s-option value="draft">Draft</s-option>
              </s-select>
            </div>
            <s-checkbox
              label="Feature category"
              details="Enable to show this category on the first page of FAQs chatbox. If not, it will only be shown when viewing all categories."
              checked={categoryDraft.featured}
              onChange={(e) =>
                setCategoryDraft({ ...categoryDraft, featured: e.currentTarget.checked })
              }
            />
          </s-stack>
        ) : null}
      </BrowseModalShell>

      {/* ── Import modal (design #mImport) ───────────────────────────────── */}
      <BrowseModalShell
        open={importOpen}
        title="Import FAQs"
        onClose={() => {
          setImportOpen(false);
          setImportCsv(null);
          setImportError("");
        }}
        footer={
          <>
            <s-button
              variant="tertiary"
              onClick={() => downloadText("faq-sample.csv", SAMPLE_CSV)}
            >
              Download a sample CSV
            </s-button>
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
              <s-button onClick={() => setImportOpen(false)}>Cancel</s-button>
              <s-button
                variant="primary"
                disabled={busy || !importCsv}
                loading={pendingIntent === "faq-import"}
                onClick={() => importCsv && submit("faq-import", { csv: importCsv.text })}
              >
                Import
              </s-button>
            </span>
          </>
        }
      >
        <s-stack gap="base">
          <div
            style={{
              border: "1.5px dashed var(--s-color-border, #d4d4d4)",
              borderRadius: 12,
              padding: 28,
              textAlign: "center",
            }}
          >
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose a CSV file"
              onChange={(e) => onImportFile(e.currentTarget.files?.[0] ?? null)}
            />
            {importCsv ? <s-paragraph>Selected: {importCsv.name}</s-paragraph> : null}
          </div>
          <s-text tone="neutral">Accept CSV only, maximum size is 1MB</s-text>
          {importError ? <s-text tone="critical">{importError}</s-text> : null}
        </s-stack>
      </BrowseModalShell>

      {/* ── Export modal (design #mExport) ───────────────────────────────── */}
      <BrowseModalShell
        open={exportOpen}
        title="Export FAQs"
        onClose={() => setExportOpen(false)}
        footer={
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            <s-button onClick={() => setExportOpen(false)}>Cancel</s-button>
            <s-button
              variant="primary"
              disabled={busy}
              loading={pendingIntent === "faq-export"}
              onClick={() => submit("faq-export", { scope: exportScope })}
            >
              Export
            </s-button>
          </span>
        }
      >
        <s-choice-list
          label="What to export"
          labelAccessibilityVisibility="exclusive"
          name="faq-export-scope"
          values={[exportScope]}
          onChange={(e) => {
            const value = e.currentTarget.values[0];
            setExportScope(value === "published" ? "published" : "all");
          }}
        >
          <s-choice value="all">All FAQs</s-choice>
          <s-choice value="published">Only published FAQs</s-choice>
        </s-choice-list>
      </BrowseModalShell>
    </s-section>
  );
}

const linkButtonStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  textAlign: "left",
  padding: 0,
  color: "inherit",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const chevronStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0 2px",
  display: "inline-flex",
  alignItems: "center",
  color: "var(--s-color-text-secondary, #6b6b73)",
};

interface TreeRowDrag {
  enabled: boolean;
  /** This row is the one currently being dragged. */
  isSource: boolean;
  /** Drop indicator when another row hovers here: line above/below or "into". */
  edge: DropEdge | null;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

function TreeRow(props: {
  main: React.ReactNode;
  status: string;
  featured: boolean;
  indent?: boolean;
  busy: boolean;
  onFeature: (next: boolean) => void;
  /** Keyboard fallback for drag reorder (ArrowUp/ArrowDown on the handle). */
  onKeyMove: (direction: "up" | "down") => void;
  drag: TreeRowDrag;
}) {
  const hintColor = "var(--s-color-border-focus, #005bd3)";
  const dropShadow =
    props.drag.edge === "before"
      ? `inset 0 2px 0 0 ${hintColor}`
      : props.drag.edge === "after"
        ? `inset 0 -2px 0 0 ${hintColor}`
        : props.drag.edge === "into"
          ? `inset 0 0 0 2px ${hintColor}`
          : undefined;
  return (
    <div
      className="ccfaq-row"
      onDragOver={props.drag.onDragOver}
      onDragLeave={props.drag.onDragLeave}
      onDrop={props.drag.onDrop}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) 140px 110px",
        gap: 12,
        alignItems: "center",
        padding: props.indent ? "10px 14px 10px 34px" : "13px 14px",
        borderTop: props.indent
          ? "1px solid var(--s-color-border-secondary, #f1f1f1)"
          : "none",
        opacity: props.drag.isSource ? 0.4 : 1,
        boxShadow: dropShadow,
      }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          aria-label="Reorder (drag, or press arrow up/down)"
          disabled={!props.drag.enabled}
          draggable={props.drag.enabled}
          onDragStart={props.drag.onDragStart}
          onDragEnd={props.drag.onDragEnd}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              props.onKeyMove(e.key === "ArrowUp" ? "up" : "down");
            }
          }}
          style={{
            border: "none",
            background: "none",
            padding: "0 2px",
            display: "inline-flex",
            alignItems: "center",
            cursor: props.drag.enabled ? "grab" : "default",
            color: "var(--s-color-text-secondary, #8a8a8f)",
            opacity: props.drag.enabled ? 1 : 0.4,
            touchAction: "none",
          }}
        >
          <s-icon type="drag-handle" size="small" />
        </button>
        <span style={{ minWidth: 0, overflow: "hidden", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {props.main}
        </span>
      </span>
      <span style={{ textAlign: "center" }}>
        <s-badge tone={props.status === "published" ? "success" : "info"}>
          {props.status === "published" ? "Published" : "Draft"}
        </s-badge>
      </span>
      <span style={{ textAlign: "center" }}>
        <button
          type="button"
          aria-label={props.featured ? "Remove from featured" : "Mark as featured"}
          aria-pressed={props.featured}
          disabled={props.busy}
          onClick={() => props.onFeature(!props.featured)}
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            padding: 4,
            color: props.featured
              ? "var(--s-color-text, #303030)"
              : "var(--s-color-text-secondary, #c4c4ca)",
          }}
        >
          <s-icon type={props.featured ? "star-filled" : "star"} size="small" />
        </button>
      </span>
    </div>
  );
}
