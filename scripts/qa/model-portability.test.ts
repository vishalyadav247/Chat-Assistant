/* QA — OpenAI model portability (2026-08-21).
 *
 *   npx tsx scripts/qa/model-portability.test.ts          # offline + fake-client
 *   npx tsx scripts/qa/model-portability.test.ts --live   # + real OpenAI calls
 *
 * Answers the user's question: "if we change the openai 4 model family, does it
 * work the same if we switch any model any time?" — by exercising the request
 * dialect, the platform override precedence, the retry seam and the embedding
 * migration path.
 *
 * Everything it writes (the platform:ai override row, the embedding-model
 * marker) is restored to its previous value in the finally block.
 */
import { readFileSync } from "node:fs";

// tsx does not load .env — hydrate process.env before any app import.
try {
  const envFile = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* rely on ambient environment */
}
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "qa-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "qa-secret";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";

const LIVE = process.argv.includes("--live");

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/** Minimal stand-in for the OpenAI SDK that records every request body. */
interface Capture {
  bodies: Array<Record<string, unknown>>;
  calls: number;
}
function fakeClient(
  capture: Capture,
  handler: (body: Record<string, unknown>, call: number) => unknown,
): unknown {
  return {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          capture.bodies.push(body);
          capture.calls += 1;
          return handler(body, capture.calls);
        },
      },
    },
  };
}

function completion(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function streamOf(tokens: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const token of tokens) yield { choices: [{ delta: { content: token } }] };
      yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
}

async function main(): Promise<void> {
  const { default: db } = await import("../../app/db.server");
  const {
    isReasoningModel,
    samplingParams,
    supportsJsonObject,
    REASONING_RESERVE_TOKENS,
  } = await import("../../app/lib/llm/model-compat");
  const { CHAT_MODEL_OPTIONS, chatModelError, chatModelWarning } = await import(
    "../../app/lib/llm/models"
  );
  const { priceFor, MODEL_PRICING } = await import("../../app/lib/platform/llm-pricing");
  const { OpenAiProvider } = await import("../../app/lib/llm/openai.server");
  const { runtimeConfig, loadRuntimeConfig } = await import(
    "../../app/lib/platform/runtime-config.server"
  );
  const settings = await import("../../app/lib/platform/platform-settings.server");
  const { env } = await import("../../app/lib/env.server");
  const { toSqlVector, EMBEDDING_DIMENSIONS } = await import(
    "../../app/lib/embeddings/embedding.server"
  );

  await loadRuntimeConfig();

  const startedAt = new Date();

  // Snapshot everything we are about to mutate — including whether the rows
  // existed at all, so a clean install stays a clean install.
  const originalOverrides = { ...(await settings.getAiOverrides()) };
  const hadOverrideRow =
    (await db.appSecret.count({ where: { key: settings.AI_SECRET_KEY } })) > 0;
  const originalMarker = await settings.getEmbeddingModelMarker();

  /** Build a provider whose SDK client is the fake one. */
  function providerWith(client: unknown) {
    const provider = new OpenAiProvider();
    (provider as unknown as { cached: { key: string; client: unknown } }).cached = {
      key: runtimeConfig().openaiApiKey,
      client,
    };
    return provider;
  }

  try {
    // ────────────────────────────────────────────────────────────────────────
    section("1. gpt-4 family request shape is byte-identical (user guarantee)");
    const LEGACY = JSON.stringify({ temperature: 0.3, max_tokens: 300 });
    for (const model of ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]) {
      ok(
        `${model} sends {temperature, max_tokens} unchanged`,
        JSON.stringify(samplingParams(model, 0.3, 300)) === LEGACY,
      );
      ok(`${model} is not misdetected as a reasoning model`, !isReasoningModel(model));
    }

    section("2. reasoning models get the other dialect + a reasoning reserve");
    for (const model of ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini"]) {
      const params = samplingParams(model, 0.3, 300);
      ok(`${model} detected as reasoning`, isReasoningModel(model));
      ok(`${model} omits temperature`, !("temperature" in params));
      ok(`${model} omits max_tokens`, !("max_tokens" in params));
      ok(
        `${model} sends max_completion_tokens = ask + reserve`,
        params.max_completion_tokens === 300 + REASONING_RESERVE_TOKENS,
      );
    }
    ok(
      "router's 160-token budget survives on a reasoning model",
      (samplingParams("o4-mini", 0, 160).max_completion_tokens ?? 0) >= 1000,
      `${samplingParams("o4-mini", 0, 160).max_completion_tokens} tokens`,
    );

    section("3. every dropdown model is priced and json-mode capable");
    for (const option of CHAT_MODEL_OPTIONS) {
      ok(`${option.id} priced`, priceFor(option.id) !== null);
      ok(`${option.id} accepts response_format json_object`, supportsJsonObject(option.id));
    }
    ok(
      "dated snapshots resolve to their base price",
      priceFor("gpt-4o-mini-2024-07-18")?.input === MODEL_PRICING["gpt-4o-mini"].input,
    );
    ok("o1-mini is excluded from json mode", !supportsJsonObject("o1-mini"));

    // ────────────────────────────────────────────────────────────────────────
    section("4. platform override CANNOT de-tune the router or the summariser");
    // The hostile setting: an operator dials creativity way up and the budget
    // way down. Router JSON and summaries must be immune; replies must not be.
    await settings.saveAiOverrides({ chatModel: "", temperature: 1.9, maxTokens: 16 });

    const routerCapture: Capture = { bodies: [], calls: 0 };
    await providerWith(fakeClient(routerCapture, () => completion('{"intent":"chat"}'))).chat(
      [{ role: "user", content: "hi" }],
      { shopId: "", purpose: "router" },
      { temperature: 0, maxTokens: 160, jsonObject: true },
    );
    const routerBody = routerCapture.bodies[0];
    ok("router keeps temperature 0", routerBody.temperature === 0, String(routerBody.temperature));
    ok("router keeps max_tokens 160", routerBody.max_tokens === 160, String(routerBody.max_tokens));
    ok(
      "router still asks for strict JSON",
      JSON.stringify(routerBody.response_format) === JSON.stringify({ type: "json_object" }),
    );

    const summaryCapture: Capture = { bodies: [], calls: 0 };
    await providerWith(fakeClient(summaryCapture, () => completion("summary"))).chat(
      [{ role: "user", content: "log" }],
      { shopId: "", purpose: "summary" },
      { temperature: 0.2, maxTokens: 130 },
    );
    ok("summariser keeps temperature 0.2", summaryCapture.bodies[0].temperature === 0.2);
    ok("summariser keeps max_tokens 130", summaryCapture.bodies[0].max_tokens === 130);

    const replyCapture: Capture = { bodies: [], calls: 0 };
    const replyStream = providerWith(
      fakeClient(replyCapture, () => streamOf(["he", "llo"])),
    ).chatStream([{ role: "user", content: "hi" }], { shopId: "", purpose: "reply" }, {
      temperature: 0.3,
      maxTokens: 90,
    });
    let replyText = "";
    for await (const token of replyStream) replyText += token;
    ok("reply lane still honours the global temperature", replyCapture.bodies[0].temperature === 1.9);
    ok("reply lane still honours the global max tokens", replyCapture.bodies[0].max_tokens === 16);
    ok("streamed tokens still arrive", replyText === "hello", replyText);

    const pinnedCapture: Capture = { bodies: [], calls: 0 };
    await providerWith(pinnedCapture && fakeClient(pinnedCapture, () => completion("x"))).chat(
      [{ role: "user", content: "hi" }],
      { shopId: "", purpose: "reply" },
      { temperature: 0.11, maxTokens: 77, pinnedParams: true },
    );
    ok(
      "an explicit pinnedParams call opts out of the override",
      pinnedCapture.bodies[0].temperature === 0.11 && pinnedCapture.bodies[0].max_tokens === 77,
    );

    section("5. the override still works when nothing is pinned");
    const cleared: Capture = { bodies: [], calls: 0 };
    await providerWith(fakeClient(cleared, () => completion("x"))).chat(
      [{ role: "user", content: "hi" }],
      { shopId: "", purpose: "reply" },
      {},
    );
    ok("global temperature applied to an untuned reply call", cleared.bodies[0].temperature === 1.9);
    ok("global max tokens applied to an untuned reply call", cleared.bodies[0].max_tokens === 16);

    section("6. model selection precedence, no restart required");
    await settings.saveAiOverrides({ chatModel: "gpt-4.1-nano", temperature: null, maxTokens: null });
    const modelCapture: Capture = { bodies: [], calls: 0 };
    const modelProvider = providerWith(fakeClient(modelCapture, () => completion("x")));
    await modelProvider.chat([{ role: "user", content: "hi" }], { shopId: "", purpose: "reply" }, {});
    ok("dashboard override beats env CHAT_MODEL", modelCapture.bodies[0].model === "gpt-4.1-nano");
    await modelProvider.chat([{ role: "user", content: "hi" }], { shopId: "", purpose: "reply" }, {
      model: "gpt-4o",
    });
    ok("per-call model beats the dashboard override", modelCapture.bodies[1].model === "gpt-4o");
    await settings.saveAiOverrides({ chatModel: "", temperature: null, maxTokens: null });
    await modelProvider.chat([{ role: "user", content: "hi" }], { shopId: "", purpose: "reply" }, {});
    ok(
      "clearing the override falls back to env CHAT_MODEL",
      modelCapture.bodies[2].model === env().CHAT_MODEL,
      String(modelCapture.bodies[2].model),
    );
    ok(
      "a save is visible immediately in-process (other instances: <=30s cache TTL)",
      (await settings.getAiOverrides()).chatModel === "",
    );
    // env() memoises for the life of the process, so the ENV route to a model
    // change needs a restart. That is inherent (you cannot change a running
    // process's environment) — the dashboard override is the no-restart lever.
    const envChatModel = process.env.CHAT_MODEL;
    process.env.CHAT_MODEL = "gpt-4.1";
    ok(
      "changing env CHAT_MODEL at runtime does NOT take effect without a restart",
      env().CHAT_MODEL !== "gpt-4.1",
      `still ${env().CHAT_MODEL} — use /platform/ai for a live switch`,
    );
    process.env.CHAT_MODEL = envChatModel;

    section("7. reasoning model + jsonObject through the real provider path");
    const reasoningCapture: Capture = { bodies: [], calls: 0 };
    await providerWith(fakeClient(reasoningCapture, () => completion('{"intent":"chat"}'))).chat(
      [{ role: "user", content: "hi" }],
      { shopId: "", purpose: "router" },
      { temperature: 0, maxTokens: 160, jsonObject: true, model: "o4-mini" },
    );
    const rb = reasoningCapture.bodies[0];
    ok("no temperature sent to o4-mini", !("temperature" in rb));
    ok("no max_tokens sent to o4-mini", !("max_tokens" in rb));
    ok(
      "max_completion_tokens leaves room for hidden reasoning",
      (rb.max_completion_tokens as number) >= 1000,
      String(rb.max_completion_tokens),
    );
    ok("json mode still requested for o4-mini", rb.response_format !== undefined);

    const previewCapture: Capture = { bodies: [], calls: 0 };
    await providerWith(fakeClient(previewCapture, () => completion("x"))).chat(
      [{ role: "user", content: "hi" }],
      { shopId: "", purpose: "router" },
      { jsonObject: true, model: "o1-mini" },
    );
    ok(
      "json mode omitted for o1-mini (it would 400)",
      previewCapture.bodies[0].response_format === undefined,
    );

    section("8. streaming asks for json mode too when requested");
    const streamJson: Capture = { bodies: [], calls: 0 };
    const sj = providerWith(fakeClient(streamJson, () => streamOf(["{}"]))).chatStream(
      [{ role: "user", content: "hi" }],
      { shopId: "", purpose: "reply" },
      { jsonObject: true },
    );
    for await (const _ of sj) void _;
    ok("chatStream forwards response_format", streamJson.bodies[0].response_format !== undefined);
    ok(
      "chatStream still requests usage accounting",
      JSON.stringify(streamJson.bodies[0].stream_options) === JSON.stringify({ include_usage: true }),
    );

    section("9. 429 retries no longer surface to the shopper");
    const rateLimited: Capture = { bodies: [], calls: 0 };
    const chatRetry = providerWith(
      fakeClient(rateLimited, (_body, call) => {
        if (call <= 2) throw Object.assign(new Error("rate limited"), { status: 429 });
        return completion("recovered");
      }),
    );
    const recovered = await chatRetry.chat([{ role: "user", content: "hi" }], {
      shopId: "",
      purpose: "reply",
    });
    ok("chat() retried through two 429s", rateLimited.calls === 3, `${rateLimited.calls} attempts`);
    ok("chat() returned the eventual answer", recovered === "recovered");

    const streamRetry: Capture = { bodies: [], calls: 0 };
    const streamProvider = providerWith(
      fakeClient(streamRetry, (_body, call) => {
        if (call === 1) throw Object.assign(new Error("overloaded"), { status: 503 });
        return streamOf(["ok"]);
      }),
    );
    let streamed = "";
    for await (const token of streamProvider.chatStream([{ role: "user", content: "hi" }], {
      shopId: "",
      purpose: "reply",
    })) {
      streamed += token;
    }
    ok("chatStream() retried a 5xx handshake", streamRetry.calls === 2, `${streamRetry.calls} attempts`);
    ok("chatStream() yielded the eventual tokens", streamed === "ok");

    const fatal: Capture = { bodies: [], calls: 0 };
    let threw = false;
    try {
      await providerWith(
        fakeClient(fatal, () => {
          throw Object.assign(new Error("bad model"), { status: 400 });
        }),
      ).chat([{ role: "user", content: "hi" }], { shopId: "", purpose: "reply" });
    } catch {
      threw = true;
    }
    ok("a 400 is NOT retried (fail fast on a bad model id)", threw && fatal.calls === 1);

    section("10. custom model id validation at /platform/ai");
    ok("a pasted sentence is refused", chatModelError("please use gpt-4o") !== null);
    ok("a whitespace id is refused", chatModelError("gpt 4o mini") !== null);
    ok("blank means environment default", chatModelError("") === null);
    ok("a plausible unknown id is allowed", chatModelError("gpt-4.2-turbo") === null);
    ok(
      "an unpriced id warns about unpriced usage",
      (chatModelWarning("gpt-4.2-turbo") ?? "").includes("unpriced"),
    );
    ok(
      "a reasoning id warns about hidden reasoning",
      (chatModelWarning("o4-mini") ?? "").includes("reasoning"),
    );
    ok("a verified dropdown id warns about nothing", chatModelWarning("gpt-4o-mini") === null);
    let schemaRejected = false;
    try {
      await settings.saveAiOverrides({
        chatModel: "not a model id",
        temperature: null,
        maxTokens: null,
      });
    } catch {
      schemaRejected = true;
    }
    ok("the settings schema refuses a malformed id even if the UI is bypassed", schemaRejected);

    section("11. embedding-model migration path");
    ok(`vector width pinned at ${EMBEDDING_DIMENSIONS}`, EMBEDDING_DIMENSIONS === 1536);
    let dimsRejected = false;
    try {
      toSqlVector(new Array(3072).fill(0.1));
    } catch {
      dimsRejected = true;
    }
    ok("a 3072-dim vector fails closed at toSqlVector", dimsRejected);

    await settings.setEmbeddingModelMarker("text-embedding-ada-002");
    const drifted = await settings.getEffectiveAiConfig();
    ok(
      "an embedding-model change is detected as drift",
      drifted.embeddingDrift === true && drifted.embeddingMarker === "text-embedding-ada-002",
    );
    await settings.setEmbeddingModelMarker(env().EMBEDDING_MODEL);
    const aligned = await settings.getEffectiveAiConfig();
    ok("re-embedding clears the drift flag", aligned.embeddingDrift === false);
    ok(
      "the marker is what the re-embed script keys off",
      (await settings.getEmbeddingModelMarker()) === env().EMBEDDING_MODEL,
    );
    // The other three vector columns must have a re-embed path; assert the
    // script names each table rather than only products.
    const script = readFileSync(new URL("../reembed-products.ts", import.meta.url), "utf8");
    for (const table of ["products", "knowledge", "curated_answers", "recommendations"]) {
      ok(`re-embed script covers ${table}`, script.includes(`table: "${table}"`));
    }

    // ────────────────────────────────────────────────────────────────────────
    if (LIVE) {
      section("12. LIVE — every dropdown model answers, on the real API");
      const live = new OpenAiProvider();
      for (const option of CHAT_MODEL_OPTIONS) {
        try {
          const reply = await live.chat(
            [{ role: "user", content: "Reply with the single word: ok" }],
            { shopId: "", purpose: "router" },
            { maxTokens: 16, model: option.id, pinnedParams: true },
          );
          ok(`${option.id} answered`, reply.trim().length > 0, reply.trim().slice(0, 20));
        } catch (error) {
          ok(`${option.id} answered`, false, error instanceof Error ? error.message.slice(0, 100) : "");
        }
      }

      section("13. LIVE — strict-JSON routing survives a hostile global override");
      await settings.saveAiOverrides({ chatModel: "", temperature: 1.9, maxTokens: 16 });
      const { route } = await import("../../app/lib/pipeline/router.server");
      const routed = await route({
        shopId: "",
        message: "show me a warm winter jacket under 100",
        history: [],
        bannedTopics: [],
        storeScope: "",
      });
      ok(
        "router returned parsed JSON, not the parse-failure fallback",
        routed.parseFailed !== true,
        `intent=${routed.intent}`,
      );
      ok("router picked the buy lane", routed.intent === "buy", routed.intent);
      await settings.saveAiOverrides({ chatModel: "", temperature: null, maxTokens: null });

      section("14. LIVE — embeddings come back at the pinned width, unit-normalised");
      const [vector] = await live.embedBatch(["a warm winter glove"], { shopId: "" });
      ok(`embedding width is ${EMBEDDING_DIMENSIONS}`, vector.length === EMBEDDING_DIMENSIONS);
      const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
      ok("embedding is unit-normalised", Math.abs(norm - 1) < 1e-6, norm.toFixed(9));
    } else {
      console.log("\n(skipping live OpenAI cases — pass --live to run them)");
    }
  } finally {
    // Restore exactly what we found.
    // The o1-mini case deliberately trips the seam's "no json mode" warning;
    // remove the rows this run produced so /platform/logs stays honest.
    await db.appLog
      .deleteMany({ where: { event: "chat_model_no_json_mode", occurredAt: { gte: startedAt } } })
      .catch(() => {});
    if (hadOverrideRow) {
      await settings.saveAiOverrides(originalOverrides).catch(() => {});
    } else {
      await db.appSecret.deleteMany({ where: { key: settings.AI_SECRET_KEY } }).catch(() => {});
    }
    if (originalMarker === null) {
      await db.appSecret
        .deleteMany({ where: { key: settings.EMBEDDING_MODEL_KEY } })
        .catch(() => {});
    } else {
      await settings.setEmbeddingModelMarker(originalMarker).catch(() => {});
    }
    await db.$disconnect();
  }

  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} (${passed} passed)`);
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(() => {
    // runtime-config / billing modules keep background DB work in flight and
    // would hold the event loop open forever. Exit explicitly.
    process.exit(failed === 0 ? 0 : 1);
  });
