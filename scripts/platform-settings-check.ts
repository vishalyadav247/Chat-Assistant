/* Platform runtime-settings round-trip check (spec 19 settings).
 *   npx tsx scripts/platform-settings-check.ts
 * Proves: values persist to the DB, dashboard overrides beat env, secrets are
 * ENCRYPTED at rest, every wired consumer (LLM key, email, billing, embed
 * status, web links) reads the new value, and reset falls back to env.
 * Restores whatever was stored before it ran.
 */
import db from "../app/db.server";
import {
  RUNTIME_SECRET_KEY,
  loadRuntimeConfig,
  resetRuntimeConfig,
  runtimeConfig,
  saveRuntimeConfig,
  configSources,
} from "../app/lib/platform/runtime-config.server";
import { decryptSecret, isEncrypted } from "../app/lib/platform/secrets-crypto.server";
import { emailConfigured } from "../app/lib/email/email.server";
import { isBillingTestMode } from "../app/lib/billing/shopify-billing.server";
import { webBaseUrl } from "../app/lib/team/team.server";

function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok: ${label}`);
}

async function main() {
  const prior = await db.appSecret.findUnique({ where: { key: RUNTIME_SECRET_KEY } });

  try {
    await resetRuntimeConfig();
    const envKey = process.env.OPENAI_API_KEY ?? "";
    assert(runtimeConfig().openaiApiKey === envKey, "empty config falls back to env OPENAI_API_KEY");
    assert(configSources().openaiApiKey !== "dashboard", "source reads as env/default before any save");

    // 1. Secrets: saved, readable, and sealed on disk
    await saveRuntimeConfig({
      openaiApiKey: "sk-test-DASHBOARD-KEY-12345",
      resendApiKey: "re_test_KEY",
      smtpPass: "smtp-secret-pw",
    });
    assert(runtimeConfig().openaiApiKey === "sk-test-DASHBOARD-KEY-12345", "dashboard key overrides env");
    assert(configSources().openaiApiKey === "dashboard", "source now reports dashboard");

    const raw = await db.appSecret.findUnique({ where: { key: RUNTIME_SECRET_KEY } });
    const stored = JSON.parse(raw!.value) as Record<string, string>;
    assert(isEncrypted(stored.openaiApiKey), "OpenAI key is encrypted at rest");
    assert(isEncrypted(stored.resendApiKey), "Resend key is encrypted at rest");
    assert(isEncrypted(stored.smtpPass), "SMTP password is encrypted at rest");
    assert(!raw!.value.includes("sk-test-DASHBOARD-KEY-12345"), "plaintext key never appears in the row");
    assert(decryptSecret(stored.openaiApiKey) === "sk-test-DASHBOARD-KEY-12345", "decrypt round-trips");

    // 2. Survives a reload from the database (real persistence, not just memory)
    await loadRuntimeConfig();
    assert(runtimeConfig().openaiApiKey === "sk-test-DASHBOARD-KEY-12345", "key survives a fresh load from DB");

    // 3. Email consumer reads the new values
    await saveRuntimeConfig({ emailProvider: "resend", emailFrom: "Test <t@example.com>" });
    assert(emailConfigured() === true, "emailConfigured() true for resend + key");
    assert(runtimeConfig().emailFrom === "Test <t@example.com>", "from address applied");
    await saveRuntimeConfig({ emailProvider: "smtp", smtpHost: "smtp.example.com", smtpPort: 2525, smtpSecure: true });
    assert(emailConfigured() === true, "emailConfigured() true for smtp + host");
    assert(runtimeConfig().smtpPort === 2525 && runtimeConfig().smtpSecure === true, "smtp port/secure applied");
    await saveRuntimeConfig({ emailProvider: "log" });
    assert(emailConfigured() === false, "emailConfigured() false for log provider");

    // 4. Operational flags reach their consumers
    await saveRuntimeConfig({ billingTestMode: true });
    assert(isBillingTestMode() === true, "billing test mode flips the billing provider flag");
    await saveRuntimeConfig({ billingTestMode: false });
    assert(isBillingTestMode() === false, "billing test mode turns back off");
    await saveRuntimeConfig({ embedStatusEnabled: true });
    assert(runtimeConfig().embedStatusEnabled === true, "embed-status flag applied");

    // 5. Links
    await saveRuntimeConfig({ webAppUrl: "https://console.example.com/", appStoreHandle: "chatconvert-ai" });
    assert(webBaseUrl() === "https://console.example.com", "webBaseUrl() uses the dashboard URL (trailing slash trimmed)");
    assert(runtimeConfig().appStoreHandle === "chatconvert-ai", "app store handle applied");

    // 6. Partial saves must not wipe unrelated fields
    await saveRuntimeConfig({ appStoreHandle: "changed-handle" });
    assert(runtimeConfig().webAppUrl === "https://console.example.com/", "unrelated fields survive a partial save");
    assert(runtimeConfig().openaiApiKey === "sk-test-DASHBOARD-KEY-12345", "secret survives a partial save");

    // 7. Reset → env fallback everywhere
    await resetRuntimeConfig();
    assert(runtimeConfig().openaiApiKey === envKey, "reset restores the env key");
    assert(runtimeConfig().billingTestMode === (process.env.BILLING_TEST_MODE === "1"), "reset restores env billing flag");
    assert((await db.appSecret.findUnique({ where: { key: RUNTIME_SECRET_KEY } })) === null, "reset deletes the row");

    console.log("\nplatform-settings-check PASS");
  } finally {
    if (prior) {
      await db.appSecret.upsert({
        where: { key: RUNTIME_SECRET_KEY },
        create: { key: RUNTIME_SECRET_KEY, value: prior.value },
        update: { value: prior.value },
      });
    } else {
      await db.appSecret.deleteMany({ where: { key: RUNTIME_SECRET_KEY } });
    }
    await loadRuntimeConfig();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
