import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { recordEvent } from "../analytics/events.server";
import { getQuota } from "../billing/plans.server";
import type { QuotaDimension } from "../billing/plan-shared";
import { bonusQuota } from "../billing/quota-grants.server";
import { requireShopId } from "../tenancy.server";
import { logWarn } from "../log.server";
import { htmlToText } from "./fetchers.server";

// Pages & Blogs sync (spec 22). Store pages and blog articles are mirrored from
// the Admin API the way products and collections are, then reach the agent
// through a knowledge BRIDGE — one system DataSource per kind, like FAQs —
// because they are prose: the question lane's RAG is where they get used.
//
// There are no webhook topics for pages or articles (verified against the
// 2026-07 WebhookSubscriptionTopic enum), so freshness comes only from the Sync
// button and the daily reconcile.

export type ContentKind = "pages" | "blogs";

/** DataSource.type of each kind's knowledge bridge. Hidden from Custom knowledge. */
export const BRIDGE_TYPE = { pages: "store_pages", blogs: "blog_articles" } as const;
export const BRIDGE_TYPES: string[] = Object.values(BRIDGE_TYPE);
const BRIDGE_NAME: Record<ContentKind, string> = { pages: "Store pages", blogs: "Blog articles" };
const QUOTA: Record<ContentKind, QuotaDimension> = { pages: "pages_synced", blogs: "articles_synced" };

// Newest-updated FIRST, and that is load-bearing: when a store has more than
// its limit, the rows a capped run sees are exactly the N freshest, so every
// row it did NOT see is either deleted in Shopify or outside the limit — both
// of which should go. That makes pruning correct even on a capped run, and it
// is what enforces the limit after a plan downgrade. Validated 2026-07.
const PAGES_QUERY = `#graphql
  query ContentSyncPages($cursor: String) {
    pages(first: 100, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes { id title handle body isPublished updatedAt }
    }
  }
`;

const ARTICLES_QUERY = `#graphql
  query ContentSyncArticles($cursor: String) {
    articles(first: 100, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle body summary tags isPublished updatedAt
        author { name }
        blog { id title }
      }
    }
  }
`;

export interface PageNode {
  id: string;
  title: string | null;
  handle: string | null;
  body: string | null;
  isPublished: boolean;
  updatedAt: string | null;
}

export interface ArticleNode extends PageNode {
  summary: string | null;
  tags: string[] | null;
  author: { name: string | null } | null;
  blog: { id: string; title: string | null } | null;
}

/** Shopify page → row fields. Pure, for tests. */
export function pageRowFields(node: PageNode) {
  return {
    title: (node.title ?? node.handle ?? "Untitled page").trim(),
    handle: node.handle ?? "",
    bodyText: node.body ? htmlToText(node.body).text : "",
    isPublished: node.isPublished,
    shopifyUpdatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}

/** Shopify article → row fields. Pure, for tests. */
export function articleRowFields(node: ArticleNode) {
  return {
    ...pageRowFields({ ...node, title: node.title ?? node.handle ?? "Untitled article" }),
    summary: node.summary ? htmlToText(node.summary).text : "",
    tags: node.tags ?? [],
    author: node.author?.name ?? "",
    blogTitle: node.blog?.title ?? "",
  };
}

export interface ContentSyncResult {
  synced: number;
  capped: boolean;
  pruned: number;
  /** True when anything the agent reads could differ — the bridge is rebuilt only then. */
  changed: boolean;
}

async function existingShopId(shopDomain: string): Promise<string | null> {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain }, select: { id: true } });
  if (!shop) {
    logWarn("content_sync_unknown_shop", undefined, { shopDomain });
    return null;
  }
  return requireShopId(shop.id);
}

/** Plan cap + live bonus grant — the products_synced rule, per kind. */
async function syncCap(shopId: string, kind: ContentKind): Promise<number> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  return getQuota(shop?.plan ?? "free", QUOTA[kind]) + (await bonusQuota(shopId, QUOTA[kind]));
}

/**
 * Walk a paginated connection up to `cap` items, oldest-cursor-safe.
 *
 * A GraphQL error THROWS rather than returning what was collected so far:
 * the caller prunes every row it did not see, so treating a failed page as
 * "the end of the list" would delete live content.
 */
async function collect<T>(
  shopDomain: string,
  query: string,
  field: "pages" | "articles",
  cap: number,
): Promise<{ nodes: T[]; capped: boolean }> {
  const { admin } = await unauthenticated.admin(shopDomain);
  const nodes: T[] = [];
  let cursor: string | null = null;
  let capped = false;
  do {
    const response = await admin.graphql(query, { variables: { cursor } });
    const body = (await response.json()) as {
      data?: Record<string, { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] } | undefined>;
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) throw new Error(`${field} sync: ${body.errors.map((e) => e.message).join("; ")}`);
    const connection = body.data?.[field];
    if (!connection) throw new Error(`${field} sync: ${field} missing from the Admin API response`);
    let page = connection.nodes;
    if (nodes.length + page.length > cap) {
      page = page.slice(0, Math.max(0, cap - nodes.length));
      capped = true;
    }
    nodes.push(...page);
    cursor = !capped && connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return { nodes, capped };
}

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? 0) === (b?.getTime() ?? 0);

export async function fullPageSync(shopDomain: string): Promise<ContentSyncResult | null> {
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return null;
  const cap = await syncCap(shopId, "pages");
  const { nodes, capped } = await collect<PageNode>(shopDomain, PAGES_QUERY, "pages", cap);
  const tombstones = await loadLearnTombstones(shopId, "pages");

  const before = new Map(
    (
      await db.storePage.findMany({
        where: { shopId },
        select: { shopifyPageId: true, shopifyUpdatedAt: true },
      })
    ).map((row) => [row.shopifyPageId, row.shopifyUpdatedAt]),
  );
  let changed = false;
  const seen: string[] = [];
  for (const node of nodes) {
    const fields = pageRowFields(node);
    if (!before.has(node.id) || !sameTime(before.get(node.id) ?? null, fields.shopifyUpdatedAt)) {
      changed = true;
    }
    await db.storePage.upsert({
      where: { shopId_shopifyPageId: { shopId, shopifyPageId: node.id } },
      // learnEnabled only on CREATE: a draft arrives off; the merchant's later
      // per-row choice is never overwritten by a sync. A pruned-then-recreated
      // row consults the tombstones (spec 23 §4.6) so an explicit learn-off
      // choice survives the round trip.
      create: {
        shopId,
        shopifyPageId: node.id,
        ...fields,
        learnEnabled: fields.isPublished && !tombstones.disabled.has(node.id),
      },
      update: fields,
    });
    seen.push(node.id);
  }
  // Correct on a capped run too — see PAGES_QUERY. Rows about to be pruned
  // leave their learn-off choice behind as a tombstone (and clear a stale one
  // when pruned while enabled).
  const pruning = await db.storePage.findMany({
    where: { shopId, shopifyPageId: { notIn: seen } },
    select: { shopifyPageId: true, learnEnabled: true },
  });
  for (const row of pruning) {
    if (row.learnEnabled) tombstones.disabled.delete(row.shopifyPageId);
    else tombstones.disabled.add(row.shopifyPageId);
  }
  const pruned = (await db.storePage.deleteMany({ where: { shopId, shopifyPageId: { notIn: seen } } }))
    .count;
  if (pruned > 0) {
    changed = true;
    await saveLearnTombstones(shopId, tombstones);
  }

  await db.syncState.upsert({
    where: { shopId },
    update: { pageSyncAt: new Date() },
    create: { shopId, pageSyncAt: new Date() },
  });
  await recordEvent(shopId, "pages_synced", { pages: seen.length, capped, pruned });
  if (changed) await rebuildContentBridge(shopId, "pages", { inline: true });
  return { synced: seen.length, capped, pruned, changed };
}

export async function fullArticleSync(shopDomain: string): Promise<ContentSyncResult | null> {
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return null;
  const cap = await syncCap(shopId, "blogs");
  const { nodes, capped } = await collect<ArticleNode>(shopDomain, ARTICLES_QUERY, "articles", cap);
  const tombstones = await loadLearnTombstones(shopId, "blogs");

  const before = new Map(
    (
      await db.blogArticle.findMany({
        where: { shopId },
        select: { shopifyArticleId: true, shopifyUpdatedAt: true },
      })
    ).map((row) => [row.shopifyArticleId, row.shopifyUpdatedAt]),
  );
  let changed = false;
  const seen: string[] = [];
  for (const node of nodes) {
    const fields = articleRowFields(node);
    if (!before.has(node.id) || !sameTime(before.get(node.id) ?? null, fields.shopifyUpdatedAt)) {
      changed = true;
    }
    await db.blogArticle.upsert({
      where: { shopId_shopifyArticleId: { shopId, shopifyArticleId: node.id } },
      create: {
        shopId,
        shopifyArticleId: node.id,
        ...fields,
        learnEnabled: fields.isPublished && !tombstones.disabled.has(node.id),
      },
      update: fields,
    });
    seen.push(node.id);
  }
  const pruningArticles = await db.blogArticle.findMany({
    where: { shopId, shopifyArticleId: { notIn: seen } },
    select: { shopifyArticleId: true, learnEnabled: true },
  });
  for (const row of pruningArticles) {
    if (row.learnEnabled) tombstones.disabled.delete(row.shopifyArticleId);
    else tombstones.disabled.add(row.shopifyArticleId);
  }
  const pruned = (
    await db.blogArticle.deleteMany({ where: { shopId, shopifyArticleId: { notIn: seen } } })
  ).count;
  if (pruned > 0) {
    changed = true;
    await saveLearnTombstones(shopId, tombstones);
  }

  await db.syncState.upsert({
    where: { shopId },
    update: { articleSyncAt: new Date() },
    create: { shopId, articleSyncAt: new Date() },
  });
  await recordEvent(shopId, "articles_synced", { articles: seen.length, capped, pruned });
  if (changed) await rebuildContentBridge(shopId, "blogs", { inline: true });
  return { synced: seen.length, capped, pruned, changed };
}

// ── Learn-choice tombstones (spec 23 §4.6) ──────────────────────────────────
// Cap-driven pruning deletes rows, and learnEnabled is only set on create — so
// a page the merchant explicitly excluded came back LEARN-ENABLED when churn
// pushed it out of the top-N and an edit brought it back. Disabled GIDs are
// remembered on the kind's bridge source (metadata.learnDisabled) and
// consulted on re-create; a row pruned while ENABLED clears its stale entry.

const LEARN_TOMBSTONE_CAP = 2000;

interface LearnTombstones {
  sourceId: string;
  disabled: Set<string>;
}

async function loadLearnTombstones(shopId: string, kind: ContentKind): Promise<LearnTombstones> {
  const sourceId = await ensureBridgeSource(shopId, kind);
  const row = await db.dataSource.findFirst({
    where: { id: sourceId, shopId },
    select: { metadata: true },
  });
  const list = (row?.metadata as { learnDisabled?: unknown } | null)?.learnDisabled;
  return {
    sourceId,
    disabled: new Set(
      Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [],
    ),
  };
}

async function saveLearnTombstones(shopId: string, tombstones: LearnTombstones): Promise<void> {
  const row = await db.dataSource.findFirst({
    where: { id: tombstones.sourceId, shopId },
    select: { metadata: true },
  });
  const meta = {
    ...((row?.metadata ?? {}) as Record<string, unknown>),
    learnDisabled: [...tombstones.disabled].slice(-LEARN_TOMBSTONE_CAP),
  };
  await db.dataSource.updateMany({
    where: { id: tombstones.sourceId, shopId },
    data: { metadata: meta as Prisma.InputJsonValue },
  });
}

/** The kind's bridge DataSource, created on first use. */
export async function ensureBridgeSource(shopId: string, kind: ContentKind): Promise<string> {
  requireShopId(shopId);
  const type = BRIDGE_TYPE[kind];
  const existing = await db.dataSource.findFirst({ where: { shopId, type }, select: { id: true } });
  if (existing) return existing.id;
  const created = await db.dataSource.create({
    data: { shopId, type, name: BRIDGE_NAME[kind], status: "pending" },
    select: { id: true },
  });
  return created.id;
}

/**
 * Re-embed what the agent may read for this kind. `inline` from inside a sync
 * job (already in the background); enqueued from admin actions so a toggle
 * click never waits on embedding.
 */
export async function rebuildContentBridge(
  shopId: string,
  kind: ContentKind,
  options: { inline?: boolean } = {},
): Promise<void> {
  const sourceId = await ensureBridgeSource(shopId, kind);
  if (options.inline) {
    const { ingestSource } = await import("./knowledge-ingest.server");
    await ingestSource(shopId, sourceId);
    return;
  }
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
  if (!shop) return;
  const [{ enqueue }, { KNOWLEDGE_INGEST_JOB }] = await Promise.all([
    import("../jobs/queue.server"),
    import("./knowledge-jobs.server"),
  ]);
  await db.dataSource.updateMany({ where: { id: sourceId, shopId }, data: { status: "pending" } });
  await enqueue(KNOWLEDGE_INGEST_JOB, { shopDomain: shop.domain, sourceId });
}
