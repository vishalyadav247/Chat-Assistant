import { z } from "zod";
import db from "../../db.server";
import { env } from "../env.server";
import { decryptSecret, encryptSecret, maskSecret } from "./secrets-crypto.server";
import { logError } from "../log.server";

// Operator-managed runtime settings (spec 19). Everything here used to require
// an .env edit + redeploy; it is now editable at /platform/settings and stored
// in app_secrets["platform:runtime"].
//
// PRECEDENCE: a value set in the dashboard WINS; a blank/absent value falls
// back to the environment variable, then to the built-in default. That keeps
// existing deployments working untouched while letting the operator change
// anything without shipping code.
//
// Accessors are SYNC (a cached snapshot refreshed every 30s, eagerly loaded at
// boot) so the many existing call sites keep their signatures. Reads never
// throw: on any DB problem the last-known snapshot — or plain env — is used.

export const RUNTIME_SECRET_KEY = "platform:runtime";

/** Fields sealed with AES-GCM before they touch the database. */
export const SECRET_FIELDS = ["openaiApiKey", "resendApiKey", "smtpPass"] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

export const runtimeConfigSchema = z.object({
  // AI provider
  openaiApiKey: z.string().trim().max(300).optional().default(""),
  // Email delivery
  emailProvider: z.enum(["log", "resend", "smtp"]).optional(),
  emailFrom: z.string().trim().max(200).optional().default(""),
  resendApiKey: z.string().trim().max(300).optional().default(""),
  smtpHost: z.string().trim().max(200).optional().default(""),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().trim().max(200).optional().default(""),
  smtpPass: z.string().max(300).optional().default(""),
  smtpSecure: z.boolean().optional(),
  // Links & listing
  webAppUrl: z.string().trim().max(300).optional().default(""),
  appStoreHandle: z.string().trim().max(120).optional().default(""),
  // Operational flags
  billingTestMode: z.boolean().optional(),
  billingForceTestCharges: z.boolean().optional(),
  embedStatusEnabled: z.boolean().optional(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

/** The values the app actually runs on (dashboard → env → default). */
export interface EffectiveRuntime {
  openaiApiKey: string;
  emailProvider: "log" | "resend" | "smtp";
  emailFrom: string;
  resendApiKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: boolean;
  webAppUrl: string;
  appStoreHandle: string;
  billingTestMode: boolean;
  billingForceTestCharges: boolean;
  embedStatusEnabled: boolean;
}

export type ConfigSource = "dashboard" | "environment" | "default";

const REFRESH_TTL_MS = 30_000;

let stored: RuntimeConfig = runtimeConfigSchema.parse({});
let lastLoadedAt = 0;
let loading: Promise<void> | null = null;

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Read + decrypt the stored row. Never throws. */
export async function loadRuntimeConfig(): Promise<void> {
  try {
    const row = await db.appSecret.findUnique({ where: { key: RUNTIME_SECRET_KEY } });
    if (!row) {
      stored = runtimeConfigSchema.parse({});
    } else {
      const raw = JSON.parse(row.value) as Record<string, unknown>;
      for (const field of SECRET_FIELDS) {
        if (typeof raw[field] === "string") raw[field] = decryptSecret(raw[field] as string);
      }
      const parsed = runtimeConfigSchema.safeParse(raw);
      if (parsed.success) stored = parsed.data;
      else logError("platform_runtime_config_invalid", parsed.error.issues[0]);
    }
  } catch (error) {
    logError("platform_runtime_config_load_error", error);
  }
  lastLoadedAt = Date.now();
}

function maybeRefresh(): void {
  if (Date.now() - lastLoadedAt < REFRESH_TTL_MS || loading) return;
  loading = loadRuntimeConfig().finally(() => {
    loading = null;
  });
}

// Eager load so the first request already sees dashboard values.
void loadRuntimeConfig().catch(() => undefined);

/** The effective runtime settings. Sync, cached, never throws. */
export function runtimeConfig(): EffectiveRuntime {
  maybeRefresh();
  const e = env();
  return {
    openaiApiKey: stored.openaiApiKey || e.OPENAI_API_KEY,
    emailProvider: stored.emailProvider ?? e.EMAIL_PROVIDER,
    emailFrom: stored.emailFrom || e.EMAIL_FROM,
    resendApiKey: stored.resendApiKey || e.RESEND_API_KEY,
    smtpHost: stored.smtpHost || e.SMTP_HOST,
    smtpPort: stored.smtpPort ?? e.SMTP_PORT,
    smtpUser: stored.smtpUser || e.SMTP_USER,
    smtpPass: stored.smtpPass || e.SMTP_PASS,
    smtpSecure: stored.smtpSecure ?? e.SMTP_SECURE,
    webAppUrl: stored.webAppUrl || e.WEB_APP_URL || process.env.SHOPIFY_APP_URL || "",
    appStoreHandle: stored.appStoreHandle || e.SHOPIFY_APP_STORE_HANDLE,
    billingTestMode: stored.billingTestMode ?? envBool("BILLING_TEST_MODE") ?? false,
    billingForceTestCharges:
      stored.billingForceTestCharges ?? envBool("BILLING_FORCE_TEST_CHARGES") ?? false,
    embedStatusEnabled: stored.embedStatusEnabled ?? envBool("EMBED_STATUS_ENABLED") ?? false,
  };
}

/** The raw dashboard-stored values (secrets in the clear) — server-only. */
export function storedRuntimeConfig(): RuntimeConfig {
  maybeRefresh();
  return stored;
}

/** Merge a patch into the stored config, sealing secrets, then reload. */
export async function saveRuntimeConfig(patch: Partial<RuntimeConfig>): Promise<void> {
  const merged = runtimeConfigSchema.parse({ ...stored, ...patch });
  const forStorage: Record<string, unknown> = { ...merged };
  for (const field of SECRET_FIELDS) {
    forStorage[field] = encryptSecret(merged[field] ?? "");
  }
  const json = JSON.stringify(forStorage);
  await db.appSecret.upsert({
    where: { key: RUNTIME_SECRET_KEY },
    create: { key: RUNTIME_SECRET_KEY, value: json },
    update: { value: json },
  });
  await loadRuntimeConfig();
}

/** Drop all dashboard values → everything reverts to env/defaults. */
export async function resetRuntimeConfig(): Promise<void> {
  await db.appSecret.deleteMany({ where: { key: RUNTIME_SECRET_KEY } });
  await loadRuntimeConfig();
}

/** Where each effective value comes from — shown beside every field in the UI. */
export function configSources(): Record<keyof EffectiveRuntime, ConfigSource> {
  maybeRefresh();
  const e = env();
  const pick = (dash: unknown, envSet: boolean): ConfigSource =>
    dash !== undefined && dash !== "" ? "dashboard" : envSet ? "environment" : "default";
  return {
    openaiApiKey: pick(stored.openaiApiKey, Boolean(e.OPENAI_API_KEY)),
    emailProvider: pick(stored.emailProvider, Boolean(process.env.EMAIL_PROVIDER)),
    emailFrom: pick(stored.emailFrom, Boolean(process.env.EMAIL_FROM)),
    resendApiKey: pick(stored.resendApiKey, Boolean(e.RESEND_API_KEY)),
    smtpHost: pick(stored.smtpHost, Boolean(e.SMTP_HOST)),
    smtpPort: pick(stored.smtpPort, Boolean(process.env.SMTP_PORT)),
    smtpUser: pick(stored.smtpUser, Boolean(e.SMTP_USER)),
    smtpPass: pick(stored.smtpPass, Boolean(e.SMTP_PASS)),
    smtpSecure: pick(stored.smtpSecure, Boolean(process.env.SMTP_SECURE)),
    webAppUrl: pick(stored.webAppUrl, Boolean(e.WEB_APP_URL || process.env.SHOPIFY_APP_URL)),
    appStoreHandle: pick(stored.appStoreHandle, Boolean(e.SHOPIFY_APP_STORE_HANDLE)),
    billingTestMode: pick(stored.billingTestMode, envBool("BILLING_TEST_MODE") !== undefined),
    billingForceTestCharges: pick(
      stored.billingForceTestCharges,
      envBool("BILLING_FORCE_TEST_CHARGES") !== undefined,
    ),
    embedStatusEnabled: pick(stored.embedStatusEnabled, envBool("EMBED_STATUS_ENABLED") !== undefined),
  };
}

/** Masked snapshot safe to send to the browser (never raw secrets). */
export function runtimeConfigForUi() {
  const effective = runtimeConfig();
  const sources = configSources();
  return {
    sources,
    openaiApiKeyMasked: maskSecret(effective.openaiApiKey),
    resendApiKeyMasked: maskSecret(effective.resendApiKey),
    smtpPassSet: Boolean(effective.smtpPass),
    emailProvider: effective.emailProvider,
    emailFrom: effective.emailFrom,
    smtpHost: effective.smtpHost,
    smtpPort: effective.smtpPort,
    smtpUser: effective.smtpUser,
    smtpSecure: effective.smtpSecure,
    webAppUrl: effective.webAppUrl,
    appStoreHandle: effective.appStoreHandle,
    billingTestMode: effective.billingTestMode,
    billingForceTestCharges: effective.billingForceTestCharges,
    embedStatusEnabled: effective.embedStatusEnabled,
  };
}
