import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { PlatformShell } from "../components/platform/PlatformShell";
import { useAppBridge } from "../lib/ui/surface";
import {
  CHAT_MODEL_IDS,
  CHAT_MODEL_OPTIONS,
  chatModelError,
  chatModelWarning,
} from "../lib/llm/models";
import { requirePlatformAdmin } from "../lib/platform/platform-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import {
  aiOverridesSchema,
  getEffectiveAiConfig,
  saveAiOverrides,
} from "../lib/platform/platform-settings.server";

// Platform → AI model settings (spec 19). Global overrides applied to every
// shop's pipeline calls within ~30s (in-process cache TTL), no restart needed.


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePlatformAdmin(request);
  const ai = await getEffectiveAiConfig();
  return { adminEmail: session.admin.email, ...ai };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requirePlatformAdmin(request);
  if (!sameOrigin(request))
    return { ok: false as const, error: "Request blocked. Reload the page and try again.", warning: null };
  const form = await request.formData();

  const chatModel = String(form.get("chatModel") ?? "").trim();
  const temperatureRaw = String(form.get("temperature") ?? "").trim();
  const maxTokensRaw = String(form.get("maxTokens") ?? "").trim();

  const temperature = temperatureRaw === "" ? null : Number(temperatureRaw);
  const maxTokens = maxTokensRaw === "" ? null : Math.floor(Number(maxTokensRaw));

  // Hard gate on the "Custom…" free-text id BEFORE anything is persisted — a
  // bad id here breaks chat for every tenant within 30s (QA 2026-08-21).
  const idError = chatModelError(chatModel);
  if (idError) return { ok: false as const, error: idError, warning: null };

  const parsed = aiOverridesSchema.safeParse({ chatModel, temperature, maxTokens });
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid values.", warning: null };
  }
  await saveAiOverrides(parsed.data);
  // Saved, but say plainly what will be off (unpriced usage / reasoning model).
  return { ok: true as const, error: null, warning: chatModelWarning(parsed.data.chatModel) };
};

export default function PlatformAiSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const saving = fetcher.state !== "idle";

  // Feedback as a toast (like the admin/web surfaces), not a banner on top.
  const handled = useRef<unknown>(null);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) shopify.toast.show("Saved — live within ~30 seconds");
    else if (result.error) shopify.toast.show(result.error, { isError: true });
  }, [fetcher.data, fetcher.state, shopify]);

  // Warnings persist as a banner rather than a toast — "your usage costs will
  // read $0" is not something an operator should be able to miss in 3 seconds.
  const savedWarning = fetcher.state === "idle" && fetcher.data?.ok ? fetcher.data.warning : null;

  const initialModel = data.overrides.chatModel;
  const initialPreset = initialModel === "" ? "" : CHAT_MODEL_IDS.includes(initialModel) ? initialModel : "custom";
  const [preset, setPreset] = useState(initialPreset);
  const [customModel, setCustomModel] = useState(initialPreset === "custom" ? initialModel : "");
  const [temperature, setTemperature] = useState(
    data.overrides.temperature === null ? "" : String(data.overrides.temperature),
  );
  const [maxTokens, setMaxTokens] = useState(
    data.overrides.maxTokens === null ? "" : String(data.overrides.maxTokens),
  );

  const resolvedModel = preset === "custom" ? customModel.trim() : preset;
  const selectedNote = CHAT_MODEL_OPTIONS.find((m) => m.id === preset)?.note ?? "";
  // Live feedback while typing a custom id, so the operator sees the cost /
  // compatibility consequence at the point of choice, not after saving.
  const liveError = chatModelError(resolvedModel);
  const liveWarning = liveError ? null : chatModelWarning(resolvedModel);

  const save = () => {
    fetcher.submit({ chatModel: resolvedModel, temperature, maxTokens }, { method: "post" });
  };

  return (
    <PlatformShell adminEmail={data.adminEmail}>
      <s-page heading="AI model settings">
        <s-stack gap="base">
          <s-text color="subdued">
            Applies to every store&apos;s chat pipeline. Changes take effect within about 30 seconds — no deploy or
            restart.
          </s-text>

          <s-section heading="Chat model">
            <s-stack gap="base">
              <s-text color="subdued">
                Currently effective: <s-text type="strong">{data.effectiveChatModel}</s-text>{" "}
                {data.overrides.chatModel ? "(dashboard override)" : "(environment default)"}
              </s-text>
              <s-select label="Model" value={preset} onChange={(e) => setPreset(e.currentTarget.value)}>
                <s-option value="">Environment default ({data.envChatModel})</s-option>
                {CHAT_MODEL_OPTIONS.map((m) => (
                  <s-option key={m.id} value={m.id}>
                    {m.label}
                  </s-option>
                ))}
                <s-option value="custom">Custom…</s-option>
              </s-select>
              {preset === "custom" ? (
                <s-text-field
                  label="Custom model id"
                  placeholder="e.g. gpt-4.1-nano"
                  value={customModel}
                  onInput={(e) => setCustomModel(e.currentTarget.value)}
                  details="Any OpenAI chat-completions model id. Typos break every store's chat — double-check."
                  error={liveError ?? undefined}
                />
              ) : null}
              {liveWarning ? <s-banner tone="warning">{liveWarning}</s-banner> : null}
              {savedWarning && savedWarning !== liveWarning ? (
                <s-banner tone="warning">{savedWarning}</s-banner>
              ) : null}
              {selectedNote ? <s-text color="subdued">{selectedNote}</s-text> : null}
              <s-banner tone="info">
                Every model listed here is request-compatible and priced, so switching is safe to apply — the app adapts
                the request per model family automatically. Quality still varies: the prompts were tuned on gpt-4o-mini
                (16/16 on the golden set) and gpt-4.1-mini scored 15/16, so after switching it is worth running{" "}
                <code>npm run eval:golden</code> to confirm nothing regressed.
              </s-banner>
            </s-stack>
          </s-section>

          <s-section heading="Generation overrides">
            <s-stack gap="base">
              <s-text color="subdued">
                When set, these override the per-call values for shopper-visible <s-text type="strong">reply</s-text>{" "}
                generation. Leave blank to keep the tuned per-call settings.
              </s-text>
              <s-banner tone="info">
                Intent routing and conversation summaries are deliberately <s-text type="strong">not</s-text> affected.
                Their output is parsed by code (strict JSON / stored context), so they stay on their tuned settings —
                a high temperature here would otherwise break routing for every store.
              </s-banner>
              <s-stack direction="inline" gap="base">
                <s-box maxInlineSize="170px">
                  <s-text-field
                    label="Temperature"
                    placeholder="tuned per call"
                    value={temperature}
                    onInput={(e) => setTemperature(e.currentTarget.value)}
                    details="0–2. Blank = per-call."
                  />
                </s-box>
                <s-box maxInlineSize="170px">
                  <s-number-field
                    label="Max tokens"
                    placeholder="tuned per call"
                    min={16}
                    max={16384}
                    value={maxTokens}
                    onInput={(e) => setMaxTokens(e.currentTarget.value)}
                    details="Blank = per-call."
                  />
                </s-box>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Embedding model">
            <s-stack gap="small-300">
              <s-text type="strong">{data.embeddingModel}</s-text>
              <s-text color="subdued">
                Read-only (environment <code>EMBEDDING_MODEL</code>). Stored vectors are pinned to 1536 dimensions;
                switching embedding models requires re-embedding every product, knowledge chunk and curated answer, so
                it stays an environment + migration decision.
              </s-text>
              <s-text color="subdued">
                Vectors currently on disk were built with:{" "}
                <s-text type="strong">{data.embeddingMarker ?? "not recorded yet"}</s-text>
              </s-text>
              {data.embeddingDrift ? (
                <s-banner tone="critical">
                  The environment now says <s-text type="strong">{data.embeddingModel}</s-text> but the stored vectors
                  were built with <s-text type="strong">{data.embeddingMarker}</s-text>. Search results are being
                  compared across two different coordinate spaces. Run{" "}
                  <code>npx tsx scripts/reembed-products.ts</code> to rebuild them.
                </s-banner>
              ) : null}
            </s-stack>
          </s-section>

          <s-stack direction="inline" gap="base">
            <s-button variant="primary" loading={saving} disabled={Boolean(liveError)} onClick={save}>
              Save changes
            </s-button>
          </s-stack>
        </s-stack>
      </s-page>
    </PlatformShell>
  );
}
