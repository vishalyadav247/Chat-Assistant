/* Human-support mode QA (spec 10 — "deactivated AI *is* human support";
 * QA-FIX-PLAN-2026-09-14 QA-T2 HS-*).
 *
 * Run: npx tsx scripts/qa/human-mode.test.ts
 * Needs: dev Postgres up (npm run db:up) + migrated. No dev server, no LLM key:
 * the human-mode path must make ZERO model calls, which this suite asserts by
 * recording the turn through the same TurnCollector the LLM provider reports to.
 *
 * Uses its own throwaway shop (no team members, so the team-notify job it
 * queues delivers to nobody) and removes it with cleanupShop at the end.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
// shopify.server refuses to import without these; nothing here talks to Shopify.
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SHOPIFY_API_KEY ||= "placeholder-human-mode-test";
process.env.SHOPIFY_API_SECRET ||= "placeholder-human-mode-test";
process.env.SCOPES ||= "read_products";

const DOMAIN = "qa-human-mode.myshopify.com";
const SESSION_PREFIX = "qa-human-mode-";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Turn {
  frames: { type: string; text?: string; outcome?: string; conversationId?: string }[];
  llmCalls: number;
  outcome: string;
  conversationId: string;
  text: string;
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { runPipeline } = await import("../../app/lib/pipeline/index.server");
  const { observeTurn, TurnCollector } = await import("../../app/lib/pipeline/turn-capture.server");
  const { createTrace } = await import("../../app/lib/pipeline/trace.server");
  const { invalidateShopConfig } = await import("../../app/lib/config/shop-config.server");
  const { listConversations } = await import("../../app/lib/inbox/inbox.server");
  const { cleanupShop } = await import("../../app/lib/jobs/handlers.server");
  const { NOTIFY_JOB } = await import("../../app/lib/notify.server");

  await cleanupShop(DOMAIN).catch(() => undefined);
  await db.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await db.shop.create({ data: { domain: DOMAIN, name: "QA human mode", aiEnabled: false } });
  const shopId = shop.id;
  const sessionId = `${SESSION_PREFIX}${Date.now()}`;

  const turn = async (message: string, conversationId?: string, session = sessionId): Promise<Turn> => {
    const collector = new TurnCollector();
    const frames: Turn["frames"] = [];
    for await (const frame of observeTurn({
      shopId,
      shopperText: message,
      frames: runPipeline({ shopId, sessionId: session, conversationId, message }),
      trace: createTrace(false),
      collector,
    })) {
      frames.push(frame as Turn["frames"][number]);
    }
    const done = frames.find((f) => f.type === "done");
    return {
      frames,
      llmCalls: collector.calls.length,
      outcome: done?.outcome ?? "",
      conversationId: done?.conversationId ?? "",
      text: frames.filter((f) => f.type === "message" || f.type === "token").map((f) => f.text).join(""),
    };
  };
  const notifyJobs = async (conversationId: string): Promise<number> => {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM pgboss.job WHERE name = $1 AND data->>'conversationId' = $2`,
      NOTIFY_JOB,
      conversationId,
    );
    return Number(rows[0]?.n ?? 0);
  };

  try {
    // ── HS-1…4: AI not activated → the chat is a human channel ──────────────
    console.log("\n[AI off: human support]");
    const first = await turn("Hi, do you have this in blue?");
    const convo = first.conversationId
      ? await db.conversation.findFirst({ where: { id: first.conversationId, shopId } })
      : null;
    ok("HS1 first turn ends in human_mode with a waiting message", first.outcome === "human_mode" && first.text.length > 0, `outcome=${first.outcome}`);
    ok("HS2 the conversation flips to mode=human", convo?.mode === "human", `mode=${convo?.mode}`);
    const saved = convo
      ? await db.message.findMany({ where: { shopId, conversationId: convo.id }, orderBy: { createdAt: "asc" } })
      : [];
    ok(
      "HS3 shopper message + system waiting message are stored (layer 'human', not 'handover')",
      saved.length === 2 &&
        saved[0].role === "in" &&
        saved[1].author === "system" &&
        saved[1].sourceLayer === "human" &&
        saved[1].content === first.text,
      saved.map((m: { role: string; author: string; sourceLayer: string | null }) => `${m.role}/${m.author}/${m.sourceLayer}`).join(", "),
    );
    ok("HS4 no LLM call was made", first.llmCalls === 0, `calls=${first.llmCalls}`);

    const inbox = await listConversations(shopId);
    ok("HS5 the conversation is in the Inbox", inbox.some((row: { id: string }) => row.id === first.conversationId), `rows=${inbox.length}`);
    ok("HS6 the team is notified (team-notify job queued)", (await notifyJobs(first.conversationId)) >= 1);

    // ── Follow-up in the same conversation: AI stays dormant ────────────────
    const follow = await turn("Hello? Anyone there?", first.conversationId);
    const followMessages = await db.message.count({ where: { shopId, conversationId: first.conversationId } });
    ok(
      "HS7 a follow-up stays in human mode: no reply text, no LLM call, team notified again",
      follow.outcome === "human_mode" && follow.text === "" && follow.llmCalls === 0 && followMessages === 3 &&
        (await notifyJobs(first.conversationId)) >= 2,
      `outcome=${follow.outcome} calls=${follow.llmCalls} messages=${followMessages}`,
    );

    // ── Merchant-edited waiting message wins over the canned default ────────
    await db.shopSettings.upsert({
      where: { shopId },
      create: { shopId, settings: { humanModeMessage: "Our team replies within the hour." } },
      update: { settings: { humanModeMessage: "Our team replies within the hour." } },
    });
    invalidateShopConfig(shopId);
    const custom = await turn("Another question", undefined, `${sessionId}-b`);
    ok("HS8 Settings → Chatbox human-mode message is what the shopper sees", custom.text === "Our team replies within the hour.", custom.text);

    // ── Test AI is exempt: it tests the AI, never becomes a human channel ────
    const testTurn = runPipeline({ shopId, sessionId: `test-${SESSION_PREFIX}x1`, message: "hi", isTest: true });
    let testOutcome = "";
    let testConvoId = "";
    for await (const frame of testTurn) {
      if (frame.type === "done") {
        testOutcome = frame.outcome;
        testConvoId = frame.conversationId;
      }
    }
    const testConvo = testConvoId ? await db.conversation.findFirst({ where: { id: testConvoId, shopId } }) : null;
    ok("HS9 a Test AI turn with the AI off is NOT turned into human mode", testOutcome !== "human_mode" && testConvo?.mode !== "human", `outcome=${testOutcome}`);

    // ── AI back on → a new conversation is an AI conversation again ─────────
    console.log("\n[AI back on]");
    await db.shop.update({ where: { id: shopId }, data: { aiEnabled: true } });
    invalidateShopConfig(shopId);
    const back = await turn("hello", undefined, `${sessionId}-c`);
    const backConvo = back.conversationId
      ? await db.conversation.findFirst({ where: { id: back.conversationId, shopId } })
      : null;
    ok(
      "HS10 with the AI on, a new conversation takes the normal pipeline (not human mode)",
      back.outcome !== "human_mode" && backConvo?.mode !== "human",
      `outcome=${back.outcome} mode=${backConvo?.mode}`,
    );
    const stillHuman = await turn("still there?", first.conversationId);
    ok(
      "HS11 a conversation already handed to the team stays human after the AI is switched on",
      stillHuman.outcome === "human_mode" && stillHuman.llmCalls === 0,
      `outcome=${stillHuman.outcome}`,
    );
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 500)); // trace save is fire-and-forget
    await cleanupShop(DOMAIN).catch((error: unknown) => console.error("cleanup failed", error));
    await db.shop.deleteMany({ where: { domain: DOMAIN } });
  }
}

main()
  .catch((error) => {
    failed++;
    console.error(error);
  })
  .finally(async () => {
    console.log(`\n${passed} passed, ${failed} failed`);
    try {
      if (global.pgBossGlobal) {
        const { getQueue } = await import("../../app/lib/jobs/queue.server");
        await Promise.race([
          getQueue().boss.stop({ graceful: false }),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
    } catch {
      /* queue never started */
    }
    const db = (await import("../../app/db.server")).default;
    await db.$disconnect();
    process.exit(failed ? 1 : 0);
  });
