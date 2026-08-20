import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import { displayQuota } from "../lib/billing/plans.server";
import { currentPeriodStart } from "../lib/billing/usage.server";
import {
  deleteCuratedAnswer,
  pendingEmbeddingIds,
  saveCuratedAnswer,
} from "../lib/curated/save.server";
import { revalidateCuratedStock } from "../lib/curated/revalidate.server";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { QuotaMeter } from "../components/QuotaMeter";
import { DataTable } from "../components/DataTable";
import { ChipInput } from "../components/ChipInput";
import type { BrowseItemMeta } from "../components/BrowseProductsModal";
import { BrowseProductsModal, BrowseThumb } from "../components/BrowseProductsModal";
import { SaveBar } from "../components/SaveBar";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";

// Curated Answers admin (spec 09): KPI row + quota meter, searchable list
// (10/page), add/edit view with synonyms chips, talking points, hand-picked
// products via the shared Browse products modal, and a suggestions sidebar fed
// by the unresolved-questions queue (07). Runtime matching/serving lives in
// the pipeline (03) + app/lib/search/curated-match.server.ts.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "curated" });
  const monthStart = currentPeriodStart();

  const [shop, answers, suggestions, eventCounts, pendingIds] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId }, select: { plan: true } }),
    db.curatedAnswer.findMany({
      where: { shopId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        question: true,
        synonyms: true,
        productIds: true,
        talkingPoints: true,
        status: true,
        priority: true,
        servedCount: true,
        stockIssue: true,
      },
    }),
    db.unresolvedQuestion.findMany({
      where: { shopId, status: "pending" },
      orderBy: { count: "desc" },
      take: 5,
      select: { id: true, question: true, count: true },
    }),
    db.analyticsEvent.groupBy({
      by: ["type"],
      where: {
        shopId,
        type: { in: ["curated_served", "turn_completed"] },
        occurredAt: { gte: monthStart },
      },
      _count: { _all: true },
    }),
    pendingEmbeddingIds(shopId),
  ]);

  const gids = [...new Set(answers.flatMap((a) => a.productIds))];
  const products = gids.length
    ? await db.product.findMany({
        where: { shopId, shopifyProductId: { in: gids } },
        select: { shopifyProductId: true, title: true, imageUrl: true, stock: true },
      })
    : [];
  const productMeta: Record<string, { title: string; imageUrl: string | null; stock: number }> =
    {};
  for (const p of products) {
    productMeta[p.shopifyProductId] = { title: p.title, imageUrl: p.imageUrl, stock: p.stock };
  }

  const countOf = (type: string) =>
    eventCounts.find((row) => row.type === type)?._count._all ?? 0;
  const curatedServed = countOf("curated_served");
  const turnCompleted = countOf("turn_completed");
  const matchDenominator = curatedServed + turnCompleted;

  return {
    plan: shop?.plan ?? "free",
    quota: displayQuota(shop?.plan ?? "free", "curated_answers"),
    answers,
    productMeta,
    suggestions,
    pendingEmbedding: pendingIds,
    kpis: {
      published: answers.filter((a) => a.status === "published").length,
      // Month-accurate: curated_served events since the period start (the
      // per-answer servedCount sum was all-time — PROGRESS follow-up closed).
      servedTotal: curatedServed,
      needsAttention: answers.filter((a) => a.stockIssue).length,
      matchRate:
        matchDenominator > 0 ? Math.round((curatedServed / matchDenominator) * 100) : 0,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "curated" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save") {
    let payload: unknown;
    try {
      payload = JSON.parse(String(formData.get("payload") ?? "{}"));
    } catch {
      return { intent: "save" as const, ok: false as const, error: "Invalid payload" };
    }
    const result = await saveCuratedAnswer(shopId, payload);
    if (!result.ok) {
      return { intent: "save" as const, ok: false as const, error: result.error, code: result.code };
    }
    return { intent: "save" as const, ok: true as const, id: result.id, warning: result.warning };
  }

  if (intent === "delete") {
    const ok = await deleteCuratedAnswer(shopId, String(formData.get("id") ?? ""));
    return { intent: "delete" as const, ok };
  }

  if (intent === "revalidate") {
    const result = await revalidateCuratedStock(shopId);
    return { intent: "revalidate" as const, ok: true as const, ...result };
  }

  return { intent: "unknown" as const, ok: false as const, error: "Unknown intent" };
};

interface Draft {
  id: string | null;
  question: string;
  synonyms: string[];
  talkingPoints: string;
  status: "draft" | "published";
  priority: "low" | "normal" | "high";
  productIds: string[];
  sourceUnresolvedId?: string;
}

const emptyDraft = (): Draft => ({
  id: null,
  question: "",
  synonyms: [],
  talkingPoints: "",
  status: "draft",
  priority: "normal",
  productIds: [],
});

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export default function CuratedAnswersPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  const [view, setView] = useState<"list" | "editor">("list");
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  // Snapshot of the draft as it was opened — drives the contextual save bar.
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(emptyDraft()));
  const [browseOpen, setBrowseOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [extraMeta, setExtraMeta] = useState<Record<string, BrowseItemMeta>>({});

  const meta = useMemo(
    () => ({ ...extraMeta, ...data.productMeta }) as Record<
      string,
      BrowseItemMeta & { stock?: number }
    >,
    [data.productMeta, extraMeta],
  );

  const pendingIndex = useMemo(() => new Set(data.pendingEmbedding), [data.pendingEmbedding]);
  const saving = fetcher.state !== "idle";

  const openAdd = (prefill?: { question: string; sourceUnresolvedId: string }) => {
    const next = {
      ...emptyDraft(),
      ...(prefill ? { question: prefill.question, sourceUnresolvedId: prefill.sourceUnresolvedId } : {}),
    };
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setConfirmDelete(false);
    setView("editor");
  };

  const openEdit = (row: (typeof data.answers)[number]) => {
    const next: Draft = {
      id: row.id,
      question: row.question,
      synonyms: row.synonyms,
      talkingPoints: row.talkingPoints,
      status: row.status === "published" ? "published" : "draft",
      priority: row.priority === "high" ? "high" : row.priority === "low" ? "low" : "normal",
      productIds: row.productIds,
    };
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setConfirmDelete(false);
    setView("editor");
  };

  const dirty = view === "editor" && JSON.stringify(draft) !== baseline;

  const save = () => {
    if (!draft.question.trim()) {
      shopify.toast.show("Add a shopper question before saving", { isError: true });
      return;
    }
    fetcher.submit(
      { intent: "save", payload: JSON.stringify({ ...draft, id: draft.id ?? undefined }) },
      { method: "post" },
    );
  };

  const discard = () => setDraft(JSON.parse(baseline) as Draft);

  const remove = (id: string) => {
    fetcher.submit({ intent: "delete", id }, { method: "post" });
  };

  const revalidate = () => {
    fetcher.submit({ intent: "revalidate" }, { method: "post" });
  };

  // Review-queue deep link: /app/curated-answers?prefill=<question>&unresolvedId=<id>
  // opens the add form pre-filled; saving marks the unresolved row handled
  // (sourceUnresolvedId seam in save.server.ts).
  const prefillConsumed = useRef(false);
  useEffect(() => {
    if (prefillConsumed.current) return;
    const params = new URLSearchParams(window.location.search);
    const prefill = params.get("prefill");
    if (prefill) {
      prefillConsumed.current = true;
      openAdd({ question: prefill, sourceUnresolvedId: params.get("unresolvedId") ?? "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toast + view transitions once an action round-trips.
  const processed = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || processed.current === fetcher.data) return;
    processed.current = fetcher.data;
    const result = fetcher.data;
    if (result.intent === "save" && result.ok) {
      shopify.toast.show(
        result.warning === "embedding_failed"
          ? "Saved — matching index pending (embedding unavailable)"
          : "Curated answer saved",
      );
      setView("list");
    }
    if (result.intent === "delete") {
      shopify.toast.show(result.ok ? "Curated answer deleted" : "Couldn't delete answer");
      setView("list");
    }
    if (result.intent === "revalidate" && result.ok) {
      shopify.toast.show(
        `Checked ${result.checked} published answer${result.checked === 1 ? "" : "s"} — ${result.flagged} newly flagged`,
      );
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const saveError =
    fetcher.state === "idle" && fetcher.data?.intent === "save" && !fetcher.data.ok
      ? fetcher.data
      : null;

  const suggestionsCard = (
    <s-section heading="Suggestions">
      <s-paragraph>
        Top unanswered shopper questions from real conversations. Use one to curate an answer.
      </s-paragraph>
      {data.suggestions.length === 0 ? (
        <s-text tone="neutral">No unresolved shopper questions yet.</s-text>
      ) : (
        <s-stack gap="base">
          {data.suggestions.map((s) => (
            <s-box key={s.id} padding="small" borderWidth="base" borderRadius="base">
              <s-stack gap="small">
                <s-text>{s.question}</s-text>
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                >
                  <s-text tone="neutral">
                    Asked {s.count} time{s.count === 1 ? "" : "s"}
                  </s-text>
                  <s-button
                    variant="tertiary"
                    onClick={() => openAdd({ question: s.question, sourceUnresolvedId: s.id })}
                  >
                    Use
                  </s-button>
                </div>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      )}
    </s-section>
  );

  return (
    <s-page heading="Curated Answers">
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
      <s-stack gap="base">
        <s-section heading="Overview">
          <StatGrid>
            <StatTile
              label="Published"
              value={String(data.kpis.published)}
              icon="check-circle"
              tone="success"
              sub={`of ${data.quota} total`}
            />
            <StatTile
              label="Served this month"
              value={String(data.kpis.servedTotal)}
              icon="chat"
              tone="accent"
              sub="curated answers used"
            />
            <StatTile
              label="Needs attention"
              value={String(data.kpis.needsAttention)}
              icon="alert-triangle"
              tone="warning"
              sub="dead-stock picks"
            />
            <StatTile
              label="Answer match rate"
              value={`${data.kpis.matchRate}%`}
              icon="target"
              tone="info"
              sub="of shopper questions matched"
            />
          </StatGrid>
          <QuotaMeter used={data.answers.length} quota={data.quota} label="used" />
        </s-section>

        {view === "list" ? (
          <s-section heading="Your curated answers">
            <DataTable
              rows={data.answers}
              searchPlaceholder="Search by question"
              searchFn={(row, q) => row.question.toLowerCase().includes(q)}
              emptyMessage="No answers match your search."
              perPage={10}
              toolbar={
                <>
                  <s-button onClick={revalidate} disabled={saving}>
                    Revalidate stock
                  </s-button>
                  <s-button variant="primary" onClick={() => openAdd()}>
                    Add new
                  </s-button>
                </>
              }
              columns={[
                {
                  key: "question",
                  title: "Question",
                  render: (row) => <span style={{ fontWeight: 600 }}>{row.question}</span>,
                },
                {
                  key: "status",
                  title: "Status",
                  render: (row) => (
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      <s-badge tone={row.status === "published" ? "success" : "neutral"}>
                        {capitalize(row.status)}
                      </s-badge>
                      {row.status === "published" && pendingIndex.has(row.id) ? (
                        <s-badge tone="warning">Pending index</s-badge>
                      ) : null}
                    </span>
                  ),
                },
                {
                  key: "priority",
                  title: "Priority",
                  render: (row) => <s-text tone="neutral">{capitalize(row.priority)}</s-text>,
                },
                {
                  key: "products",
                  title: "Products",
                  render: (row) => <s-text tone="neutral">{row.productIds.length}</s-text>,
                },
                {
                  key: "stock",
                  title: "Stock",
                  render: (row) =>
                    row.stockIssue ? (
                      <s-badge tone="critical">Issues</s-badge>
                    ) : (
                      <s-badge tone="success">In stock</s-badge>
                    ),
                },
                {
                  key: "actions",
                  title: "",
                  align: "end",
                  render: (row) => (
                    <span style={{ display: "inline-flex", gap: 8 }}>
                      <s-button variant="tertiary" onClick={() => openEdit(row)}>
                        Edit
                      </s-button>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        disabled={saving}
                        onClick={() => {
                          openEdit(row);
                          setConfirmDelete(true);
                        }}
                      >
                        Delete
                      </s-button>
                    </span>
                  ),
                },
              ]}
            />
          </s-section>
        ) : (
          <s-stack gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button
                icon="chevron-left"
                variant="tertiary"
                accessibilityLabel="Back to curated answers"
                onClick={() => setView("list")}
              />
              <s-heading>{draft.id ? "Edit curated answer" : "Add curated answer"}</s-heading>
            </s-stack>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) 300px",
              gap: 16,
              alignItems: "start",
            }}
          >
            <s-section>
              <s-stack gap="base">
                {saveError ? (
                  <s-banner tone="critical" heading="Couldn't save curated answer">
                    {saveError.error}
                    {saveError.code === "cap" ? (
                      <s-paragraph>
                        <s-link href="/app/plan-usage">View plans</s-link>
                      </s-paragraph>
                    ) : null}
                  </s-banner>
                ) : null}

                <s-text-field
                  label="Shopper question"
                  value={draft.question}
                  maxLength={500}
                  onInput={(e) => {
                    const question = e.currentTarget.value;
                    setDraft((d) => ({ ...d, question }));
                  }}
                />

                <ChipInput
                  label="Also matches (synonyms / phrasings)"
                  values={draft.synonyms}
                  placeholder="e.g. gift idea, present for someone"
                  onChange={(synonyms) => setDraft((d) => ({ ...d, synonyms }))}
                />

                <s-text-area
                  label="Talking points"
                  details="One per line — served exactly as written, no AI generation."
                  rows={4}
                  value={draft.talkingPoints}
                  maxLength={4000}
                  onInput={(e) => {
                    const talkingPoints = e.currentTarget.value;
                    setDraft((d) => ({ ...d, talkingPoints }));
                  }}
                />

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <s-select
                    label="Status"
                    value={draft.status}
                    onChange={(e) => {
                      const status = e.currentTarget.value === "published" ? "published" : "draft";
                      setDraft((d) => ({ ...d, status }));
                    }}
                  >
                    <s-option value="draft">Draft</s-option>
                    <s-option value="published">Published</s-option>
                  </s-select>
                  <s-select
                    label="Priority"
                    value={draft.priority}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setDraft((d) => ({
                        ...d,
                        priority: value === "high" ? "high" : value === "low" ? "low" : "normal",
                      }));
                    }}
                  >
                    <s-option value="normal">Normal</s-option>
                    <s-option value="high">High</s-option>
                    <s-option value="low">Low</s-option>
                  </s-select>
                </div>

                <s-stack gap="small">
                  <s-text>Hand-picked products</s-text>
                  {draft.productIds.length === 0 ? (
                    <s-text tone="neutral">No products selected yet.</s-text>
                  ) : (
                    <div>
                      {draft.productIds.map((gid) => {
                        const m = meta[gid];
                        const outOfStock = typeof m?.stock === "number" && m.stock <= 0;
                        return (
                          <div
                            key={gid}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "6px 0",
                              borderBottom:
                                "1px solid var(--s-color-border-secondary, #f1f1f1)",
                            }}
                          >
                            <BrowseThumb
                              imageUrl={m?.imageUrl ?? null}
                              title={m?.title ?? "Product"}
                            />
                            <span style={{ flex: 1, fontSize: 13 }}>
                              {m?.title ?? "Unavailable product"}
                            </span>
                            {!m || outOfStock ? (
                              <s-badge tone="critical">
                                {m ? "Out of stock" : "Missing"}
                              </s-badge>
                            ) : null}
                            <s-button
                              icon="x"
                              variant="tertiary"
                              accessibilityLabel={`Remove ${m?.title ?? "product"}`}
                              onClick={() =>
                                setDraft((d) => ({
                                  ...d,
                                  productIds: d.productIds.filter((id) => id !== gid),
                                }))
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div>
                    <s-button onClick={() => setBrowseOpen(true)}>Browse catalog</s-button>
                  </div>
                </s-stack>

                {confirmDelete && draft.id ? (
                  <s-banner tone="critical" heading="Delete this curated answer?">
                    <s-paragraph>This can&apos;t be undone.</s-paragraph>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <s-button
                        variant="primary"
                        tone="critical"
                        disabled={saving}
                        loading={saving}
                        onClick={() => remove(draft.id!)}
                      >
                        Delete
                      </s-button>
                      <s-button onClick={() => setConfirmDelete(false)}>Keep it</s-button>
                    </div>
                  </s-banner>
                ) : null}

                {draft.id && !confirmDelete ? (
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <s-button tone="critical" variant="tertiary" onClick={() => setConfirmDelete(true)}>
                      Delete
                    </s-button>
                  </div>
                ) : null}
              </s-stack>
            </s-section>

            {suggestionsCard}
          </div>
          </s-stack>
        )}
      </s-stack>

      <BrowseProductsModal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        selectedIds={draft.productIds}
        onConfirm={(ids, newMeta) => {
          setDraft((d) => ({ ...d, productIds: ids }));
          if (newMeta) setExtraMeta((prev) => ({ ...prev, ...newMeta }));
          setBrowseOpen(false);
        }}
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
