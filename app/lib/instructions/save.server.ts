import { z } from "zod";
import type { Prisma } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { invalidateShopConfig } from "../config/shop-config.server";
import { requirePlan } from "../billing/plans.server";
import { handoverConfigSchema, type HandoverConfigData } from "../settings/schemas";

// Instructions save workflow (spec 08): General tab → Persona + Guardrails,
// Product recommendations tab → Recommendation / CustomRecommendation /
// CrossSellPair rows, Human handover tab → HandoverConfig.config (zod shape
// from app/lib/settings/schemas.ts — the canonical, frozen config shape).
//
// Every function takes a TRUSTED shopId (from authenticate.admin) and scopes
// every query. Persona/guardrails/handover saves invalidate the per-shop
// config cache so the pipeline picks changes up on the next turn. Banned-topic
// vectors need NO re-embed job: the meaning-scan cache in
// app/lib/pipeline/guardrail.server.ts keys its vectors by the topic list
// itself, so a changed list re-embeds lazily on the next scan. The same
// pattern covers recommendation trigger questions —
// app/lib/search/recommendation-match.server.ts caches per-trigger vectors
// keyed by a trigger fingerprint, so saving the row is enough.

export const COMMUNICATION_STYLES = ["friendly", "professional", "empathetic", "custom"] as const;
export const LANGUAGES = ["en", "hi", "es", "fr", "de"] as const;

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const COLLECTION_GID = /^gid:\/\/shopify\/Collection\/\d+$/;

const productGid = z.string().regex(PRODUCT_GID, "invalid product id");
const collectionGid = z.string().regex(COLLECTION_GID, "invalid collection id");

// Server-side length caps mirror the UI counters (spec 08 business rules).
const generalSchema = z.object({
  role: z.string().max(250),
  communicationStyle: z.enum(COMMUNICATION_STYLES),
  brandVoice: z.string().max(500),
  behaviours: z.string().max(1000),
  defaultLanguage: z.enum(LANGUAGES),
  autoDetectLanguage: z.boolean(),
  bannedTopics: z.array(z.string().min(1).max(100)).max(50),
  fallbackMessage: z.string().max(500),
});
export type GeneralInstructionsData = z.infer<typeof generalSchema>;

const recommendationSchema = z.object({
  id: z.string().max(40).optional(),
  title: z.string().min(1).max(100),
  triggerQuestions: z.array(z.string().min(1).max(150)).min(1).max(20),
  productIds: z.array(productGid).max(50),
  status: z.enum(["active", "inactive"]),
});

const customRecommendationSchema = z.object({
  id: z.string().max(40).optional(),
  name: z.string().min(1).max(100),
  searchTerms: z.array(z.string().min(1).max(100)).min(1).max(30),
  productIds: z.array(productGid).max(100),
  collectionIds: z.array(collectionGid).max(30),
  status: z.enum(["active", "inactive"]),
});

const crossSellSchema = z.object({
  productId: productGid,
  companionIds: z.array(productGid).min(1).max(20),
});

// ── General tab ─────────────────────────────────────────────────────────────

export async function saveGeneralInstructions(
  shopId: string,
  plan: string,
  raw: unknown,
): Promise<void> {
  requireShopId(shopId);
  const data = generalSchema.parse(raw);

  // Plan gate (spec 08 AC2): auto-detect language is Plus-only. Open mode is
  // currently active (plans.server.ts), but the seam rejects server-side the
  // moment enforcement flips on.
  if (data.autoDetectLanguage) {
    requirePlan(plan, "auto_detect_language");
  }

  const personaData = {
    role: data.role.trim(),
    communicationStyle: data.communicationStyle,
    brandVoice: data.brandVoice.trim(),
    behaviours: data.behaviours.trim(),
    defaultLanguage: data.defaultLanguage,
    autoDetectLanguage: data.autoDetectLanguage,
  };
  const bannedTopics = [...new Set(data.bannedTopics.map((t) => t.trim()).filter(Boolean))];
  const guardrailsData = {
    bannedTopics,
    fallbackMessage: data.fallbackMessage.trim(),
  };

  await db.$transaction([
    db.persona.upsert({
      where: { shopId },
      update: personaData,
      create: { shopId, ...personaData },
    }),
    db.guardrails.upsert({
      where: { shopId },
      update: guardrailsData,
      create: { shopId, ...guardrailsData },
    }),
  ]);
  invalidateShopConfig(shopId);
}

// ── App recommendations ─────────────────────────────────────────────────────

export async function saveRecommendation(shopId: string, raw: unknown): Promise<string> {
  requireShopId(shopId);
  const data = recommendationSchema.parse(raw);
  const fields = {
    title: data.title.trim(),
    triggerQuestions: [...new Set(data.triggerQuestions.map((q) => q.trim()).filter(Boolean))],
    productIds: [...new Set(data.productIds)],
    status: data.status,
  };
  if (data.id) {
    const result = await db.recommendation.updateMany({
      where: { id: data.id, shopId },
      data: fields,
    });
    if (result.count === 0) throw new Error("Recommendation not found");
    return data.id;
  }
  const created = await db.recommendation.create({ data: { shopId, ...fields } });
  return created.id;
  // No embedding write needed: recommendation-match.server.ts embeds triggers
  // lazily, keyed by `${id}:${triggers}` fingerprint — a changed row misses
  // the cache and re-embeds on the next matching turn.
}

export async function setRecommendationStatus(
  shopId: string,
  id: string,
  status: "active" | "inactive",
): Promise<void> {
  requireShopId(shopId);
  await db.recommendation.updateMany({ where: { id, shopId }, data: { status } });
}

export async function deleteRecommendation(shopId: string, id: string): Promise<void> {
  requireShopId(shopId);
  await db.recommendation.deleteMany({ where: { id, shopId } });
}

// ── Custom recommendations (config only — runtime lands with a pipeline
//    enhancement; spec 08 delta noted in the feature report) ────────────────

export async function saveCustomRecommendation(shopId: string, raw: unknown): Promise<string> {
  requireShopId(shopId);
  const data = customRecommendationSchema.parse(raw);
  if (data.productIds.length === 0 && data.collectionIds.length === 0) {
    throw new Error("Add at least one product or collection");
  }
  const fields = {
    name: data.name.trim(),
    searchTerms: [...new Set(data.searchTerms.map((t) => t.trim()).filter(Boolean))],
    productIds: [...new Set(data.productIds)],
    collectionIds: [...new Set(data.collectionIds)],
    status: data.status,
  };
  if (data.id) {
    const result = await db.customRecommendation.updateMany({
      where: { id: data.id, shopId },
      data: fields,
    });
    if (result.count === 0) throw new Error("Custom recommendation not found");
    return data.id;
  }
  const created = await db.customRecommendation.create({ data: { shopId, ...fields } });
  return created.id;
}

export async function setCustomRecommendationStatus(
  shopId: string,
  id: string,
  status: "active" | "inactive",
): Promise<void> {
  requireShopId(shopId);
  await db.customRecommendation.updateMany({ where: { id, shopId }, data: { status } });
}

export async function deleteCustomRecommendation(shopId: string, id: string): Promise<void> {
  requireShopId(shopId);
  await db.customRecommendation.deleteMany({ where: { id, shopId } });
}

// ── Cross-sell pairs (config only — runtime deferred) ───────────────────────

export async function saveCrossSellPair(shopId: string, raw: unknown): Promise<void> {
  requireShopId(shopId);
  const data = crossSellSchema.parse(raw);
  const companionIds = [...new Set(data.companionIds.filter((id) => id !== data.productId))];
  if (companionIds.length === 0) throw new Error("Pick at least one companion product");
  await db.crossSellPair.upsert({
    where: { shopId_productId: { shopId, productId: data.productId } },
    update: { companionIds, status: "active" },
    create: { shopId, productId: data.productId, companionIds },
  });
}

export async function deleteCrossSellPair(shopId: string, id: string): Promise<void> {
  requireShopId(shopId);
  await db.crossSellPair.deleteMany({ where: { id, shopId } });
}

// ── Human handover tab ──────────────────────────────────────────────────────

export async function saveHandoverConfig(shopId: string, raw: unknown): Promise<HandoverConfigData> {
  requireShopId(shopId);
  // Strict shape: the canonical handoverConfigSchema `.catch()`es every field,
  // so unknown/invalid input degrades to defaults rather than persisting junk.
  const config = handoverConfigSchema.parse(raw);
  await db.handoverConfig.upsert({
    where: { shopId },
    update: { config: config as unknown as Prisma.InputJsonObject },
    create: { shopId, config: config as unknown as Prisma.InputJsonObject },
  });
  invalidateShopConfig(shopId);
  return config;
}
