/* Trace one turn through the REAL pipeline and print the decision trail.
 *
 *   npm run trace -- "keep my hands warm under $30"
 *   npm run trace -- "do you ship to Canada?" --shop my-store.myshopify.com
 *   npm run trace -- "hi" --json
 *
 * Same collector the Test AI inspector uses (app/lib/pipeline/trace.server.ts),
 * rendered for a terminal. The turn is flagged isTest, so it never ticks the
 * usage meter, never enters the unresolved queue, and never shows in the inbox.
 */
import { PrismaClient } from "@prisma/client";

// Scripts run outside `npm run dev`, so nothing has injected DATABASE_URL or
// the API key yet. Anything already exported in the shell still wins.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file — fall back to the ambient environment
}

const DEFAULT_SHOP = "dev-shop.myshopify.com";

const GLYPH: Record<string, string> = {
  hit: "●",
  pass: "✓",
  miss: "○",
  skip: "–",
  info: "·",
  error: "!",
};

const COLOR: Record<string, string> = {
  hit: "\x1b[35m",
  pass: "\x1b[32m",
  miss: "\x1b[90m",
  skip: "\x1b[90m",
  info: "\x1b[36m",
  error: "\x1b[31m",
};
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function render(value: unknown, indent: string): string {
  if (value === null || value === undefined) return `${DIM}-${OFF}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${DIM}none${OFF}`;
    const scalar = value.every((v) => typeof v !== "object" || v === null);
    if (scalar) return value.join(", ");
    return value
      .map((row) => `\n${indent}  - ${render(row, `${indent}    `).trimStart()}`)
      .join("");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `\n${indent}  ${DIM}${k}${OFF} ${render(v, `${indent}  `)}`)
      .join("");
  }
  const text = String(value);
  return text.includes("\n")
    ? text.split("\n").map((line) => `\n${indent}    ${line}`).join("")
    : text;
}

async function main() {
  const message = process.argv[2];
  if (!message || message.startsWith("--")) {
    console.error('Usage: npm run trace -- "your message" [--shop domain] [--json]');
    process.exit(2);
  }
  const asJson = process.argv.includes("--json");
  const domain = flag("shop") ?? DEFAULT_SHOP;

  const db = new PrismaClient();
  const shop = await db.shop.findUnique({ where: { domain }, select: { id: true } });
  if (!shop) {
    console.error(`No shop "${domain}". Seed the dev shop first: npx prisma db seed`);
    process.exit(2);
  }

  const { runPipeline } = await import("../app/lib/pipeline/index.server");
  const { createTrace } = await import("../app/lib/pipeline/trace.server");

  const trace = createTrace(true);
  let reply = "";
  let outcome = "";
  const cards: string[] = [];

  for await (const frame of runPipeline(
    {
      shopId: shop.id,
      sessionId: `test-trace${Date.now().toString(36)}`,
      message,
      isTest: true,
    },
    trace,
  )) {
    if (frame.type === "token") reply += frame.text;
    else if (frame.type === "message") reply += (reply ? "\n" : "") + frame.text;
    else if (frame.type === "cards") cards.push(...frame.cards.map((c) => c.title));
    else if (frame.type === "done") outcome = frame.outcome;
  }

  const steps = trace.steps();
  const summary = trace.summary();

  if (asJson) {
    console.log(JSON.stringify({ message, outcome, reply, cards, summary, steps }, null, 2));
    await db.$disconnect();
    return;
  }

  console.log(`\n${BOLD}Q${OFF} ${message}\n`);
  for (const step of steps) {
    const color = COLOR[step.status] ?? "";
    console.log(
      `${color}${GLYPH[step.status] ?? "?"}${OFF} ${BOLD}${step.label}${OFF} ` +
        `${DIM}${step.layer} · ${step.status} · ${step.ms}ms${OFF}`,
    );
    if (step.detail) {
      for (const [key, value] of Object.entries(step.detail)) {
        console.log(`   ${DIM}${key}${OFF} ${render(value, "   ")}`);
      }
    }
  }

  console.log(`\n${BOLD}A${OFF} ${reply || "(no text)"}`);
  if (cards.length > 0) console.log(`${DIM}cards${OFF} ${cards.join(" · ")}`);
  console.log(
    `\n${DIM}outcome ${outcome} · ${summary.totalMs}ms · ` +
      `${summary.llmCalls} model call(s) · ${summary.embeddingCalls} embedding(s) · ` +
      `${JSON.stringify(summary.byPurpose)}${OFF}\n`,
  );

  await db.$disconnect();
}

main()
  .then(() => {
    // The pipeline warms pooled clients (pg-boss, the LLM keep-alive agent)
    // that a one-shot CLI has no reason to drain — exit rather than idle.
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
