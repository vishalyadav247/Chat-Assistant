import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
import { DataTable } from "../components/DataTable";

// AI unresolved questions review queue (spec 07): shopper questions that hit
// the pipeline fallback (logged by spec 03). Actions prefill the target form —
// FAQ modal / manual Q&A modal on the training page, or a curated answer — and
// Dismiss removes the row. The design references this screen but never drew
// it; this is the minimal list + actions UI the spec calls for.

const REASON_LABEL: Record<string, string> = {
  fell_back: "AI fell back",
  low_confidence: "Low confidence",
  repeated: "Repeated question",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const questions = await db.unresolvedQuestion.findMany({
    where: { shopId, status: "pending" },
    orderBy: [{ count: "desc" }, { createdAt: "desc" }],
    select: { id: true, question: true, reason: true, count: true, createdAt: true },
  });
  return {
    questions: questions.map((q) => ({ ...q, createdAt: q.createdAt.toISOString() })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "dismiss") {
    const result = await db.unresolvedQuestion.updateMany({
      where: { id: String(formData.get("id") ?? ""), shopId, status: "pending" },
      data: { status: "dismissed" },
    });
    return { ok: result.count > 0 };
  }
  return { ok: false };
};

export default function ReviewQueuePage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const processed = useRef<unknown>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || processed.current === fetcher.data) return;
    processed.current = fetcher.data;
    shopify.toast.show(fetcher.data.ok ? "Question dismissed" : "Couldn't dismiss question");
  }, [fetcher.state, fetcher.data, shopify]);

  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="AI unresolved questions">
      <s-stack gap="base">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <s-button
            icon="arrow-left"
            variant="tertiary"
            accessibilityLabel="Back to AI Agent"
            onClick={() => navigate("/app/ai-agent")}
          >
            AI Agent
          </s-button>
          <s-text tone="neutral">
            Questions your AI couldn&apos;t answer confidently. Turn them into training data.
          </s-text>
        </div>

        <s-section>
          {data.questions.length === 0 ? (
            <s-box padding="large">
              <s-stack gap="small">
                <s-heading>No unresolved questions</s-heading>
                <s-text tone="neutral">
                  When the AI falls back on a shopper question, it lands here for review.
                </s-text>
              </s-stack>
            </s-box>
          ) : (
            <DataTable
              rows={data.questions}
              searchPlaceholder="Search questions"
              searchFn={(row, q) => row.question.toLowerCase().includes(q)}
              emptyMessage="No questions match your search."
              perPage={10}
              columns={[
                {
                  key: "question",
                  title: "Question",
                  render: (row) => <span style={{ fontWeight: 600 }}>{row.question}</span>,
                },
                {
                  key: "count",
                  title: "Asked",
                  render: (row) => (
                    <s-text tone="neutral">
                      {row.count} time{row.count === 1 ? "" : "s"}
                    </s-text>
                  ),
                },
                {
                  key: "reason",
                  title: "Reason",
                  render: (row) => (
                    <s-badge tone="warning">{REASON_LABEL[row.reason] ?? row.reason}</s-badge>
                  ),
                },
                {
                  key: "date",
                  title: "First asked",
                  render: (row) => (
                    <s-text tone="neutral">{new Date(row.createdAt).toLocaleDateString()}</s-text>
                  ),
                },
                {
                  key: "actions",
                  title: "Actions",
                  align: "end",
                  render: (row) => (
                    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          navigate(
                            `/app/ai-agent/training?tab=faqs&prefillFaq=${encodeURIComponent(row.question)}&unresolvedId=${row.id}`,
                          )
                        }
                      >
                        Add as FAQ
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          navigate(
                            `/app/ai-agent/training?tab=knowledge&prefillQa=${encodeURIComponent(row.question)}&unresolvedId=${row.id}`,
                          )
                        }
                      >
                        Add as Q&A
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          navigate(`/app/curated-answers?prefill=${encodeURIComponent(row.question)}&unresolvedId=${row.id}`)
                        }
                      >
                        Add curated answer
                      </s-button>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        disabled={busy}
                        onClick={() =>
                          fetcher.submit({ intent: "dismiss", id: row.id }, { method: "post" })
                        }
                      >
                        Dismiss
                      </s-button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
