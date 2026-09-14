import { useEffect, useRef, useState } from "react";
import type { FaqCategoryData, FaqRowData } from "../lib/faq/faq.server";
import type { TrainingActionResult } from "../routes/app.ai-agent.training";
import { BrowseModalShell } from "./BrowseProductsModal";
import { DataTable } from "./DataTable";
import { ReorderButtons } from "./DragReorder";
import { downloadText, LearnCard, useTrainingFetcher } from "./TrainingShared";
import { useDateTime } from "../lib/format/context";
import { PlanMeter } from "./ui/PlanGate";
import { ConfirmDeleteModal } from "./ui/ConfirmDeleteModal";
import { htmlTextLength, RichTextEditor } from "./ui/RichTextEditor";

// FAQs tab (spec 07, design #viewTraining → FAQs): toolbar (import / export /
// add FAQ / add category), FAQ list in the shared paginated DataTable —
// the same table the Products/Collections/Discounts tabs use (the faqs
// quota reaches 250, so a category tree with
// drag reorder does not scale; category / status / featured filters +
// built-in search + 10/25/50-per-page pager replaced it). Categories are
// managed via More actions → Manage categories; FAQ order — the GLOBAL
// chat-widget display order, across categories — moves via the FAQ modal's
// "Position in chat widget" number input or the per-row up/down arrows
// (`faq-move`). Categories carry NO position/featured of their own
// (the widget only shows them as labels).
// Answers are stored as sanitized HTML.

// Category icons are Polaris icon names only (no
// free emoji input). Legacy rows may still hold an emoji; CategoryIcon falls
// back to rendering it as text.
const ICON_PRESETS = [
  // "page" is the default a new category is created with (faq.server.ts) and
  // MUST stay in this list: CategoryIcon renders anything it doesn't know as
  // literal text, which is what printed "page Warranty" in the tree.
  "page",
  "exchange",
  "cart",
  "return",
  "credit-card",
  "delivery",
  "discount",
  "gift-card",
  "store",
  "globe",
  "person",
] as const;
type FaqIcon = (typeof ICON_PRESETS)[number];

function CategoryIcon(props: { icon: string }) {
  if ((ICON_PRESETS as readonly string[]).includes(props.icon)) {
    return <s-icon type={props.icon as FaqIcon} size="small" />;
  }
  // Legacy emoji rows render as text (see note above). An unrecognised icon
  // SLUG must not — that just prints the slug beside the category name.
  const isEmoji = (props.icon.codePointAt(0) ?? 0) > 127;
  return isEmoji ? <>{props.icon}</> : <s-icon type="page" size="small" />;
}

// Every column the importer understands, in the SAME order exportFaqCsv writes
// them — so an export can be edited and re-imported, and the sample doubles as
// the format reference. Ordering and featured are deliberately NOT in the file
// imported FAQs append to the end of the widget
// order, not featured — both are set in the app afterwards.
//
//   category  name; created automatically if the shop has no category by that
//             name. Blank → the default category.
//   status    "draft" (matched loosely) → draft; anything else → published.
const SAMPLE_CSV = [
  "question,answer,category,status",
  "What is your return policy?,You can return any item within 30 days of delivery for a full refund.,Returns,published",
  "Do you ship internationally?,Yes — we ship worldwide. International orders arrive in 7–14 business days.,Shipping,published",
  "How do I track my order?,Once your order ships we email you a tracking link.,Shipping,published",
  "Can I change my order after checkout?,Contact us within an hour and we'll do our best.,Orders,draft",
].join("\r\n");

interface FaqDraft {
  id: string | null;
  question: string;
  answerHtml: string;
  status: "published" | "draft";
  categoryId: string;
  featured: boolean;
  /** 1-based slot in the shop's GLOBAL widget order — what the chat widget shows. */
  position?: number;
  unresolvedId?: string;
}

/** One DataTable row = one FAQ, with its category flattened in for the
 *  Category column/filter and the full FaqRowData kept for the edit modal. */
interface FaqTableRow {
  id: string;
  question: string;
  status: string;
  featured: boolean;
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  /** 1-based slot in the shop's GLOBAL widget order (across categories). */
  widgetPosition: number;
  faq: FaqRowData;
}

// No position / featured here: the widget
// never reads either — it shows the category only as a text label on FAQ rows
// — so the controls promised an ordering/placement effect that didn't exist.
// FAQ-level position + featured are the real widget controls.
interface CategoryDraft {
  id: string | null;
  name: string;
  icon: string;
  status: "published" | "draft";
  isDefault: boolean;
}

export function FaqManager(props: {
  tree: FaqCategoryData[];
  /** FAQ plan cap (faqs quota): count / limit / plan that raises
   *  it. Adding is disabled at the cap; editing existing FAQs never is. */
  quotaUsed: number;
  quotaLimit: number;
  quotaNextPlan: string | null;
  prefillQuestion: string;
  prefillUnresolvedId: string;
}) {
  const dt = useDateTime();
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "published" | "draft">("");
  const [featuredFilter, setFeaturedFilter] = useState<"" | "yes" | "no">("");
  const [faqDraft, setFaqDraft] = useState<FaqDraft | null>(null);
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: "faq" | "category"; id: string; label: string } | null
  >(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importCsv, setImportCsv] = useState<{ name: string; text: string } | null>(null);
  const [importError, setImportError] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"all" | "published">("all");

  const tree = props.tree;

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

  // One flat row list in the GLOBAL widget order (position across all
  // categories — the exact order the chat widget shows; a category is only a
  // label) for the shared DataTable; the Category / Status / Featured selects
  // filter it BEFORE the table so its built-in search and pager work on what
  // is actually visible.
  const allRows: FaqTableRow[] = tree
    .flatMap((category) =>
      category.faqs.map((faq) => ({
        id: faq.id,
        question: faq.question,
        status: faq.status,
        featured: faq.featured,
        categoryId: category.id,
        categoryName: category.name,
        categoryIcon: category.icon,
        faq,
      })),
    )
    .sort(
      (a, b) => a.faq.position - b.faq.position || a.question.localeCompare(b.question),
    )
    .map((row, index) => ({ ...row, widgetPosition: index + 1 }));
  const rows = allRows.filter(
    (row) =>
      (!categoryFilter || row.categoryId === categoryFilter) &&
      (!statusFilter || row.status === statusFilter) &&
      (!featuredFilter || row.featured === (featuredFilter === "yes")),
  );

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
      position: allRows.find((r) => r.id === faq.id)?.widgetPosition,
    });
  };

  const openAddCategory = () =>
    setCategoryDraft({
      id: null,
      name: "",
      icon: "page",
      status: "published",
      isDefault: false,
    });

  const openEditCategory = (category: FaqCategoryData) =>
    setCategoryDraft({
      id: category.id,
      name: category.name,
      icon: category.icon,
      status: category.status === "draft" ? "draft" : "published",
      isDefault: category.isDefault,
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

  const atFaqCap = props.quotaUsed >= props.quotaLimit;
  // "Learned" = what the AI actually reads: the FAQ knowledge bridge indexes
  // PUBLISHED FAQs only (knowledge-ingest loadDocs "faq"), so a draft is
  // counted in the total but not as learned — the same chip rule as the other
  // Training tabs' learnEnabled counts.
  const publishedCount = allRows.filter((row) => row.status === "published").length;

  return (
    <s-stack gap="base">
      {/* Same top card as every other Training tab. No master switch: FAQs
          have no "learn" toggle — publishing one is what makes it learnable. */}
      <LearnCard
        title="FAQs"
        chip={`${publishedCount} of ${allRows.length} FAQs learned`}
        description="Answer common questions instantly. Published FAQs appear in your chat widget and teach the AI; drafts stay private until you publish them."
      />
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
              <s-button icon="edit" onClick={() => setCategoriesOpen(true)}>
                Manage categories
              </s-button>
            </s-menu>
            <s-button variant="primary" commandFor="faq-add-new-menu">
              Add new
            </s-button>
            <s-menu id="faq-add-new-menu" accessibilityLabel="Add new">
              {/* Pre-selects the category the table is filtered to. */}
              <s-button
                icon="plus"
                disabled={atFaqCap}
                onClick={() => openAddFaq(categoryFilter || undefined)}
              >
                {atFaqCap ? `Add FAQ (limit ${props.quotaLimit} reached)` : "Add FAQ"}
              </s-button>
              <s-button icon="plus" onClick={openAddCategory}>
                Add category
              </s-button>
            </s-menu>
          </div>
        </div>

        {/* FAQ plan cap on its own full-width row — beside the toolbar
            the meter was too squeezed. */}
        <PlanMeter
          used={props.quotaUsed}
          quota={props.quotaLimit}
          label="FAQs"
          nextPlan={props.quotaNextPlan}
        />

        <DataTable
          rows={rows}
          perPage={10}
          minRows={10}
          searchAlwaysOpen
          searchPlaceholder="Search FAQs by question or category"
          searchFn={(row, q) =>
            row.question.toLowerCase().includes(q) ||
            row.categoryName.toLowerCase().includes(q)
          }
          emptyMessage={
            allRows.length === 0
              ? "No FAQs yet. Add one, or import a CSV from More actions."
              : "No FAQs match your filters."
          }
          onRowClick={(row) => openEditFaq(row.faq, row.categoryId)}
          toolbar={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ width: 170 }}>
                <s-select
                  label="Category"
                  labelAccessibilityVisibility="exclusive"
                  value={categoryFilter || "all"}
                  onInput={(e) => {
                    const v = e.currentTarget.value;
                    setCategoryFilter(v === "all" ? "" : v);
                  }}
                >
                  <s-option value="all">Category: All</s-option>
                  {tree.map((category) => (
                    <s-option key={category.id} value={category.id}>
                      {category.name}
                    </s-option>
                  ))}
                </s-select>
              </div>
              <div style={{ width: 150 }}>
                <s-select
                  label="Status"
                  labelAccessibilityVisibility="exclusive"
                  value={statusFilter || "all"}
                  onInput={(e) => {
                    const v = e.currentTarget.value;
                    setStatusFilter(v === "published" || v === "draft" ? v : "");
                  }}
                >
                  <s-option value="all">Status: All</s-option>
                  <s-option value="published">Published</s-option>
                  <s-option value="draft">Draft</s-option>
                </s-select>
              </div>
              <div style={{ width: 160 }}>
                <s-select
                  label="Featured"
                  labelAccessibilityVisibility="exclusive"
                  value={featuredFilter || "all"}
                  onInput={(e) => {
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
          }
          columns={[
            {
              key: "question",
              title: "Question",
              render: (row) => (
                <span
                  style={{
                    display: "block",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.question}
                </span>
              ),
            },
            {
              key: "category",
              title: "Category",
              width: 140,
              render: (row) => (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <CategoryIcon icon={row.categoryIcon} /> {row.categoryName}
                </span>
              ),
            },
            {
              key: "status",
              title: "Status",
              width: 96,
              render: (row) => (
                <s-badge tone={row.status === "published" ? "success" : "info"}>
                  {row.status === "published" ? "Published" : "Draft"}
                </s-badge>
              ),
            },
            {
              key: "featured",
              title: "Featured",
              width: 76,
              // Display-only: featured is changed
              // in the edit modal's checkbox — clicking the star opens it via
              // the row click.
              render: (row) => <FeaturedStar featured={row.featured} />,
            },
            {
              key: "created",
              title: "Created",
              width: 96,
              // DB-stamped on insert — never
              // merchant-entered. Rows older than the migration show its date.
              render: (row) => <s-text tone="neutral">{dt.date(row.faq.createdAt)}</s-text>,
            },
            {
              key: "order",
              title: "Order",
              width: 84,
              align: "end",
              // Chat-widget display order: the FAQ's 1-based slot across ALL
              // categories + up/down nudges (`faq-move`).
              render: (row) => (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    justifyContent: "flex-end",
                  }}
                >
                  <s-text tone="neutral">#{row.widgetPosition}</s-text>
                  <ReorderButtons
                    label={row.question}
                    enabled={!busy}
                    onMove={(direction) => submit("faq-move", { id: row.id, direction })}
                  />
                </span>
              ),
            },
          ]}
        />
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
                  disabled={busy || !faqDraft.question.trim() || faqDraft.answerHtml.length > 20_000}
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
            {/* Same rich-text editor as conversation-starter answers;
                HTML is sanitized server-side on save (faq.server.ts). */}
            <RichTextEditor
              label="Answer"
              rows={7}
              value={faqDraft.answerHtml}
              placeholder="Write the answer shoppers see when they open this question…"
              onChange={(answerHtml) => setFaqDraft({ ...faqDraft, answerHtml })}
              details={
                faqDraft.answerHtml.length > 20_000
                  ? "Answer is too long — shorten it to save."
                  : `${htmlTextLength(faqDraft.answerHtml)} characters`
              }
            />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <s-select
                label="Status"
                value={faqDraft.status}
                onInput={(e) =>
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
                onInput={(e) =>
                  setFaqDraft({ ...faqDraft, categoryId: e.currentTarget.value })
                }
              >
                {tree.map((category) => (
                  <s-option key={category.id} value={category.id}>
                    {category.name}
                  </s-option>
                ))}
              </s-select>
              {/* GLOBAL widget order:
                  1 shows first in the chat widget, across all categories.
                  Number input per user request — no dropdown; the server
                  clamps out-of-range values to the end of the list. */}
              <s-number-field
                label="Position in chat widget"
                details={`1 shows first · ${allRows.length || 1} = last`}
                min={1}
                max={Math.max(1, allRows.length + (faqDraft.id ? 0 : 1))}
                step={1}
                value={faqDraft.position === undefined ? "" : String(faqDraft.position)}
                onInput={(e) => {
                  const n = Math.floor(Number(e.currentTarget.value));
                  setFaqDraft({
                    ...faqDraft,
                    position: Number.isFinite(n) && n >= 1 ? n : undefined,
                  });
                }}
              />
            </div>
            <s-checkbox
              label="Featured question"
              details="Enable to show this question on the first page of chatbox. If not, it will only be shown in category."
              checked={faqDraft.featured}
              onInput={(e) => setFaqDraft({ ...faqDraft, featured: e.currentTarget.checked })}
            />
          </s-stack>
        ) : null}
      </BrowseModalShell>

      {/* ── Manage categories modal (the always-visible category
          entry point after the tree/chips went away; each row opens the
          existing edit modal). While a category is being edited the list is
          only HIDDEN (categoriesOpen stays true), so closing the edit modal —
          save, delete or cancel — returns here, refreshed by the loader
          revalidation (user request 2026-09-10). ──────────────────────────── */}
      <BrowseModalShell
        open={categoriesOpen && categoryDraft === null}
        title="Manage categories"
        onClose={() => setCategoriesOpen(false)}
        footer={
          <>
            <s-button icon="plus" onClick={openAddCategory}>
              Add category
            </s-button>
            <span style={{ marginLeft: "auto" }}>
              <s-button onClick={() => setCategoriesOpen(false)}>Done</s-button>
            </span>
          </>
        }
      >
        <s-stack gap="small-200">
          <s-text tone="neutral">
            Categories group your FAQs and appear as a label on each question in the chat
            widget. Select one to edit its name, icon or status.
          </s-text>
          {tree.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => openEditCategory(category)}
              style={categoryRowStyle}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <CategoryIcon icon={category.icon} />
                <span style={{ fontWeight: 600 }}>{category.name}</span>
                <span style={{ color: "var(--s-color-text-secondary, #8a8a8f)" }}>
                  ({category.faqs.length} FAQ{category.faqs.length === 1 ? "" : "s"})
                </span>
                {category.isDefault ? <s-badge tone="neutral">Default</s-badge> : null}
                {category.status === "draft" ? <s-badge tone="info">Draft</s-badge> : null}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <s-icon type="edit" size="small" />
              </span>
            </button>
          ))}
        </s-stack>
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
            {/* No position or "Feature category" here:
                the widget never read either — FAQ-level position/featured are
                the real widget controls. */}
            <s-select
              label="Status"
              details="Draft hides the category label in the chat widget"
              value={categoryDraft.status}
              onInput={(e) =>
                setCategoryDraft({
                  ...categoryDraft,
                  status: e.currentTarget.value === "draft" ? "draft" : "published",
                })
              }
            >
              <s-option value="published">Published</s-option>
              <s-option value="draft">Draft</s-option>
            </s-select>
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
          onInput={(e) => {
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
    </s-stack>
  );
}

const categoryRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  width: "100%",
  border: "1px solid var(--s-color-border, #e3e3e3)",
  borderRadius: 10,
  background: "var(--s-color-bg, #fff)",
  padding: "10px 14px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  color: "inherit",
  textAlign: "left",
};

/** Featured indicator — display-only: featured is
 *  changed via the edit modals' checkboxes; clicking a table star falls
 *  through to the row click → opens that modal.
 *  Inline SVG because s-icon paints its own palette and ignores the parent's
 *  color, and featured = filled yellow star. */
function FeaturedStar(props: { featured: boolean }) {
  return (
    <span
      role="img"
      aria-label={props.featured ? "Featured" : "Not featured"}
      title={props.featured ? "Featured — edit to change" : "Not featured — edit to change"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        color: props.featured ? "#f5b400" : "var(--s-color-text-secondary, #c4c4ca)",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M10 2 L12 7.25 L17.61 7.53 L13.23 11.05 L14.7 16.47 L10 13.4 L5.3 16.47 L6.77 11.05 L2.39 7.53 L8 7.25 Z"
          fill={props.featured ? "#f5b400" : "none"}
          stroke={props.featured ? "#f5b400" : "currentColor"}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
