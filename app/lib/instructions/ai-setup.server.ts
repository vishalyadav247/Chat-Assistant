import type { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../../db.server";
import { DEFAULT_BRAND_VOICE, DEFAULT_GUARDRAILS, DEFAULT_PERSONA, LEGACY_INSTALL_FALLBACK } from "../ai-defaults";
import { invalidateShopConfig } from "../config/shop-config.server";
import { hashText } from "../ingestion/metafields.server";
import { syncStoreInfoKnowledge } from "../ingestion/knowledge-ingest.server";
import { getLlmProvider } from "../llm/index.server";
import { logError, logWarn } from "../log.server";
import { AI_SETUP_SYSTEM, aiSetupUser } from "../pipeline/prompts";
import { SHOWABLE_PRODUCT } from "../search/showable";
import { shopSettingsSchema, STORE_INFO_MAX, type AiSetupData } from "../settings/schemas";
import { requireShopId } from "../tenancy.server";

// AI setup (spec 26, owner decision 2026-09-15: applied automatically + FAQ
// drafts). After install and the first product sync, one gpt-4.1 call writes
// every Instructions → General field from the store's own Shopify data —
// most merchants never open Instructions, and the generic defaults gave generic
// chats (a crystal-bracelet store greeted shoppers with "accessories or apparel").
//
// Three code guarantees, not prompt hopes:
//   1. factGuard — phone numbers, emails, links and numbers in store info, the
//      fallback message and FAQ answers must appear in the collected data.
//   2. Ownership — a field is rewritten only while it still holds the install
//      default, is empty, or holds the text AI last wrote (settings.aiSetup.hashes).
//      A merchant's edit is never overwritten.
//   3. All-or-nothing — invalid output twice leaves every field as it was.

/**
 * Model that writes the instructions. One call per store, so quality matters
 * more than price here (a chat model runs thousands of times a day; this runs
 * once). Override with AI_SETUP_MODEL to try a stronger model without a code
 * change — it does not affect chat replies.
 */
export const AI_SETUP_MODEL = "gpt-4.1";
export const setupModel = () => (process.env.AI_SETUP_MODEL || "").trim() || AI_SETUP_MODEL;
/** Minimum time between two requested runs for one shop (Regenerate button). */
export const AI_SETUP_COOLDOWN_MS = 10 * 60 * 1000;
/** Waits for collections/discounts/pages/blogs; after this many tries, products alone are enough. */
const WAIT_FOR_CONTENT_ATTEMPTS = 5;
const POLICY_CHARS = 3_000;
const PAGE_CHARS = 2_500;
const MAX_FAQ_DRAFTS = 10;
const LANGS = ["en", "hi", "es", "fr", "de"] as const;

const PAGE_HINT = /about|contact|faq|question|shipping|delivery|return|refund|exchange|wholesale|bulk|size|care|warranty|story/i;

// ── Output schema ───────────────────────────────────────────────────────────

const text = (max: number) => z.string().transform((s) => s.replace(/\r/g, "").trim().slice(0, max));

export const aiSetupOutputSchema = z.object({
  storeInfo: text(STORE_INFO_MAX),
  role: text(250),
  brandVoice: text(500),
  behaviours: text(1000),
  scope: text(300),
  offTopicMessage: text(300),
  fallbackMessage: text(500),
  bannedTopics: z
    .array(z.string())
    .transform((list) =>
      [...new Set(list.map((t) => t.trim().toLowerCase()).filter((t) => t.split(/\s+/).length >= 2 && t.length <= 100))].slice(0, 6),
    ),
  language: z.string().transform((l) => l.trim().toLowerCase()),
  faqDrafts: z
    .array(z.object({ question: z.string(), answer: z.string().nullable().optional() }))
    .transform((list) =>
      list
        .map((f) => ({ question: f.question.trim().slice(0, 300), answer: (f.answer ?? "").trim().slice(0, 600) || null }))
        .filter((f) => f.question.length > 5)
        .slice(0, MAX_FAQ_DRAFTS),
    ),
  conflicts: z.array(z.string()).transform((list) => list.map((c) => c.trim().slice(0, 300)).filter(Boolean).slice(0, 5)),
});
export type AiSetupOutput = z.infer<typeof aiSetupOutputSchema>;

// ── Fact guard (pure, exported for tests) ───────────────────────────────────

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
const URL_OR_DOMAIN = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|net|org|co|io|shop|store|uk|us|ca|au|de|fr|es)(?:\/[^\s)]*)?/gi;
const NUMBER = /\d[\d,.]*\d|\d/g;

const digitsOf = (value: string) => value.replace(/[^\d]/g, "");

/** Everything factual a generated text may cite, from the collected store data. */
export function factIndex(source: string) {
  const lower = source.toLowerCase();
  const numbers = new Set((source.match(NUMBER) ?? []).map((n) => n.replace(/[,]/g, "").replace(/\.0+$/, "")));
  // Phone numbers are often written with spaces/dashes: index their digit runs.
  const digitRuns = new Set((source.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []).map(digitsOf));
  return { lower, numbers, digitRuns };
}

function sentenceSupported(sentence: string, facts: ReturnType<typeof factIndex>): boolean {
  for (const email of sentence.match(EMAIL) ?? []) {
    if (!facts.lower.includes(email.toLowerCase())) return false;
  }
  for (const url of sentence.match(URL_OR_DOMAIN) ?? []) {
    const bare = url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
    if (!facts.lower.includes(bare)) return false;
  }
  for (const phone of sentence.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []) {
    if (!facts.digitRuns.has(digitsOf(phone)) && ![...facts.digitRuns].some((run) => run.endsWith(digitsOf(phone)))) return false;
  }
  for (const raw of sentence.match(NUMBER) ?? []) {
    const n = raw.replace(/[,]/g, "").replace(/\.0+$/, "");
    if (/^\+?\d{7,}$/.test(n)) continue; // phone digits, checked above
    if (!facts.numbers.has(n)) return false;
  }
  return true;
}

/**
 * Removes every sentence/line citing a contact detail, link or number that is
 * not in the store data. Returns the kept text and what was removed.
 */
export function factGuard(generated: string, facts: ReturnType<typeof factIndex>): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = generated.split("\n").map((line) => {
    const sentences = line.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => {
      if (!s.trim() || sentenceSupported(s, facts)) return true;
      removed.push(s.trim());
      return false;
    });
    return kept.join(" ");
  });
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

// ── Ownership (pure, exported for tests) ────────────────────────────────────

export type SetupField =
  | "storeInfo"
  | "role"
  | "brandVoice"
  | "behaviours"
  | "scope"
  | "offTopicMessage"
  | "fallbackMessage"
  | "bannedTopics"
  | "language";

const norm = (value: string) => value.replace(/\s+/g, " ").trim();
export const fieldHash = (value: string) => hashText(norm(value));

const DEFAULTS: Record<SetupField, string[]> = {
  storeInfo: [""],
  role: ["", DEFAULT_PERSONA.role],
  brandVoice: ["", DEFAULT_BRAND_VOICE],
  behaviours: ["", DEFAULT_PERSONA.behaviours],
  scope: [""],
  offTopicMessage: [""],
  fallbackMessage: ["", LEGACY_INSTALL_FALLBACK],
  bannedTopics: ["", [...DEFAULT_GUARDRAILS.bannedTopics].join("\n")],
  language: ["en|false"],
};

/** May AI (re)write this field? Default/empty, or unchanged since AI wrote it. */
export function aiOwns(field: SetupField, current: string, hashes: Record<string, string>): boolean {
  const value = norm(current);
  if (DEFAULTS[field].some((d) => norm(d) === value)) return true;
  return hashes[field] !== undefined && hashes[field] === fieldHash(current);
}

// ── Data collection ─────────────────────────────────────────────────────────

const SHOP_QUERY = `#graphql
  query AiSetupShop {
    shop {
      name
      description
      contactEmail
      currencyCode
      shipsToCountries
      primaryDomain { host }
    }
  }
`;

interface CollectedStore {
  text: string;
  shopName: string;
}

async function collectStoreData(shopId: string, shopDomain: string): Promise<CollectedStore> {
  const parts: string[] = [];
  let shopName = "";

  // Shopify shop fields (no billing address — see store-info.server.ts).
  try {
    const { unauthenticated } = await import("../../shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await admin.graphql(SHOP_QUERY);
    const body = (await response.json()) as {
      data?: {
        shop?: {
          name: string | null;
          description: string | null;
          contactEmail: string | null;
          currencyCode: string | null;
          shipsToCountries: string[] | null;
          primaryDomain: { host: string | null } | null;
        };
      };
    };
    const shop = body.data?.shop;
    if (shop) {
      shopName = shop.name?.trim() ?? "";
      parts.push(
        [
          "## Shop",
          `Name: ${shop.name ?? ""}`,
          shop.primaryDomain?.host ? `Website: ${shop.primaryDomain.host}` : "",
          shop.description ? `Description: ${shop.description}` : "",
          shop.contactEmail ? `Contact email: ${shop.contactEmail}` : "",
          shop.currencyCode ? `Currency: ${shop.currencyCode}` : "",
          shop.shipsToCountries?.length
            ? `Ships to: ${shop.shipsToCountries.length > 12 ? `${shop.shipsToCountries.length} countries` : shop.shipsToCountries.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  } catch (error) {
    logWarn("ai_setup_shop_read_failed", error instanceof Error ? error.message : String(error), { shopId });
  }

  // Legal policies (live), also connected as knowledge sources below.
  try {
    const { fetchShopPolicies } = await import("../ingestion/sources.server");
    const policies = await fetchShopPolicies(shopDomain);
    for (const policy of policies) {
      parts.push(`## ${policy.title}\n${policy.body.replace(/\s+/g, " ").trim().slice(0, POLICY_CHARS)}`);
    }
  } catch (error) {
    logWarn("ai_setup_policies_read_failed", error instanceof Error ? error.message : String(error), { shopId });
  }

  // Store pages that usually hold store facts.
  const pages = await db.storePage.findMany({
    where: { shopId, isPublished: true },
    select: { title: true, handle: true, bodyText: true },
    take: 200,
  });
  for (const page of pages.filter((p) => PAGE_HINT.test(`${p.title} ${p.handle}`) && p.bodyText.trim()).slice(0, 4)) {
    parts.push(`## Page: ${page.title}\n${page.bodyText.replace(/\s+/g, " ").trim().slice(0, PAGE_CHARS)}`);
  }

  // Catalogue shape.
  const [productCount, collections, types, priceAgg, samples, discounts] = await Promise.all([
    db.product.count({ where: { shopId, ...SHOWABLE_PRODUCT } }),
    db.collection.findMany({ where: { shopId, productCount: { gt: 0 } }, orderBy: { productCount: "desc" }, take: 20, select: { title: true } }),
    db.product.groupBy({
      by: ["productType"],
      where: { shopId, ...SHOWABLE_PRODUCT, productType: { not: "" } },
      _count: { _all: true },
      orderBy: { _count: { productType: "desc" } },
      take: 15,
    }),
    db.product.aggregate({ where: { shopId, ...SHOWABLE_PRODUCT }, _min: { price: true }, _max: { price: true } }),
    db.product.findMany({ where: { shopId, ...SHOWABLE_PRODUCT }, orderBy: { updatedAt: "desc" }, take: 30, select: { title: true, tags: true } }),
    db.discount.findMany({ where: { shopId, status: "active" }, take: 10, select: { title: true, summary: true } }),
  ]);
  const tagCounts = new Map<string, number>();
  for (const s of samples) for (const t of s.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  parts.push(
    [
      "## Catalogue",
      `Products for sale: ${productCount}`,
      collections.length ? `Collections: ${collections.map((c) => c.title).join(", ")}` : "",
      types.length ? `Product types: ${types.map((t) => t.productType).join(", ")}` : "",
      priceAgg._min.price !== null ? `Price range: ${priceAgg._min.price} – ${priceAgg._max.price}` : "",
      tagCounts.size ? `Common tags: ${[...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t]) => t).join(", ")}` : "",
      samples.length ? `Example products: ${samples.map((s) => s.title).join(" | ")}` : "",
      discounts.length ? `Active discounts: ${discounts.map((d) => `${d.title}${d.summary ? ` (${d.summary})` : ""}`).join(" | ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return { text: parts.join("\n\n"), shopName };
}

/** Connect every Shopify legal policy that has text as a knowledge source (idempotent). */
async function connectPolicies(shopId: string, shopDomain: string): Promise<number> {
  try {
    const { createSource, fetchShopPolicies } = await import("../ingestion/sources.server");
    const policies = await fetchShopPolicies(shopDomain);
    let connected = 0;
    for (const policy of policies) {
      const exists = await db.dataSource.findFirst({
        where: { shopId, type: "policy", metadata: { path: ["policyType"], equals: policy.type } },
        select: { id: true },
      });
      if (exists) continue;
      await createSource(shopId, { type: "policy", policyType: policy.type, title: policy.title, url: policy.url, body: policy.body });
      connected++;
    }
    return connected;
  } catch (error) {
    logError("ai_setup_connect_policies_error", error, { shopId });
    return 0;
  }
}

// ── Generation ──────────────────────────────────────────────────────────────

async function generate(shopId: string, data: string): Promise<AiSetupOutput> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await getLlmProvider().chat(
        [
          { role: "system", content: AI_SETUP_SYSTEM },
          { role: "user", content: aiSetupUser(data) },
        ],
        { shopId, purpose: "setup" },
        { model: setupModel(), temperature: 0.2, maxTokens: 3000, jsonObject: true, pinnedParams: true },
      );
      return aiSetupOutputSchema.parse(JSON.parse(raw));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("AI setup: invalid model output");
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function saveAiSetupState(shopId: string, patch: Partial<AiSetupData>): Promise<AiSetupData> {
  const row = await db.shopSettings.findUnique({ where: { shopId }, select: { settings: true } });
  const current = shopSettingsSchema.parse(row?.settings ?? {});
  const next = shopSettingsSchema.parse({ ...current, aiSetup: { ...current.aiSetup, ...patch } });
  await db.shopSettings.upsert({
    where: { shopId },
    update: { settings: next as unknown as Prisma.InputJsonObject },
    create: { shopId, settings: next as unknown as Prisma.InputJsonObject },
  });
  return next.aiSetup;
}

export type AiSetupResult =
  | { status: "done"; applied: SetupField[]; kept: SetupField[]; faqDrafts: number; policiesConnected: number; removedFacts: number }
  | { status: "waiting" | "skipped" | "error"; reason: string };

/**
 * Generate and apply the instructions for one shop.
 *
 * `force` is the merchant pressing "Rewrite from my store": it replaces EVERY
 * field, including text they wrote themselves (owner decision 2026-09-16 — a
 * rewrite that silently kept every hand-written field looked like nothing had
 * happened). The automatic run at install never does that: it only fills
 * fields that are empty, still at the install default, or still hold the text
 * AI wrote last time.
 */
export async function runAiSetup(shopDomain: string, opts: { force?: boolean } = {}): Promise<AiSetupResult> {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain }, select: { id: true, uninstalledAt: true } });
  if (!shop || shop.uninstalledAt) return { status: "skipped", reason: "shop not installed" };
  const shopId = requireShopId(shop.id);

  try {
    const [settingsRow, syncState] = await Promise.all([
      db.shopSettings.findUnique({ where: { shopId }, select: { settings: true } }),
      db.syncState.findUnique({
        where: { shopId },
        select: { productSyncAt: true, collectionSyncAt: true, discountSyncAt: true, pageSyncAt: true, articleSyncAt: true, status: true },
      }),
    ]);
    const settings = shopSettingsSchema.parse(settingsRow?.settings ?? {});
    if (settings.aiSetup.status === "done" && !opts.force) return { status: "skipped", reason: "already done" };
    // A run that crashed mid-way must not block the shop forever.
    const runningSince = Date.parse(settings.aiSetup.requestedAt || "");
    if (settings.aiSetup.status === "running" && Number.isFinite(runningSince) && Date.now() - runningSince < 15 * 60 * 1000) {
      return { status: "skipped", reason: "already running" };
    }
    // The instructions are written FROM the store's data, so the first install
    // must finish syncing it first (owner rule 2026-09-16): products, and the
    // collections / discounts / pages / blogs queued beside them. A sync still
    // running counts as unfinished. Pages and blogs can legitimately never
    // arrive (missing scope, no content), so the wait gives up after
    // WAIT_FOR_CONTENT_ATTEMPTS tries and runs with what is there.
    const patient = (settings.aiSetup.attempts ?? 0) < WAIT_FOR_CONTENT_ATTEMPTS;
    const missing = [
      !syncState?.productSyncAt && "products",
      syncState?.status === "running" && "products (still running)",
      patient && !syncState?.collectionSyncAt && "collections",
      patient && !syncState?.discountSyncAt && "discounts",
      patient && !syncState?.pageSyncAt && "pages",
      patient && !syncState?.articleSyncAt && "blog articles",
    ].filter(Boolean) as string[];
    if (missing.length > 0) return { status: "waiting", reason: `waiting for ${missing.join(", ")}` };

    await saveAiSetupState(shopId, { status: "running", requestedAt: new Date().toISOString(), error: "" });
    const policiesConnected = await connectPolicies(shopId, shopDomain);
    const collected = await collectStoreData(shopId, shopDomain);
    const output = await generate(shopId, collected.text);

    const facts = factIndex(collected.text);
    const guardedInfo = factGuard(output.storeInfo, facts);
    const guardedFallback = factGuard(output.fallbackMessage, facts);
    const guardedBehaviours = factGuard(output.behaviours, facts);
    const removedFacts = guardedInfo.removed.length + guardedFallback.removed.length + guardedBehaviours.removed.length;
    if (removedFacts > 0) {
      logWarn("ai_setup_facts_removed", `${removedFacts} unsupported sentence(s) removed`, { shopId, count: removedFacts });
    }

    // Current values, re-read right before writing (a merchant may have saved meanwhile).
    const [persona, guardrails, latestSettingsRow] = await Promise.all([
      db.persona.findUnique({ where: { shopId } }),
      db.guardrails.findUnique({ where: { shopId } }),
      db.shopSettings.findUnique({ where: { shopId }, select: { settings: true } }),
    ]);
    const latest = shopSettingsSchema.parse(latestSettingsRow?.settings ?? {});
    const hashes = { ...latest.aiSetup.hashes };
    const language = (LANGS as readonly string[]).includes(output.language) ? output.language : null;

    const proposed: Record<SetupField, { current: string; next: string }> = {
      storeInfo: { current: latest.storeInfo.about, next: guardedInfo.text },
      role: { current: persona?.role ?? "", next: output.role },
      brandVoice: { current: persona?.brandVoice ?? "", next: output.brandVoice },
      behaviours: { current: persona?.behaviours ?? "", next: guardedBehaviours.text },
      scope: { current: persona?.scope ?? "", next: output.scope },
      offTopicMessage: { current: persona?.offTopicMessage ?? "", next: output.offTopicMessage },
      fallbackMessage: { current: guardrails?.fallbackMessage ?? "", next: guardedFallback.text },
      bannedTopics: { current: (guardrails?.bannedTopics ?? []).join("\n"), next: output.bannedTopics.join("\n") },
      language: {
        current: `${persona?.defaultLanguage ?? "en"}|${persona?.autoDetectLanguage ?? false}`,
        next: language ? `${language}|${persona?.autoDetectLanguage ?? false}` : "",
      },
    };

    const applied: SetupField[] = [];
    const kept: SetupField[] = [];
    for (const field of Object.keys(proposed) as SetupField[]) {
      const { current, next } = proposed[field];
      if (!next.trim() || (!opts.force && !aiOwns(field, current, hashes))) {
        kept.push(field);
        continue;
      }
      applied.push(field);
      hashes[field] = fieldHash(next);
    }
    const take = (field: SetupField) => applied.includes(field);

    const personaData = {
      ...(take("role") ? { role: proposed.role.next } : {}),
      ...(take("brandVoice") ? { brandVoice: proposed.brandVoice.next, communicationStyle: "custom" } : {}),
      ...(take("behaviours") ? { behaviours: proposed.behaviours.next } : {}),
      ...(take("scope") ? { scope: proposed.scope.next } : {}),
      ...(take("offTopicMessage") ? { offTopicMessage: proposed.offTopicMessage.next } : {}),
      ...(take("language") && language ? { defaultLanguage: language } : {}),
    };
    const guardrailsData = {
      ...(take("fallbackMessage") ? { fallbackMessage: proposed.fallbackMessage.next } : {}),
      ...(take("bannedTopics") ? { bannedTopics: output.bannedTopics } : {}),
    };
    const nextSettings = shopSettingsSchema.parse({
      ...latest,
      storeInfo: take("storeInfo") ? { ...latest.storeInfo, about: proposed.storeInfo.next } : latest.storeInfo,
      aiSetup: {
        ...latest.aiSetup,
        status: "done",
        generatedAt: new Date().toISOString(),
        reviewedAt: "",
        model: setupModel(),
        hashes,
        conflicts: output.conflicts,
        applied,
        kept,
        replacedAll: Boolean(opts.force),
        attempts: 0,
        error: "",
      },
    });

    await db.$transaction([
      db.persona.upsert({
        where: { shopId },
        update: personaData,
        create: {
          shopId,
          role: DEFAULT_PERSONA.role,
          brandVoice: DEFAULT_PERSONA.brandVoice,
          behaviours: DEFAULT_PERSONA.behaviours,
          welcomeMessage: DEFAULT_PERSONA.welcomeMessage,
          ...personaData,
        },
      }),
      db.guardrails.upsert({
        where: { shopId },
        update: guardrailsData,
        create: { shopId, ...DEFAULT_GUARDRAILS, bannedTopics: [...DEFAULT_GUARDRAILS.bannedTopics], ...guardrailsData },
      }),
      db.shopSettings.upsert({
        where: { shopId },
        update: { settings: nextSettings as unknown as Prisma.InputJsonObject },
        create: { shopId, settings: nextSettings as unknown as Prisma.InputJsonObject },
      }),
    ]);
    invalidateShopConfig(shopId);
    if (take("storeInfo")) {
      await syncStoreInfoKnowledge(shopId).catch((error) => logError("store_info_knowledge_sync_error", error, { shopId }));
    }

    const faqDrafts = await createFaqDrafts(shopId, output.faqDrafts, facts);
    await saveAiSetupState(shopId, { faqDrafts });
    logWarn("ai_setup_completed", `applied ${applied.length} field(s), ${faqDrafts} FAQ draft(s)`, {
      shopId,
      applied: applied.join(","),
      kept: kept.join(","),
      policiesConnected,
    });
    return { status: "done", applied, kept, faqDrafts, policiesConnected, removedFacts };
  } catch (error) {
    logError("ai_setup_error", error, { shopId });
    await saveAiSetupState(shopId, {
      status: "error",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    }).catch(() => undefined);
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Draft FAQs (never published — they don't reach shoppers or knowledge until
 * the merchant answers and publishes them). Every suggestion is created, with
 * no duplicate filtering (owner rule 2026-09-16): at first install the shop has
 * no FAQs anyway, and on a rewrite the merchant reviews the drafts and
 * publishes or deletes them. Stops at the plan's FAQ quota; answers citing
 * facts that are not in the store's data are dropped.
 */
async function createFaqDrafts(
  shopId: string,
  drafts: AiSetupOutput["faqDrafts"],
  facts: ReturnType<typeof factIndex>,
): Promise<number> {
  if (drafts.length === 0) return 0;
  try {
    const { ensureDefaultCategory } = await import("../faq/faq.server");
    const { getQuota } = await import("../billing/plans.server");
    const [categoryId, existingCount, shop, max] = await Promise.all([
      ensureDefaultCategory(shopId),
      db.faq.count({ where: { shopId } }),
      db.shop.findUnique({ where: { id: shopId }, select: { plan: true } }),
      db.faq.aggregate({ where: { shopId }, _max: { position: true } }),
    ]);
    const quota = getQuota(shop?.plan ?? "free", "faqs");
    let position = max._max.position ?? 0;
    let count = existingCount;
    let created = 0;
    for (const draft of drafts) {
      if (count >= quota) break;
      if (!draft.question.trim()) continue;
      const answer = draft.answer ? factGuard(draft.answer, facts).text : "";
      await db.faq.create({
        data: {
          shopId,
          categoryId,
          question: draft.question,
          answerHtml: answer ? `<p>${escapeHtml(answer)}</p>` : "",
          status: "draft",
          featured: false,
          position: ++position,
        },
      });
      count++;
      created++;
    }
    return created;
  } catch (error) {
    logError("ai_setup_faq_drafts_error", error, { shopId });
    return 0;
  }
}

/** Merchant saved Instructions → General: mark reviewed; edited fields stop being AI-owned. */
export function reviewedAiSetup(
  aiSetup: AiSetupData,
  saved: Partial<Record<SetupField, string>>,
): AiSetupData {
  if (aiSetup.status !== "done") return aiSetup;
  const hashes: Record<string, string> = {};
  for (const [field, hash] of Object.entries(aiSetup.hashes)) {
    const value = saved[field as SetupField];
    if (value === undefined || fieldHash(value) === hash) hashes[field] = hash;
  }
  return { ...aiSetup, hashes, reviewedAt: new Date().toISOString() };
}

/** The merchant read the AI-written instructions and is happy — clears the review notice. */
export async function markAiSetupReviewed(shopId: string): Promise<void> {
  requireShopId(shopId);
  await saveAiSetupState(shopId, { reviewedAt: new Date().toISOString() });
}

/** Queue a run (install, Regenerate). Rate-limited per shop; returns whether it was queued. */
export async function requestAiSetup(shopId: string, shopDomain: string, opts: { force?: boolean } = {}): Promise<boolean> {
  requireShopId(shopId);
  const row = await db.shopSettings.findUnique({ where: { shopId }, select: { settings: true } });
  const current = shopSettingsSchema.parse(row?.settings ?? {}).aiSetup;
  if (opts.force && current.requestedAt && Date.now() - Date.parse(current.requestedAt) < AI_SETUP_COOLDOWN_MS) return false;
  if (!opts.force && ["done", "running", "pending"].includes(current.status)) return false;
  // The install path only queues: it must not rewrite the settings row of a
  // store that is merely re-authenticating (QA-P4 keeps settings byte-identical
  // on re-auth). The job records its own state when it runs.
  if (opts.force) await saveAiSetupState(shopId, { status: "pending", requestedAt: new Date().toISOString(), attempts: 0 });
  const { enqueue } = await import("../jobs/queue.server");
  const { JOBS } = await import("../jobs/handlers.server");
  return enqueue(JOBS.aiSetup, { shopDomain, force: Boolean(opts.force) }, { singletonKey: `${shopDomain}:ai-setup`, singletonSeconds: 60 });
}

/** Job handler: waits for the first product sync (re-queued with a delay), then runs. */
export async function aiSetupJob(data: { shopDomain: string; force?: boolean }): Promise<void> {
  const result = await runAiSetup(data.shopDomain, { force: data.force });
  if (result.status !== "waiting") return;
  const shop = await db.shop.findUnique({ where: { domain: data.shopDomain }, select: { id: true } });
  if (!shop) return;
  const row = await db.shopSettings.findUnique({ where: { shopId: shop.id }, select: { settings: true } });
  const attempts = shopSettingsSchema.parse(row?.settings ?? {}).aiSetup.attempts + 1;
  if (attempts > 10) {
    await saveAiSetupState(shop.id, { status: "skipped", error: "products never synced", attempts });
    return;
  }
  await saveAiSetupState(shop.id, { status: "pending", attempts });
  const { enqueue } = await import("../jobs/queue.server");
  const { JOBS } = await import("../jobs/handlers.server");
  await enqueue(JOBS.aiSetup, data, { startAfter: 180 });
}
