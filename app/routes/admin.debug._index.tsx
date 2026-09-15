import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import db from "../db.server";
import { AdminShell } from "../components/admin/AdminShell";
import { AdminBadge, AdminCard, AdminEmpty, AdminPage } from "../components/admin/AdminUi";
import { ConfirmDeleteModal } from "../components/ui/ConfirmDeleteModal";
import { requireOwnerAdmin } from "../lib/admin/admin-auth.server";
import { startTurnTracing, stopTurnTracing, turnTracingState } from "../lib/admin/turn-tracing.server";
import { DEFAULT_TRACE_HOURS, MAX_TRACE_SHOPS, TRACE_DURATION_HOURS } from "../lib/admin/turn-tracing-shared";
import { logWarn } from "../lib/log.server";
import { sameOrigin } from "../lib/team/same-origin.server";

// Admin → Debug: record REAL storefront chat turns — shopper message, reply,
// decision trail and the exact LLM prompts — to understand the pipeline
// against real conversations instead of re-typed guesses.
//
// Privacy controls (QA-C3, 2026-09-14): recording is per STORE (an explicit
// allowlist), stops by itself after 1 / 4 / 24 hours, is refused in production
// unless ALLOW_TURN_TRACING=true, and only an OWNER admin can open this page.
// Every start, stop, delete and every view is written to the operator log.
// One row per CONVERSATION — finding "that chat" beats scanning turn by turn.

const LIST_TRACE_SCAN = 400; // newest traces grouped into conversations below
const LIST_MAX_CONVERSATIONS = 60;
const SHOP_PICKER_LIMIT = 500;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requireOwnerAdmin(request);
  const tracing = await turnTracingState();

  const [traces, total, installedShops] = await Promise.all([
    db.turnTrace.findMany({
      orderBy: { createdAt: "desc" },
      take: LIST_TRACE_SCAN,
      select: { shopId: true, conversationId: true, shopperText: true, outcome: true, createdAt: true },
    }),
    db.turnTrace.count(),
    db.shop.findMany({
      where: { uninstalledAt: null },
      orderBy: { domain: "asc" },
      take: SHOP_PICKER_LIMIT,
      select: { id: true, domain: true },
    }),
  ]);

  // Group newest-first traces into one row per conversation.
  const byConversation = new Map<
    string,
    { shopId: string; conversationId: string; turns: number; lastOutcome: string; lastAt: Date; firstShopperText: string }
  >();
  for (const t of traces) {
    // Keyed by STORE + conversation (QA-S1): a bare conversationId let one
    // store's rows merge into another's.
    const key = `${t.shopId}:${t.conversationId || "(no conversation)"}`;
    const row = byConversation.get(key);
    if (!row) {
      byConversation.set(key, {
        shopId: t.shopId,
        conversationId: t.conversationId,
        turns: 1,
        lastOutcome: t.outcome,
        lastAt: t.createdAt,
        firstShopperText: t.shopperText,
      });
    } else {
      row.turns += 1;
      // Traces arrive newest-first, so the last one seen is the OLDEST —
      // its shopper text is the conversation opener.
      row.firstShopperText = t.shopperText;
    }
  }

  const domainById = new Map(installedShops.map((s) => [s.id, s.domain]));
  const missing = [...new Set(traces.map((t) => t.shopId))].filter((id) => !domainById.has(id));
  if (missing.length > 0) {
    for (const s of await db.shop.findMany({ where: { id: { in: missing } }, select: { id: true, domain: true } })) {
      domainById.set(s.id, s.domain);
    }
  }

  // PCD access log (QA-C3): opening the list shows shopper message openers.
  logWarn("turn_trace_list_viewed", `debug list viewed (${byConversation.size} conversations)`, {
    by: session.admin.email,
  });

  return {
    adminEmail: session.admin.email,
    tracing: {
      allowed: tracing.allowed,
      active: tracing.active,
      until: tracing.until,
      startedBy: tracing.startedBy,
      shops: tracing.shopIds.map((id) => ({ id, domain: domainById.get(id) ?? id })),
    },
    installedShops,
    total,
    conversations: [...byConversation.values()].slice(0, LIST_MAX_CONVERSATIONS).map((row) => ({
      ...row,
      lastAt: row.lastAt.toISOString(),
      shopDomain: domainById.get(row.shopId) ?? row.shopId,
    })),
  };
};

type ActionResult = { ok: boolean; intent: string; error?: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const session = await requireOwnerAdmin(request);
  // Same-origin gate like every other /admin action (K-16, QA-C2).
  if (!sameOrigin(request)) {
    return { ok: false, intent: "", error: "Request blocked. Reload the page and try again." };
  }
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "start-recording") {
    try {
      const state = await startTurnTracing({
        shopIds: formData.getAll("shopId").map(String),
        hours: Number(formData.get("hours")),
        by: session.admin.email,
      });
      logWarn("turn_tracing_started", `recording ${state.shopIds.length} store(s) until ${state.until}`, {
        by: session.admin.email,
        shopIds: state.shopIds,
        until: state.until,
      });
      return { ok: true, intent };
    } catch (error) {
      return { ok: false, intent, error: error instanceof Error ? error.message : "Couldn't start recording." };
    }
  }
  if (intent === "stop-recording") {
    await stopTurnTracing();
    logWarn("turn_tracing_stopped", "storefront turn recording stopped", { by: session.admin.email });
    return { ok: true, intent };
  }
  if (intent === "clear-recordings") {
    const removed = await db.turnTrace.deleteMany({});
    logWarn("turn_traces_cleared", `${removed.count} recorded turn(s) deleted`, {
      by: session.admin.email,
    });
    return { ok: true, intent };
  }
  return { ok: false, intent };
};

function stamp(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
}

export default function AdminDebug() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [hours, setHours] = useState<number>(DEFAULT_TRACE_HOURS);
  const [confirmClear, setConfirmClear] = useState(false);

  const q = query.trim().toLowerCase();
  const matches = (q ? data.installedShops.filter((s) => s.domain.toLowerCase().includes(q)) : data.installedShops).slice(0, 25);
  const toggle = (id: string) =>
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= MAX_TRACE_SHOPS ? prev : [...prev, id],
    );

  const start = () => {
    const form = new FormData();
    form.set("intent", "start-recording");
    form.set("hours", String(hours));
    for (const id of picked) form.append("shopId", id);
    fetcher.submit(form, { method: "post" });
  };

  const { tracing } = data;
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  return (
    <AdminShell adminEmail={data.adminEmail}>
      <AdminPage
        heading="Debug"
        subheading="Record real storefront chat turns for chosen stores — the shopper's message, the exact prompt sent to the AI, the decision trail and the reply. It stores shopper message text: record only the stores you are investigating, for as short a time as you can. Recording stops by itself; recordings keep for 7 days; every view is logged."
      >
        <div style={{ display: "grid", gap: 16 }}>
          <AdminCard
            heading="Record storefront turns"
            description={
              !tracing.allowed
                ? "Disabled on this server. Production refuses to record until ALLOW_TURN_TRACING=true is set — do that only after the privacy policy and Protected Customer Data answers describe this access."
                : tracing.active
                  ? `Recording ${tracing.shops.length} store(s) until ${stamp(tracing.until ?? "")} UTC${tracing.startedBy ? ` — started by ${tracing.startedBy}` : ""}.`
                  : "Off — no turns are recorded (the default)."
            }
            actions={
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <AdminBadge tone={tracing.active ? "critical" : "neutral"}>
                  {tracing.active ? "Recording" : "Off"}
                </AdminBadge>
                {tracing.active ? (
                  <button
                    type="button"
                    className="cca-btn"
                    disabled={busy}
                    onClick={() => fetcher.submit({ intent: "stop-recording" }, { method: "post" })}
                  >
                    Stop now
                  </button>
                ) : null}
              </div>
            }
          >
            {tracing.active ? (
              <p style={{ margin: 0, fontSize: 13 }}>
                Stores: {tracing.shops.map((s) => s.domain).join(", ")}
              </p>
            ) : tracing.allowed ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ maxWidth: 360 }}>
                  <s-search-field
                    label="Search installed stores"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Search installed stores by domain"
                    value={query}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                  />
                </div>
                <div style={{ display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                  {matches.length === 0 ? (
                    <span style={{ opacity: 0.7, fontSize: 13 }}>No installed store matches.</span>
                  ) : (
                    matches.map((shop) => (
                      <s-checkbox
                        key={shop.id}
                        label={shop.domain}
                        checked={picked.includes(shop.id)}
                        onInput={() => toggle(shop.id)}
                      />
                    ))
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 160 }}>
                    <s-select
                      label="Stop after"
                      value={String(hours)}
                      onInput={(e) => setHours(Number(e.currentTarget.value))}
                    >
                      {TRACE_DURATION_HOURS.map((h) => (
                        <s-option key={h} value={String(h)}>
                          {h} hour{h === 1 ? "" : "s"}
                        </s-option>
                      ))}
                    </s-select>
                  </div>
                  <button type="button" className="cca-btn" disabled={busy || picked.length === 0} onClick={start}>
                    Start recording{picked.length > 0 ? ` (${picked.length} store${picked.length === 1 ? "" : "s"})` : ""}
                  </button>
                </div>
              </div>
            ) : null}
            {error ? <p style={{ margin: "8px 0 0", color: "var(--cca-critical, #e11d48)", fontSize: 13 }}>{error}</p> : null}
            <p style={{ margin: "10px 0 0", opacity: 0.75, fontSize: 13 }}>
              {data.total.toLocaleString("en-US")} recorded turn(s) stored.
              {data.total > 0 ? (
                <button
                  type="button"
                  className="cca-btn"
                  style={{ marginLeft: 8 }}
                  disabled={busy}
                  onClick={() => setConfirmClear(true)}
                >
                  Delete all
                </button>
              ) : null}
            </p>
          </AdminCard>

          <AdminCard
            heading="Recorded conversations"
            description="Newest first. Click a conversation to read it turn by turn."
          >
            {data.conversations.length === 0 ? (
              <AdminEmpty
                title="Nothing recorded yet"
                body="Start recording a store, then chat on its storefront."
              />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left", opacity: 0.65 }}>
                      <th style={{ padding: "6px 8px" }}>Store</th>
                      <th style={{ padding: "6px 8px" }}>Opening message</th>
                      <th style={{ padding: "6px 8px" }}>Turns</th>
                      <th style={{ padding: "6px 8px" }}>Last lane</th>
                      <th style={{ padding: "6px 8px" }}>Last turn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.conversations.map((row) => (
                      <tr key={`${row.shopId}:${row.conversationId || "none"}`} style={{ borderTop: "1px solid rgba(128,128,128,.25)" }}>
                        <td style={{ padding: "8px" }}>{row.shopDomain}</td>
                        <td style={{ padding: "8px", maxWidth: 380 }}>
                          {row.conversationId ? (
                            <Link to={`/admin/debug/${row.shopId}/${row.conversationId}`}>
                              {row.firstShopperText || "(empty message)"}
                            </Link>
                          ) : (
                            <span>{row.firstShopperText || "(no conversation opened)"}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px" }}>{row.turns}</td>
                        <td style={{ padding: "8px" }}>
                          <AdminBadge tone="accent">{row.lastOutcome || "—"}</AdminBadge>
                        </td>
                        <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{stamp(row.lastAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AdminCard>
        </div>
      </AdminPage>

      <ConfirmDeleteModal
        open={confirmClear}
        title="Delete all recorded turns?"
        body="Every recording for every store is removed. This can't be undone."
        confirmLabel="Delete all"
        loading={busy}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          fetcher.submit({ intent: "clear-recordings" }, { method: "post" });
          setConfirmClear(false);
        }}
      />
    </AdminShell>
  );
}
