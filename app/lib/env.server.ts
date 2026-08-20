import { z } from "zod";

// Fail fast at boot on misconfiguration. Imported by shopify.server.ts.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  OPENAI_API_KEY: z.string().optional().default(""),
  LLM_PROVIDER: z.enum(["openai"]).default("openai"),
  CHAT_MODEL: z.string().default("gpt-4o-mini"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  // App Store listing handle (apps.shopify.com/<handle>). Blank until the
  // listing is live; while blank the "Leave a review" fallback link is hidden.
  SHOPIFY_APP_STORE_HANDLE: z.string().optional().default(""),
  // ── Standalone web surface (spec 18) ──
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
