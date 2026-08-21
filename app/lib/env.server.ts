import { z } from "zod";

// Fail fast at boot on misconfiguration. Imported by shopify.server.ts.
//
// ⚠️ Most values below are now FALLBACKS. Since spec 19 the operator sets them
// at /platform/settings (stored in app_secrets, secrets encrypted) and the
// dashboard value WINS — see app/lib/platform/runtime-config.server.ts.
// Env still matters for: first boot before anything is configured, and the
// infrastructure values the app cannot start without (DATABASE_URL, the
// SHOPIFY_* pair injected by the CLI/host).
const envSchema = z.object({
  // Infrastructure — env only, no dashboard equivalent.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Dashboard-managed (Settings → OpenAI API key); env = fallback.
  OPENAI_API_KEY: z.string().optional().default(""),
  // Only one implementation exists; a dashboard toggle would be meaningless.
  LLM_PROVIDER: z.enum(["openai"]).default("openai"),
  // Dashboard-managed (AI model settings); env = fallback.
  CHAT_MODEL: z.string().default("gpt-4o-mini"),
  // Env only ON PURPOSE: stored vectors are pinned to 1536 dims, so changing
  // this needs a re-embed migration, not a settings toggle.
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  // Dashboard-managed (Settings → Links & listing); env = fallback.
  SHOPIFY_APP_STORE_HANDLE: z.string().optional().default(""),
  // ── Standalone web surface (spec 18) — ALL dashboard-managed, env = fallback ──
  // Public origin used in invite / reset / notification links. Defaults to
  // SHOPIFY_APP_URL (same host serves both surfaces).
  WEB_APP_URL: z.string().optional().default(""),
  // Transactional email. "log" prints the message (and the UI falls back to
  // copy-link); "resend" posts to the Resend HTTPS API.
  EMAIL_PROVIDER: z.enum(["log", "resend", "smtp"]).default("log"),
  RESEND_API_KEY: z.string().optional().default(""),
  // SMTP (any mailbox / SES / Gmail app password) — used when EMAIL_PROVIDER=smtp.
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().positive().optional().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  EMAIL_FROM: z.string().optional().default("ChatConvert <no-reply@example.com>"),
  // ── Platform admin panel (spec 19) ──
  // First-run bootstrap ONLY: while zero platform admins exist, logging in at
  // /platform/login with exactly these credentials creates the account.
  // Canonical path: `npx tsx scripts/platform-admin.ts create <email> <name> <password>`.
  PLATFORM_ADMIN_EMAIL: z.string().optional().default(""),
  PLATFORM_ADMIN_PASSWORD: z.string().optional().default(""),
  // Web Push (VAPID). Generate once: `npx web-push generate-vapid-keys`.
  // Push is silently disabled while the keys are blank.
  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
  VAPID_SUBJECT: z.string().optional().default("mailto:support@example.com"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(
        `Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    cached = parsed.data;
  }
  return cached;
}
