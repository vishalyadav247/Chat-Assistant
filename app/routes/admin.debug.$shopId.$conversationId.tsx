import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { AdminShell } from "../components/admin/AdminShell";
import { AdminBadge, AdminCard, AdminEmpty, AdminPage } from "../components/admin/AdminUi";
import { requireOwnerAdmin } from "../lib/admin/admin-auth.server";
import { logWarn } from "../lib/log.server";
import type { CapturedLlmCall } from "../lib/pipeline/turn-capture.server";
import type { TraceStep, TraceSummary } from "../lib/pipeline/trace-types";

// Admin → Debug → one conversation (2026-09-14). Each recorded turn reads top
// to bottom the way the turn actually ran: Shopper said → What went to the
// LLM (the literal message list, per call) → Agent replied, with the decision
// trail folded underneath. Cross-tenant BY DESIGN; OWNER admins only, and every
// view is written to the operator log (PCD access logging, QA-C3).

interface TurnPayload {
  steps?: TraceStep[];
  summary?: TraceSummary;
  llmCalls?: CapturedLlmCall[];
  trimmed?: boolean;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const session = await requireOwnerAdmin(request);
  const shopId = String(params.shopId ?? "");
  const conversationId = String(params.conversationId ?? "");

  // Store-scoped (QA-S1): the store comes from the URL, never from whichever
  // trace happens to be oldest, so a planted row under a foreign store cannot
  // relabel or join this conversation.
  const traces = shopId && conversationId
    ? await db.turnTrace.findMany({
        where: { shopId, conversationId },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const shop = shopId
    ? await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } })
    : null;

  // One access-log row per view: who read which store's shopper conversation.
  logWarn("turn_trace_viewed", `debug conversation viewed (${traces.length} turns)`, {
    by: session.admin.email,
    shopId,
    conversationId,
    turns: traces.length,
  });

  return {
    adminEmail: session.admin.email,
    conversationId,
    shopDomain: shop?.domain ?? (shopId || "unknown store"),
    turns: traces.map((t) => ({
      id: t.id,
      shopperText: t.shopperText,
      replyText: t.replyText,
      outcome: t.outcome,
      createdAt: t.createdAt.toISOString(),
      payload: t.payload as TurnPayload,
    })),
  };
};

function stamp(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
}

const pre: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontSize: 12,
  lineHeight: 1.5,
  margin: 0,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(128,128,128,.12)",
};

function Bubble(props: { label: string; tone: "in" | "out"; text: string }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.6, textTransform: "uppercase" }}>
        {props.label}
      </span>
      <div
        style={{
          ...pre,
          background: props.tone === "in" ? "rgba(0,120,255,.10)" : "rgba(0,180,90,.10)",
        }}
      >
        {props.text || <i style={{ opacity: 0.6 }}>(empty)</i>}
      </div>
    </div>
  );
}

function LlmCallView(props: { call: CapturedLlmCall; index: number }) {
  const { call } = props;
  return (
    <details style={{ border: "1px solid rgba(128,128,128,.3)", borderRadius: 8, padding: "6px 10px" }}>
      <summary style={{ cursor: "pointer", fontSize: 13 }}>
        <strong>LLM call {props.index + 1}</strong> · {call.purpose} · {call.messages.length} message
        {call.messages.length === 1 ? "" : "s"} · at {(call.atMs / 1000).toFixed(1)}s
      </summary>
      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {call.messages.map((m, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.6 }}>{m.role}</span>
            <pre style={pre}>{m.content}</pre>
          </div>
        ))}
        {call.response ? (
          <div style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.6 }}>← model output</span>
            <pre style={{ ...pre, background: "rgba(0,180,90,.10)" }}>{call.response}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function StepsView(props: { steps: TraceStep[] }) {
  return (
    <details style={{ border: "1px solid rgba(128,128,128,.3)", borderRadius: 8, padding: "6px 10px" }}>
      <summary style={{ cursor: "pointer", fontSize: 13 }}>
        <strong>Decision trail</strong> · {props.steps.length} step{props.steps.length === 1 ? "" : "s"}
      </summary>
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {props.steps.map((step) => (
              <tr key={step.seq} style={{ borderTop: "1px solid rgba(128,128,128,.18)" }}>
                <td style={{ padding: "4px 6px", whiteSpace: "nowrap", opacity: 0.6 }}>
                  +{(step.atMs / 1000).toFixed(2)}s
                </td>
                <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>
                  <AdminBadge
                    tone={
                      step.status === "hit" ? "success" : step.status === "miss" ? "neutral" : "accent"
                    }
                  >
                    {step.layer}
                  </AdminBadge>
                </td>
                <td style={{ padding: "4px 6px" }}>
                  {step.label}
                  {step.detail ? (
                    <details style={{ display: "inline-block", marginLeft: 8 }}>
                      <summary style={{ cursor: "pointer", fontSize: 11, opacity: 0.6 }}>raw</summary>
                      <pre style={pre}>{JSON.stringify(step.detail, null, 2)}</pre>
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default function AdminDebugConversation() {
  const data = useLoaderData<typeof loader>();
  return (
    <AdminShell adminEmail={data.adminEmail}>
      <AdminPage
        heading={`Conversation · ${data.shopDomain}`}
        subheading={`${data.turns.length} recorded turn(s) · id ${data.conversationId}`}
        actions={
          <Link to="/admin/debug" className="cca-btn">
            ← All recordings
          </Link>
        }
      >
        {data.turns.length === 0 ? (
          <AdminCard>
            <AdminEmpty
              title="No recorded turns for this conversation"
              body="They may have been deleted by retention (7 days) or the Delete-all action."
            />
          </AdminCard>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {data.turns.map((turn, index) => (
              <AdminCard
                key={turn.id}
                heading={`Turn ${index + 1}`}
                description={`${stamp(turn.createdAt)} UTC`}
                actions={<AdminBadge tone="accent">{turn.outcome || "no outcome"}</AdminBadge>}
              >
                <div style={{ display: "grid", gap: 10 }}>
                  <Bubble label="Shopper said" tone="in" text={turn.shopperText} />
                  {(turn.payload.llmCalls ?? []).map((call, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <LlmCallView key={i} call={call} index={i} />
                  ))}
                  {(turn.payload.llmCalls ?? []).length === 0 ? (
                    <span style={{ fontSize: 12, opacity: 0.65 }}>
                      No LLM was called this turn — the decision trail below says why (curated hit,
                      guardrail, human mode, cap…).
                    </span>
                  ) : null}
                  <Bubble label="Agent replied" tone="out" text={turn.replyText} />
                  {turn.payload.steps?.length ? <StepsView steps={turn.payload.steps} /> : null}
                  {turn.payload.trimmed ? (
                    <span style={{ fontSize: 12, opacity: 0.65 }}>
                      This turn exceeded the 32 KB recording cap — earliest LLM calls were trimmed.
                    </span>
                  ) : null}
                </div>
              </AdminCard>
            ))}
          </div>
        )}
      </AdminPage>
    </AdminShell>
  );
}
