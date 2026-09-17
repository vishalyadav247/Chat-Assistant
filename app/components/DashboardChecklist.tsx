import { useEffect, useState } from "react";
import type {
  ChecklistStep,
  SetupChecklist,
  TrainingSource,
  TrainingSummary,
} from "../lib/dashboard/dashboard.server";
import { ProgressTrack } from "./ui/Progress";
import { BRAND, SPACE, TONES } from "./ui/tokens";
import { relativeTime } from "./DashboardLiveFeed";

// "Get your AI ready" (spec 13, revised 2026-09-14 from the owner's mockup):
// percentage header + gradient track, eight numbered steps with one action
// each, and a training detail under step 1 (per-source learned counts and a
// re-sync that shows each source finishing). Buttons stay Polaris-native; the
// gradient is only on the progress track.

/** After a re-sync, a source whose timestamp never moves stops "syncing" here
 *  instead of spinning forever (a failed job never writes its timestamp). */
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/** Light green shared by the timeline's done segments and the done-step circle border. */
const TIMELINE_GREEN = "#8fd6ae";

const SOURCE_ICONS: Record<TrainingSource["key"], "product" | "collection" | "page" | "blog" | "discount"> = {
  products: "product",
  collections: "collection",
  pages: "page",
  blogs: "blog",
  discounts: "discount",
};

const CSS = `
.cc-step-detail { padding: 0 0 ${SPACE.base}px; }
/* Step timeline: a 30px rail (circle + dashed segments) beside each body. */
.cc-tl-step { display: flex; align-items: stretch; gap: ${SPACE.base}px; }
.cc-tl-rail { width: 30px; flex: none; display: flex; flex-direction: column; align-items: center; }
.cc-tl-line { flex: 1; min-height: 8px; width: 0; border-left: 1px dashed var(--s-color-border, #d7dbe3); }
.cc-tl-line[data-tone="done"] { border-left-color: ${TIMELINE_GREEN}; }
.cc-tl-line[data-hidden] { visibility: hidden; }
.cc-tl-body { flex: 1; min-width: 0; padding: ${SPACE.base}px 0; border-top: 1px solid var(--s-color-border-secondary, #ebebeb); }
.cc-tl-body[data-first] { border-top: 0; }
.cc-tl-detail { flex: 1; min-width: 0; }
/* Blue, underlined in every state (user, 2026-09-14). s-link only underlines
   on hover and its shadow DOM can't be restyled, so this is a plain button. */
.cc-text-link {
  background: none; border: 0; padding: 0; cursor: pointer; font: inherit;
  color: var(--p-color-text-link, #005bd3);
  text-decoration: underline; text-underline-offset: 2px;
}
.cc-text-link:hover { color: var(--p-color-text-link-hover, #004299); }
.cc-text-link:focus-visible { outline: 2px solid var(--p-color-border-focus, #005bd3); outline-offset: 2px; border-radius: 2px; }
@media (max-width: 768px) {
  .cc-step-detail { padding-left: 0; }
}
`;

/** syncing / failed describe the SYNC; the rest describe what the AI reads:
 *  off = master Learn switch off, none = nothing switched on (or nothing
 *  synced), learned = at least one row reaches the AI. */
type SourceState = "syncing" | "failed" | "off" | "none" | "learned";

export function sourceState(
  source: TrainingSource,
  productStatus: TrainingSummary["productStatus"],
  syncStartedAt: string | null,
  now: number,
): SourceState {
  const isProducts = source.key === "products";
  if (isProducts && productStatus === "running") return "syncing";
  if (isProducts && productStatus === "error") return "failed";
  if (syncStartedAt) {
    const started = Date.parse(syncStartedAt);
    const finished = source.syncedAt !== null && Date.parse(source.syncedAt) >= started;
    if (!finished && now - started < SYNC_TIMEOUT_MS) return "syncing";
  }
  // "Learned" used to show for every finished row — including a type whose
  // master switch was off, which read as "the AI knows your products" while
  // the count said 0.
  if (!source.masterOn) return "off";
  return source.learned > 0 ? "learned" : "none";
}

const CHIP_TONE: Record<SourceState, "info" | "critical" | "warning" | "neutral" | "success"> = {
  syncing: "info",
  failed: "critical",
  off: "neutral",
  none: "neutral",
  learned: "success",
};
const ICON_TONE: Record<SourceState, "info" | "critical" | "caution" | "neutral" | "success"> = {
  syncing: "info",
  failed: "critical",
  off: "neutral",
  none: "neutral",
  learned: "success",
};

function SourceStatus(props: { state: SourceState; label: string }) {
  switch (props.state) {
    case "syncing":
      return (
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-spinner size="base" accessibilityLabel={`Syncing ${props.label}`} />
          <s-text tone="info">Syncing…</s-text>
        </s-stack>
      );
    case "failed":
      return <s-badge tone="critical">Sync failed</s-badge>;
    case "none":
      return <s-badge tone="neutral">Nothing learned</s-badge>;
    default:
      return (
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-icon type="check-circle" tone="success" size="small" />
          <s-text tone="success">Learned</s-text>
        </s-stack>
      );
  }
}

function StepCircle(props: { index: number; state: ChecklistStep["state"] }) {
  const done = props.state === "done";
  return (
    <span
      aria-hidden
      style={{
        width: 30,
        height: 30,
        borderRadius: "50%",
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        fontWeight: 700,
        boxSizing: "border-box",
        background: done ? TONES.success.bg : "var(--s-color-bg-surface, #fff)",
        // Done: the same light green as the timeline line, so tick and rail read as one.
        border: done ? `2px solid ${TIMELINE_GREEN}` : "2px solid var(--s-color-border, #d7dbe3)",
        color: "var(--s-color-text-secondary, #9aa1ad)",
      }}
    >
      {done ? <s-icon type="check" tone="success" size="small" /> : props.index + 1}
    </span>
  );
}

function Completed() {
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      <s-icon type="check-circle" tone="success" size="small" />
      <s-text tone="success" type="strong">
        Completed
      </s-text>
    </s-stack>
  );
}

function StepAction(props: {
  step: ChecklistStep;
  syncing: boolean;
  onSync: () => void;
  onNavigate: (href: string) => void;
}) {
  const { step } = props;

  // A completed step shows "Completed" and nothing else (owner 2026-09-16):
  // the Review button that used to stay on the store-info step invited a
  // re-edit of work already done. Instructions remain reachable from the menu.
  if (step.state === "done") {
    return <Completed />;
  }

  if (step.action.kind === "revisit") {
    const href = step.action.href;
    return (
      <s-button variant="primary" onClick={() => props.onNavigate(href)}>
        {step.actionLabel}
      </s-button>
    );
  }

  let button: React.ReactNode;
  if (step.action.kind === "sync") {
    button = (
      <s-button variant="primary" loading={props.syncing} disabled={props.syncing} onClick={props.onSync}>
        {step.actionLabel}
      </s-button>
    );
  } else if (step.action.kind === "external") {
    button = (
      <s-button
        variant={step.state === "unknown" ? "tertiary" : "primary"}
        href={step.action.url}
        target="_blank"
      >
        {step.actionLabel}
      </s-button>
    );
  } else {
    const href = step.action.href;
    button = (
      <s-button variant="primary" onClick={() => props.onNavigate(href)}>
        {step.actionLabel}
      </s-button>
    );
  }

  return (
    button
  );
}

function TrainingDetail(props: {
  training: TrainingSummary;
  syncStartedAt: string | null;
  syncing: boolean;
  onSync: () => void;
  onNavigate: (href: string) => void;
}) {
  const { training } = props;
  const now = Date.now();
  const states = training.sources.map((source) =>
    sourceState(source, training.productStatus, props.syncStartedAt, now),
  );
  const finished = states.filter((state) => state !== "syncing").length;
  const inProgress = finished < states.length;

  return (
    <div className="cc-step-detail">
      <s-stack gap="small">
        <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="center">
          <s-text tone="neutral">
            {inProgress
              ? `Syncing — ${finished} of ${states.length} sources done`
              : training.lastSyncedAt
                ? `Last synced ${relativeTime(training.lastSyncedAt).toLowerCase()}`
                : "Not synced yet"}
          </s-text>
          <s-button
            variant="primary"
            icon="refresh"
            loading={props.syncing}
            disabled={props.syncing || inProgress}
            onClick={props.onSync}
          >
            {inProgress ? "Syncing…" : "Re-sync now"}
          </s-button>
        </s-grid>
        {/* No second progress bar here (owner, 2026-09-15): the card header
            already has one; sync progress reads from the line above and the
            per-row Syncing… status. */}
        <s-stack gap="small-200">
          {training.sources.map((source, index) => {
            const state = states[index];
            return (
              <s-grid
                key={source.key}
                gridTemplateColumns="auto 1fr auto"
                gap="small-200"
                alignItems="center"
              >
                <span
                  aria-hidden
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: TONES[CHIP_TONE[state]].bg,
                  }}
                >
                  <s-icon type={SOURCE_ICONS[source.key]} tone={ICON_TONE[state]} size="small" />
                </span>
                <s-stack gap="small-500">
                  <s-text type="strong">{source.label}</s-text>
                  <s-text tone="neutral">
                    {source.masterOn
                      ? `${source.learned.toLocaleString("en-US")} of ${source.total.toLocaleString("en-US")} learned`
                      : `${source.total.toLocaleString("en-US")} synced · not learned yet`}
                  </s-text>
                </s-stack>
                {/* Master switch off: the action IS the status (user, 2026-09-14) —
                    a "Learning off" badge beside "Enable learning" said the same
                    thing twice. Training tab ids match the source keys. */}
                {state === "off" ? (
                  <button
                    type="button"
                    className="cc-text-link"
                    aria-label={`Enable learning for ${source.label}`}
                    onClick={() => props.onNavigate(`/app/ai-agent/training?tab=${source.key}`)}
                  >
                    Enable learning
                  </button>
                ) : (
                  <SourceStatus state={state} label={source.label} />
                )}
              </s-grid>
            );
          })}
        </s-stack>
      </s-stack>
    </div>
  );
}

export function DashboardChecklist(props: {
  checklist: SetupChecklist;
  /** A sync-all request is in flight. */
  syncing: boolean;
  /** Server time the last sync-all was queued (this visit) — drives "Syncing…". */
  syncStartedAt: string | null;
  onSync: () => void;
  onNavigate: (href: string) => void;
}) {
  const { checklist } = props;
  const allDone = checklist.total > 0 && checklist.completed === checklist.total;
  const pct = checklist.total === 0 ? 0 : Math.round((checklist.completed / checklist.total) * 100);
  // Both open by default (user, 2026-09-14): the steps even at 100%, and the
  // step 1 training detail. The toggles still collapse them.
  const [showSteps, setShowSteps] = useState(true);
  const [detailOpen, setDetailOpen] = useState(true);
  // A sync started from step 1 (Sync now / Re-sync now) opens the
  // detail so the merchant sees each source finish; the chevron still closes it.
  useEffect(() => {
    if (props.syncStartedAt) setDetailOpen(true);
  }, [props.syncStartedAt]);

  const sync = () => {
    setDetailOpen(true);
    props.onSync();
  };

  return (
    <s-section>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <s-stack gap="base">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
          <s-stack gap="small-500">
            <s-heading>Get your AI ready</s-heading>
            <s-text tone="neutral">
              {allDone
                ? "You're all set — every step is complete."
                : "Finish these steps to unlock the best results."}
            </s-text>
          </s-stack>
          <s-stack gap="small-500" alignItems="end">
            <span
              style={{
                fontSize: 26,
                fontWeight: 800,
                lineHeight: 1,
                letterSpacing: -0.5,
                color: BRAND.accent,
              }}
            >
              {pct}%
            </span>
            <s-text tone="neutral">
              {checklist.completed} of {checklist.total} steps done
            </s-text>
          </s-stack>
        </s-grid>
        <ProgressTrack
          value={checklist.completed}
          max={checklist.total}
          label={`${checklist.completed} of ${checklist.total} setup steps done`}
        />

        {allDone ? (
          <s-stack direction="inline">
            <s-button variant="tertiary" onClick={() => setShowSteps((v) => !v)}>
              {showSteps ? "Hide steps" : "Show steps"}
            </s-button>
          </s-stack>
        ) : null}

        {showSteps ? (
          // Timeline (user, 2026-09-14): each step's circle sits on a rail, and
          // dashed segments join it to its neighbours. A segment is green when
          // the steps on BOTH sides are done — a run of greens reads as progress.
          <div>
            {checklist.steps.map((step, index) => {
              const isTraining = step.id === "training";
              const last = index === checklist.steps.length - 1;
              const prevDone = index > 0 && checklist.steps[index - 1].state === "done";
              const nextDone = !last && checklist.steps[index + 1].state === "done";
              const done = step.state === "done";
              const upTone = done && prevDone ? "done" : "todo";
              const downTone = done && nextDone ? "done" : "todo";
              return (
                <div key={step.id}>
                  <div className="cc-tl-step">
                    <div className="cc-tl-rail">
                      <span className="cc-tl-line" data-tone={upTone} data-hidden={index === 0 || undefined} />
                      <StepCircle index={index} state={step.state} />
                      <span
                        className="cc-tl-line"
                        data-tone={downTone}
                        data-hidden={(last && !(isTraining && detailOpen)) || undefined}
                      />
                    </div>
                    <div className="cc-tl-body" data-first={index === 0 || undefined}>
                      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
                        <s-stack gap="small-500">
                          {/* The storefront embed status sits right after the title
                              (user, 2026-09-14) — the right side keeps only the action. */}
                          <s-stack direction="inline" gap="small-200" alignItems="center">
                            <s-text type="strong">{step.title}</s-text>
                            {step.status ? (
                              <s-badge tone={step.status.tone}>{step.status.label}</s-badge>
                            ) : null}
                          </s-stack>
                          <s-text tone="neutral">{step.description}</s-text>
                          {step.note ? <s-text tone="caution">{step.note}</s-text> : null}
                          {step.state === "unknown" ? (
                            <s-text tone="neutral">
                              Can&apos;t verify automatically — not counted in your progress.
                            </s-text>
                          ) : null}
                        </s-stack>
                        <s-stack direction="inline" gap="small-200" alignItems="center">
                          <StepAction
                            step={step}
                            syncing={props.syncing}
                            onSync={sync}
                            onNavigate={props.onNavigate}
                          />
                          {isTraining ? (
                            <s-button
                              variant="tertiary"
                              icon={detailOpen ? "chevron-up" : "chevron-down"}
                              accessibilityLabel={detailOpen ? "Hide training details" : "Show training details"}
                              onClick={() => setDetailOpen((open) => !open)}
                            />
                          ) : null}
                        </s-stack>
                      </s-grid>
                    </div>
                  </div>
                  {isTraining && detailOpen ? (
                    // The rail runs on through the detail panel to step 2.
                    <div className="cc-tl-step">
                      <div className="cc-tl-rail">
                        <span className="cc-tl-line" data-tone={downTone} />
                      </div>
                      <div className="cc-tl-detail">
                        <TrainingDetail
                          training={checklist.training}
                          syncStartedAt={props.syncStartedAt}
                          syncing={props.syncing}
                          onSync={sync}
                          onNavigate={props.onNavigate}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </s-stack>
    </s-section>
  );
}
