/* Model compatibility check (spec 19).
 *   npx tsx scripts/model-compat-check.ts          # offline shape assertions
 *   npx tsx scripts/model-compat-check.ts --live   # + one real call per model
 *
 * Guarantees the two things the compatibility layer promises:
 *  1. NO BEHAVIOUR CHANGE for the gpt-4 family — the request parameters are
 *     exactly what the app sent before the layer existed.
 *  2. Every model offered in the platform dropdown actually works.
 */
import {
  isReasoningModel,
  samplingParams,
  supportsJsonObject,
  REASONING_RESERVE_TOKENS,
} from "../app/lib/llm/model-compat";
import {
  CHAT_MODEL_OPTIONS,
  chatModelError,
  chatModelWarning,
} from "../app/lib/llm/models";
import { priceFor } from "../app/lib/platform/llm-pricing";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`ok: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

// 1. The gpt-4 family must get the ORIGINAL parameters, unchanged.
const LEGACY_SHAPE = { temperature: 0.3, max_tokens: 300 };
for (const model of ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]) {
  const params = samplingParams(model, 0.3, 300);
  assert(
    JSON.stringify(params) === JSON.stringify(LEGACY_SHAPE),
    `${model} sends the unchanged {temperature, max_tokens} request`,
  );
  assert(!isReasoningModel(model), `${model} is not misdetected as a reasoning model`);
}

// 2. Reasoning models get the dialect they require, plus a reasoning reserve.
for (const model of ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini"]) {
  const params = samplingParams(model, 0.3, 300);
  assert(isReasoningModel(model), `${model} detected as a reasoning model`);
  assert(
    params.max_completion_tokens === 300 + REASONING_RESERVE_TOKENS,
    `${model} uses max_completion_tokens with the reasoning reserve`,
  );
  assert(!("temperature" in params), `${model} omits temperature (would 400)`);
  assert(!("max_tokens" in params), `${model} omits max_tokens (would 400)`);
}

// 2b. The router asks for 160 tokens of strict JSON. On a reasoning model that
// budget covers hidden reasoning too, so the raw value would routinely produce
// an EMPTY completion and a silent fallback to the chat lane on every turn.
assert(
  (samplingParams("o4-mini", 0, 160).max_completion_tokens ?? 0) >= 1000,
  "router budget on a reasoning model leaves room for hidden reasoning",
);

// 3. Everything in the dropdown is priced, so cost reporting keeps working.
for (const option of CHAT_MODEL_OPTIONS) {
  assert(priceFor(option.id) !== null, `${option.id} has a price on file`);
  assert(supportsJsonObject(option.id), `${option.id} accepts response_format json_object`);
  assert(chatModelError(option.id) === null, `${option.id} passes the custom-id validator`);
  assert(chatModelWarning(option.id) === null, `${option.id} is warning-free (it is a verified model)`);
}

// 3b. The two o-series previews are the models that reject json mode.
for (const model of ["o1-preview", "o1-mini"]) {
  assert(!supportsJsonObject(model), `${model} is excluded from json_object mode`);
}

// 4. The "Custom…" field validator: garbage is refused, unknown-but-plausible
// ids are allowed with a warning that names the consequence.
for (const bad of ["gpt 4o mini", "please use gpt-4o", "-leading-dash", "x", ""]) {
  if (bad === "") continue; // blank = "environment default", legitimately fine
  assert(chatModelError(bad) !== null, `custom model id ${JSON.stringify(bad)} is refused`);
}
assert(chatModelError("") === null, "blank custom model id means environment default");
assert(chatModelError("gpt-4.2-turbo-2027-01-01") === null, "a plausible future id is allowed");
assert(
  (chatModelWarning("gpt-4.2-turbo-2027-01-01") ?? "").includes("unpriced"),
  "an unpriced custom model warns about unpriced usage",
);
assert(
  (chatModelWarning("o4-mini") ?? "").includes("reasoning"),
  "a reasoning custom model warns about reasoning",
);
assert(
  chatModelWarning("gpt-4o-mini-2024-07-18") !== null,
  "an unverified dated snapshot still warns (run the golden set)",
);

async function live() {
  // Imported lazily: the provider pulls in the DB layer, which the offline
  // assertions above must not need (and which would keep the process alive).
  // Importing it also loads .env (via Prisma), so check the key AFTER this.
  const { OpenAiProvider } = await import("../app/lib/llm/openai.server");
  if (!process.env.OPENAI_API_KEY) throw new Error("--live needs OPENAI_API_KEY in .env");
  const provider = new OpenAiProvider();
  for (const option of CHAT_MODEL_OPTIONS) {
    try {
      const reply = await provider.chat(
        [{ role: "user", content: "Reply with the single word: ok" }],
        { shopId: "", purpose: "router" },
        { maxTokens: 16, model: option.id },
      );
      assert(reply.trim().length > 0, `LIVE ${option.id} answered ("${reply.trim().slice(0, 20)}")`);
    } catch (error) {
      assert(false, `LIVE ${option.id} failed: ${error instanceof Error ? error.message.slice(0, 120) : error}`);
    }
  }
}

async function main() {
  if (process.argv.includes("--live")) await live();
  console.log(failures === 0 ? "\nmodel-compat-check PASS" : `\nmodel-compat-check FAIL (${failures})`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    failures++;
  })
  .finally(() => {
    // --live imports the provider, which pulls in the runtime-config and plan
    // modules; those keep their own DB work in flight and would hold the event
    // loop open forever. Exit explicitly rather than waiting them out.
    process.exit(failures === 0 ? 0 : 1);
  });
