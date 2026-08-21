import { z } from "zod";
import db from "../../db.server";
import { env } from "../env.server";
import {
  loadPlanConfig,
  planConfigSchema,
  PLAN_CONFIG_SECRET_KEY,
  type PlanConfig,
} from "../billing/plans.server";
import { logError } from "../log.server";
import { chatModelError } from "../llm/models";

// Global operator settings (spec 19), stored in the app_secrets KV. Cross-tenant
// BY DESIGN — these values apply to every installed shop. Reads are cached and
// FAIL OPEN to defaults: the AI pipeline must never die over a config row.

export const AI_SECRET_KEY = "platform:ai";

export const aiOverridesSchema = z.object({
  // "" / absent = env CHAT_MODEL. Shape-validated here so a typo/pasted
  // sentence can never become every tenant's chat model (QA 2026-08-21).
  chatModel: z
    .string()
    .trim()
    .max(100)
    .optional()
    .default("")
    .refine((v) => chatModelError(v) === null, {
      message: "Model id may only contain letters, numbers and . _ - : (no spaces).",
    }),
  // These apply ONLY to calls that are not pinned — i.e. shopper-visible reply
  // generation. Router and summary calls keep their tuned values; see
  // `resolveSampling` in app/lib/llm/openai.server.ts.
  temperature: z.number().min(0).max(2).nullable().optional().default(null),
  maxTokens: z.number().int().min(16).max(16384).nullable().optional().default(null),
});

export type AiOverrides = z.infer<typeof aiOverridesSchema>;

const AI_DEFAULTS: AiOverrides = { chatModel: "", temperature: null, maxTokens: null };
const CACHE_TTL_MS = 30_000;

let cached: AiOverrides = AI_DEFAULTS;
let cachedAt = 0;
let loading: Promise<AiOverrides> | null = null;

/** Current overrides, cached 30s, fail-open to defaults on any error. */
export function getAiOverrides(): Promise<AiOverrides> {
  if (Date.now() - cachedAt < CACHE_TTL_MS) return Promise.resolve(cached);
  if (!loading) {
    loading = (async () => {
      try {
        const row = await db.appSecret.findUnique({ where: { key: AI_SECRET_KEY } });
        const parsed = row ? aiOverridesSchema.safeParse(JSON.parse(row.value)) : null;
        cached = parsed?.success ? parsed.data : AI_DEFAULTS;
        if (parsed && !parsed.success) logError("platform_ai_config_invalid", parsed.error.issues[0]);
      } catch (error) {
        logError("platform_ai_config_load_error", error);
      }
      cachedAt = Date.now();
      return cached;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

export async function saveAiOverrides(value: AiOverrides): Promise<void> {
  const clean = aiOverridesSchema.parse(value);
  const json = JSON.stringify(clean);
  await db.appSecret.upsert({
    where: { key: AI_SECRET_KEY },
    create: { key: AI_SECRET_KEY, value: json },
    update: { value: json },
  });
  cached = clean;
  cachedAt = Date.now();
}

// ── Embedding-model marker (QA 2026-08-21) ──────────────────────────────────
// Stored vectors carry no record of which model produced them, and a product's
// contentHash is a hash of its TEXT only — so after switching EMBEDDING_MODEL
// the re-embed script saw "0 to re-embed" while every stored vector silently
// belonged to the old model's coordinate space. This marker is the missing
// record: `scripts/reembed-products.ts` compares it against env
// EMBEDDING_MODEL, treats a mismatch as "everything is stale", and advances it
// only after a clean pass.

export const EMBEDDING_MODEL_KEY = "platform:embedding-model";

/** Model the stored vectors were built with; null = never recorded. */
export async function getEmbeddingModelMarker(): Promise<string | null> {
  try {
    const row = await db.appSecret.findUnique({ where: { key: EMBEDDING_MODEL_KEY } });
    return row?.value?.trim() || null;
  } catch (error) {
    logError("embedding_model_marker_read_error", error);
    return null;
  }
}

export async function setEmbeddingModelMarker(model: string): Promise<void> {
  const value = model.trim();
  await db.appSecret.upsert({
    where: { key: EMBEDDING_MODEL_KEY },
    create: { key: EMBEDDING_MODEL_KEY, value },
    update: { value },
  });
}

/** Effective values for the dashboard UI (override merged over env defaults). */
export async function getEffectiveAiConfig() {
  const overrides = await getAiOverrides();
  const e = env();
  const embeddingMarker = await getEmbeddingModelMarker();
  return {
    overrides,
    effectiveChatModel: overrides.chatModel || e.CHAT_MODEL,
    envChatModel: e.CHAT_MODEL,
    embeddingModel: e.EMBEDDING_MODEL,
    /** Model the stored vectors were built with (null = never recorded). */
    embeddingMarker,
    /** True when env moved on but the vectors have not been rebuilt yet. */
    embeddingDrift: embeddingMarker !== null && embeddingMarker !== e.EMBEDDING_MODEL,
  };
}

// ── Plan matrix overrides (the matrix itself lives in billing/plans.server) ──

export async function savePlanConfig(config: PlanConfig): Promise<void> {
  const clean = planConfigSchema.parse(config);
  const json = JSON.stringify(clean);
  await db.appSecret.upsert({
    where: { key: PLAN_CONFIG_SECRET_KEY },
    create: { key: PLAN_CONFIG_SECRET_KEY, value: json },
    update: { value: json },
  });
  await loadPlanConfig();
}

/** Backup key for a plan-config row that could not be parsed (see below). */
const PLAN_CONFIG_BACKUP_KEY = `${PLAN_CONFIG_SECRET_KEY}:corrupt`;

export async function getStoredPlanConfig(): Promise<PlanConfig> {
  const row = await db.appSecret.findUnique({ where: { key: PLAN_CONFIG_SECRET_KEY } }).catch(
    (error: unknown) => {
      logError("plan_config_read_error", error);
      return null;
    },
  );
  if (!row) return {};

  let parsed: ReturnType<typeof planConfigSchema.safeParse>;
  try {
    parsed = planConfigSchema.safeParse(JSON.parse(row.value));
  } catch (error) {
    parsed = { success: false } as ReturnType<typeof planConfigSchema.safeParse>;
    logError("plan_config_unparseable", error);
  }
  if (parsed.success) return parsed.data;

  // A corrupt row used to be swallowed into `{}`. The platform UI then merged
  // the operator's next single-plan edit onto that empty object and wrote it
  // back — silently discarding every OTHER plan's overrides and the enforcement
  // mode (QA D-12). Make it loud, and keep a copy of the unparseable value so
  // the overrides can be recovered by hand instead of being lost on the next
  // save.
  logError("plan_config_corrupt", "stored plan config failed validation — falling back to defaults");
  await db.appSecret
    .upsert({
      where: { key: PLAN_CONFIG_BACKUP_KEY },
      create: { key: PLAN_CONFIG_BACKUP_KEY, value: row.value },
      update: { value: row.value },
    })
    .catch((error: unknown) => logError("plan_config_backup_error", error));
  return {};
}

/** Delete the override row → matrix returns to code defaults. */
export async function resetPlanConfig(): Promise<void> {
  await db.appSecret.deleteMany({ where: { key: PLAN_CONFIG_SECRET_KEY } });
  await loadPlanConfig();
}
