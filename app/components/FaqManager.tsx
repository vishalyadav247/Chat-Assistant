import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { FaqCategoryData, FaqRowData } from "../lib/faq/faq.server";
import type { TrainingActionResult } from "../routes/app.ai-agent.training";
import { BrowseModalShell } from "./BrowseProductsModal";
import { downloadText, useTrainingFetcher } from "./TrainingShared";
import { ConfirmDeleteModal } from "./ui/ConfirmDeleteModal";

// FAQs tab (spec 07, design #viewTraining → FAQs): toolbar (import / export /
// add FAQ / add category), search + Status/Featured filters, category tree
// with per-row featured stars and up/down reorder, category + FAQ modals.
// Answers are stored as sanitized HTML (rich-text editor deferred — textarea
// v1, same delta as spec 06 starter answers).

// Category icons are Polaris icon names only (user decision 2026-08-12 — no
// free emoji input). Legacy rows may still hold an emoji; CategoryIcon falls
// back to rendering it as text.
const ICON_PRESETS = [
  "page",
  "cart",
  "return",
  "credit-card",
  "delivery",
  "question-circle",
  "discount",
  "gift-card",
  "receipt",
  "store",
  "globe",
  "person",
] as const;
type FaqIcon = (typeof ICON_PRESETS)[number];

function CategoryIcon(props: { icon: string }) {
  return (ICON_PRESETS as readonly string[]).includes(props.icon) ? (
    <s-icon type={props.icon as FaqIcon} size="small" />
  ) : (
    <>{props.icon}</>
  );
}

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
.ccfaq-handle {
  border: none;
  background: none;
  color: var(--s-color-text-secondary, #8a8a8f);
  transition: background-color .15s ease, color .15s ease, transform .15s ease;
}
.ccfaq-handle:not(:disabled):hover {
  background: var(--s-color-bg-fill-secondary, #f1f1f1);
  color: var(--s-color-text, #303030);
  transform: scale(1.1);
}
.ccfaq-handle:not(:disabled):active {
  cursor: grabbing;
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
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: "faq" | "category"; id: string; label: string } | null
  >(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCsv, setImportCsv] = useState<{ name: string; text: string } | null>(null);
  const [importError, setImportError] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"all" | "published">("all");

  // Optimistic reorder: a drop re-arranges this local copy INSTANTLY while the
  // place intent + loader revalidation (which can take seconds — the training
  // loader reloads every tab) catch up; fresh loader data clears it.
  const [optimisticTree, setOptimisticTree] = useState<FaqCategoryData[] | null>(null);
  useEffect(() => setOptimisticTree(null), [props.tree]);
  const tree = optimisticTree ?? props.tree;

  const defaultCategoryId = tree.find((c) => c.isDefault)?.id ?? tree[0]?.id ?? "";

  const { submit, busy, pendingIntent } = useTrainingFetcher((result: TrainingActionResult) => {
    if (!result.ok) return;
    switch (result.intent) {
      case "faq-save":
      case "faq-delete":
        setFaqDraft(null);
        setDeleteTarget(null);
        break;
      case "category-save":
        setCategoryDraft(null);
        break;
      case "category-delete":
        setCategoryDraft(null);
        setDeleteTarget(null);
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

  const visibleTree = tree
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

  // dragover fires continuously — only touch state when the hint actually
  // changes, otherwise every mouse move re-renders the whole tree (lag).
  const hintIfChanged = (key: string, edge: DropEdge) =>
    setDropHint((h) => (h && h.key === key && h.edge === edge ? h : { key, edge }));

  const clearDrag = () => {
    setDragging(null);
    setDropHint(null);
  };

  const dropCategoryOnCategory = (targetId: string, edge: "before" | "after") => {
    if (!dragging || dragging.kind !== "category" || dragging.id === targetId) return;
    const moved = tree.find((c) => c.id === dragging.id);
    const without = tree.filter((c) => c.id !== dragging.id);
    const index = without.findIndex((c) => c.id === targetId);
    if (index < 0 || !moved) return;
    const insert = edge === "before" ? index : index + 1;
    setOptimisticTree([...without.slice(0, insert), moved, ...without.slice(insert)]);
    submit("category-place", { id: dragging.id, position: String(insert + 1) });
  };

  /** Optimistic FAQ move: strip the dragged FAQ everywhere, re-insert it in
   *  the target category at `insert` (index within the stripped list). */
  const moveFaqLocally = (faqId: string, categoryId: string, insert: number) => {
    const moved = tree.flatMap((c) => c.faqs).find((f) => f.id === faqId);
    if (!moved) return;
    setOptimisticTree(
      tree.map((c) => {
        const faqs = c.faqs.filter((f) => f.id !== faqId);
        if (c.id === categoryId) faqs.splice(insert, 0, moved);
        return { ...c, faqs };
      }),
    );
  };

  const dropFaqOnFaq = (categoryId: string, targetFaqId: string, edge: "before" | "after") => {
    if (!dragging || dragging.kind !== "faq" || dragging.id === targetFaqId) return;
    const category = tree.find((c) => c.id === categoryId);
    if (!category) return;
    const without = category.faqs.filter((f) => f.id !== dragging.id);
    const index = without.findIndex((f) => f.id === targetFaqId);
    if (index < 0) return;
    const insert = edge === "before" ? index : index + 1;
    moveFaqLocally(dragging.id, categoryId, insert);
    submit("faq-place", { id: dragging.id, categoryId, position: String(insert) });
  };

  const dropFaqOnCategory = (categoryId: string) => {
    if (!dragging || dragging.kind !== "faq") return;
    const category = tree.find((c) => c.id === categoryId);
    if (!category) return;
    const insert = category.faqs.filter((f) => f.id !== dragging.id).length;
    moveFaqLocally(dragging.id, categoryId, insert);
    submit("faq-place", { id: dragging.id, categoryId, position: String(insert) });
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
    setDeleteTarget(null);
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
      icon: "page",
      position: tree.length + 1,
      status: "published",
      featured: false,
      isDefault: false,
    });

  const openEditCategory = (category: FaqCategoryData) =>
    setCategoryDraft({
      id: category.id,
      name: category.name,
      icon: category.icon,
      position: tree.findIndex((c) => c.id === category.id) + 1,
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

        {/* Full-width search, then the two filter dropdowns inline (natural
            width) on the next row (user request 2026-08-12). */}
        <s-search-field
          label="Search FAQs"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search all categories and FAQs"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* s-select fills its container — cap each in a fixed-width box so
              the dropdowns stay compact. */}
          <div style={{ width: 180 }}>
            <s-select
              label="Status"
              labelAccessibilityVisibility="exclusive"
              value={statusFilter || "all"}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setStatusFilter(v === "published" || v === "draft" ? v : "");
              }}
            >
              <s-option value="all">Status: All</s-option>
              <s-option value="published">Published</s-option>
              <s-option value="draft">Draft</s-option>
            </s-select>
          </div>
          <div style={{ width: 180 }}>
            <s-select
              label="Featured"
              labelAccessibilityVisibility="exclusive"
              value={featuredFilter || "all"}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setFeaturedFilter(v === "yes" || v === "no" ? v : "");
              }}
            >
              <s-option value="all">Featured: All</s-option>
              <s-option value="yes">Featured</s-option>
              <s-option value="no">Not featured</s-option>
            </s-select>
          </div>
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
                      <span
                        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                      >
                        <CategoryIcon icon={category.icon} /> {category.name}
                      </span>
                    </button>
                    <s-text tone="neutral">({faqs.length} FAQs)</s-text>
                    {category.isDefault ? <s-badge tone="neutral">Default</s-badge> : null}
                  </span>
                }
                status={category.status}
                featured={category.featured}
                onOpen={() => openEditCategory(category)}
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
                    hintIfChanged(
                      `cat:${category.id}`,
                      dragging.kind === "category" ? edgeFor(e) : "into",
                    );
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
                      onOpen={() => openEditFaq(faq, category.id)}
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
                          hintIfChanged(`faq:${faq.id}`, edgeFor(e));
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
              {faqDraft.id ? (
                <s-button
                  tone="critical"
                  variant="tertiary"
                  onClick={() =>
                    setDeleteTarget({ kind: "faq", id: faqDraft.id!, label: faqDraft.question })
                  }
                >
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
                {tree.map((category) => (
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
            <>
              {categoryDraft.id && !categoryDraft.isDefault ? (
                <s-button
                  tone="critical"
                  variant="tertiary"
                  onClick={() =>
                    setDeleteTarget({
                      kind: "category",
                      id: categoryDraft.id!,
                      label: categoryDraft.name,
                    })
                  }
                >
                  Delete category
                </s-button>
              ) : null}
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
            </>
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
                    aria-pressed={categoryDraft.icon === icon}
                    onClick={() => setCategoryDraft({ ...categoryDraft, icon })}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 10,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "var(--s-color-bg, #fff)",
                      border:
                        categoryDraft.icon === icon
                          ? "2px solid var(--s-color-border-emphasis, #303030)"
                          : "1px solid var(--s-color-border, #d4d4d4)",
                    }}
                  >
                    <s-icon type={icon} />
                  </button>
                ))}
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
                  { length: categoryDraft.id ? tree.length : tree.length + 1 },
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

      {/* ── Delete confirmation (Shopify-style modal) ────────────────────── */}
      <ConfirmDeleteModal
        open={deleteTarget !== null}
        title={
          deleteTarget?.kind === "category"
            ? `Delete ${deleteTarget.label || "this category"}?`
            : `Delete this FAQ?`
        }
        body={
          deleteTarget?.kind === "category"
            ? "Its FAQs will move to the Uncategorized category. This can't be undone."
            : "This can't be undone."
        }
        loading={pendingIntent === "faq-delete" || pendingIntent === "category-delete"}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          submit(deleteTarget.kind === "category" ? "category-delete" : "faq-delete", {
            id: deleteTarget.id,
          });
        }}
      />
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
  /** Open the edit modal — fires on a click anywhere on the row. */
  onOpen: () => void;
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
    // Keyboard access to "open" is the row's name/question button — this
    // row-level handler only widens the pointer click target (Chatty-style).
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="ccfaq-row"
      onClick={(e) => {
        // Anywhere on the row opens the edit modal — except clicks on the
        // row's own interactive controls (chevron, star, drag handle, links).
        if ((e.target as HTMLElement).closest("button, s-button, a, input")) return;
        props.onOpen();
      }}
      onDragOver={props.drag.onDragOver}
      onDragLeave={props.drag.onDragLeave}
      onDrop={props.drag.onDrop}
      style={{
        cursor: "pointer",
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
        // The hover transition would delay the drop indicator — show it instantly.
        transition: dropShadow ? "none" : undefined,
      }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          className="ccfaq-handle"
          aria-label="Reorder (drag, or press arrow up/down)"
          disabled={!props.drag.enabled}
          draggable={props.drag.enabled}
          onDragStart={(e) => {
            // Ghost the WHOLE row while dragging, not just the tiny handle.
            const row = (e.currentTarget as HTMLElement).closest(".ccfaq-row");
            if (row instanceof HTMLElement) {
              e.dataTransfer.setDragImage(row, 24, row.offsetHeight / 2);
            }
            props.drag.onDragStart(e);
          }}
          onDragEnd={props.drag.onDragEnd}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              props.onKeyMove(e.key === "ArrowUp" ? "up" : "down");
            }
          }}
          style={{
            padding: 6,
            margin: -2,
            display: "inline-flex",
            alignItems: "center",
            borderRadius: 6,
            cursor: props.drag.enabled ? "grab" : "default",
            opacity: props.drag.enabled ? 1 : 0.4,
            touchAction: "none",
          }}
        >
          <s-icon type="drag-handle" size="base" />
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
            // Featured = filled yellow star (user request 2026-08-12).
            color: props.featured ? "#f5b400" : "var(--s-color-text-secondary, #c4c4ca)",
          }}
        >
          {/* Inline SVG star: s-icon paints its own palette and ignores the
              button's color (tone="auto" included), so the yellow featured
              state needs a glyph we control. Shape mirrors Polaris star. */}
          <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M10 2 L12 7.25 L17.61 7.53 L13.23 11.05 L14.7 16.47 L10 13.4 L5.3 16.47 L6.77 11.05 L2.39 7.53 L8 7.25 Z"
              fill={props.featured ? "#f5b400" : "none"}
              stroke={props.featured ? "#f5b400" : "currentColor"}
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </span>
    </div>
  );
}
