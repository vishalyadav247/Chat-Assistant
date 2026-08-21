import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import db from "../db.server";
import { PlatformShell } from "../components/platform/PlatformShell";
import { ConfirmDeleteModal } from "../components/ui/ConfirmDeleteModal";
import { useAppBridge } from "../lib/ui/surface";
import { requirePlatformAdmin } from "../lib/platform/platform-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import { PLANS, PLAN_IDS } from "../lib/billing/plans.server";
import { isPaidPlan } from "../lib/billing/shopify-billing.server";
import {
  describePromo,
  generatePromoCode,
  normalizePromoCode,
  promoCodeProblem,
  promoValueProblem,
  PENDING_TTL_MS,
} from "../lib/billing/promo-shared";

// Platform → Coupons (spec 15 · discount codes). Operator creates codes here and
// hands them to merchants by mail/chat; merchants apply them on Plan & Usage and
// Shopify applies the discount to the subscription. Same page shape as Admins:
// list + "Add New" modal, toasts for feedback. Codes with redemptions can be
// deactivated but not deleted (keeps the billing history intact).

const ADD_MODAL = "platform-add-promo";

interface ModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const modalEl = (id: string) =>
  document.getElementById(id) as ModalElement | null;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePlatformAdmin(request);
  const rows = await db.promoCode.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { redemptions: { where: { status: "redeemed" } } } },
    },
  });
  const now = Date.now();
  // "Limit reached" must match what a merchant experiences: a fresh pending
  // reservation occupies a maxRedemptions slot until it is approved or ages out.
  const reserved = await db.promoRedemption.groupBy({
    by: ["promoCodeId"],
    where: {
      status: "pending",
      createdAt: { gte: new Date(now - PENDING_TTL_MS) },
    },
    _count: { _all: true },
  });
  const pendingBy = new Map(reserved.map((r) => [r.promoCodeId, r._count._all]));
  // Ever-redeemed (including rows released by a downgrade) — deleting such a
  // code would cascade away billing history, so it can only be deactivated.
  const historic = await db.promoRedemption.groupBy({
    by: ["promoCodeId"],
    where: { redeemedAt: { not: null } },
    _count: { _all: true },
  });
  const historicIds = new Set(historic.map((r) => r.promoCodeId));
  return {
    adminEmail: session.admin.email,
    paidPlans: PLAN_IDS.filter(isPaidPlan).map((id) => ({
      id,
      name: PLANS[id].name,
    })),
    codes: rows.map((r) => ({
      id: r.id,
      code: r.code,
      description: r.description,
      label: describePromo(r),
      plans: r.plans,
      intervals: r.intervals,
      maxRedemptions: r.maxRedemptions,
      redeemed: r._count.redemptions,
      pending: pendingBy.get(r.id) ?? 0,
      everRedeemed: historicIds.has(r.id),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString().slice(0, 10) : null,
      expired: r.expiresAt ? r.expiresAt.getTime() < now : false,
      active: r.active,
      createdAt: r.createdAt.toISOString().slice(0, 10),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requirePlatformAdmin(request);
  if (!sameOrigin(request))
    return {
      ok: false as const,
      error: "Request blocked. Reload the page and try again.",
      intent: "",
    };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const code = normalizePromoCode(String(form.get("code") ?? ""));
    const problem = promoCodeProblem(code);
    if (problem) return { ok: false as const, error: problem, intent };
    const kind =
      String(form.get("kind") ?? "percent") === "fixed" ? "fixed" : "percent";
    const value = Number(form.get("value"));
    // Rejects values Shopify's 4-dp percentage fraction can't carry exactly —
    // 12.345% would be sent as 0.1235 and bill a price the card never showed.
    const valueProblem = promoValueProblem(kind, value);
    if (valueProblem)
      return { ok: false as const, error: valueProblem, intent };
    const durationRaw = String(form.get("durationIntervals") ?? "").trim();
    const durationIntervals = durationRaw ? Number(durationRaw) : null;
    if (
      durationIntervals !== null &&
      (!Number.isInteger(durationIntervals) || durationIntervals < 1)
    )
      return {
        ok: false as const,
        error:
          "Duration must be a whole number of billing cycles (or blank for forever).",
        intent,
      };
    const maxRaw = String(form.get("maxRedemptions") ?? "").trim();
    const maxRedemptions = maxRaw ? Number(maxRaw) : null;
    if (
      maxRedemptions !== null &&
      (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)
    )
      return {
        ok: false as const,
        error:
          "Max redemptions must be a whole number (or blank for unlimited).",
        intent,
      };
    const expiresRaw = String(form.get("expiresAt") ?? "").trim();
    // End of the given day in UTC, deliberately (not merchant-local): codes are
    // issued and dated by the operator, and a per-merchant expiry would make one
    // code die at 24 different instants. The form labels the field "(UTC)".
    const expiresAt = expiresRaw
      ? new Date(`${expiresRaw}T23:59:59.999Z`)
      : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime()))
      return {
        ok: false as const,
        error: "Expiry must be a date (YYYY-MM-DD).",
        intent,
      };
    const plans = form.getAll("plans").map(String).filter(isPaidPlan);
    const intervalsRaw = String(form.get("intervals") ?? "both");
    const intervals =
      intervalsRaw === "monthly" || intervalsRaw === "yearly"
        ? [intervalsRaw]
        : [];

    const existing = await db.promoCode.findUnique({ where: { code } });
    if (existing)
      return { ok: false as const, error: "That code already exists.", intent };
    await db.promoCode.create({
      data: {
        code,
        description: String(form.get("description") ?? "")
          .trim()
          .slice(0, 200),
        kind,
        value,
        durationIntervals,
        plans,
        intervals,
        maxRedemptions,
        expiresAt,
      },
    });
    return { ok: true as const, error: null, intent };
  }

  if (intent === "toggle") {
    const id = String(form.get("id") ?? "");
    const row = await db.promoCode.findUnique({ where: { id } });
    if (!row) return { ok: false as const, error: "Code not found.", intent };
    await db.promoCode.update({ where: { id }, data: { active: !row.active } });
    return {
      ok: true as const,
      error: null,
      intent: row.active ? "deactivate" : "activate",
    };
  }

  if (intent === "remove") {
    const id = String(form.get("id") ?? "");
    const used = await db.promoRedemption.count({
      where: { promoCodeId: id, redeemedAt: { not: null } },
    });
    if (used > 0)
      return {
        ok: false as const,
        error: "This code has been redeemed — deactivate it instead.",
        intent,
      };
    await db.promoCode.delete({ where: { id } }).catch(() => undefined);
    return { ok: true as const, error: null, intent };
  }

  return { ok: false as const, error: "Unknown action.", intent };
};

const SUCCESS_MESSAGE: Record<string, string> = {
  add: "Coupon created",
  remove: "Coupon deleted",
  activate: "Coupon activated",
  deactivate: "Coupon deactivated",
};

export default function PlatformPromoCodes() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("20");
  const [duration, setDuration] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [plans, setPlans] = useState<string[]>([]);
  const [intervals, setIntervals] = useState<"both" | "monthly" | "yearly">(
    "both",
  );
  const [removing, setRemoving] = useState<{ id: string; code: string } | null>(
    null,
  );

  const resetForm = () => {
    setCode("");
    setDescription("");
    setKind("percent");
    setValue("20");
    setDuration("");
    setMaxRedemptions("");
    setExpiresAt("");
    setPlans([]);
    setIntervals("both");
  };

  const handled = useRef<unknown>(null);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result)
      return;
    handled.current = result;
    if (result.ok) {
      shopify.toast.show(SUCCESS_MESSAGE[result.intent] ?? "Saved");
      if (result.intent === "add") {
        modalEl(ADD_MODAL)?.hideOverlay();
        resetForm();
      }
      if (result.intent === "remove") setRemoving(null);
    } else if (result.error) {
      shopify.toast.show(result.error, { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const togglePlan = (id: string, on: boolean) =>
    setPlans((prev) =>
      on ? [...new Set([...prev, id])] : prev.filter((p) => p !== id),
    );

  const planNames = (ids: string[]) =>
    ids.length === 0
      ? "Any paid plan"
      : ids
          .map((id) => data.paidPlans.find((p) => p.id === id)?.name ?? id)
          .join(", ");

  const valueNumber = Number(value);
  const valueProblem = promoValueProblem(kind, valueNumber);
  const canSubmit =
    promoCodeProblem(normalizePromoCode(code)) === null && valueProblem === null;

  return (
    <PlatformShell adminEmail={data.adminEmail}>
      <s-page heading="Coupons">
        <s-stack gap="base">
          <s-text color="subdued">
            Discount codes for paid plans. Share a code with a merchant by email
            or chat; they apply it on Plan &amp; Usage and Shopify applies the
            discount to their subscription (visible on the approval page and on
            every invoice).
          </s-text>

          <s-section heading="Codes">
            <s-stack gap="base">
              <s-stack direction="inline" gap="base" justifyContent="end">
                <s-button
                  variant="primary"
                  onClick={() => {
                    if (!code) setCode(generatePromoCode());
                    modalEl(ADD_MODAL)?.showOverlay();
                  }}
                >
                  Add New
                </s-button>
              </s-stack>

              {data.codes.length === 0 ? (
                <s-text color="subdued">No coupons yet.</s-text>
              ) : (
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Code</s-table-header>
                    <s-table-header>Discount</s-table-header>
                    <s-table-header>Applies to</s-table-header>
                    <s-table-header>Redeemed</s-table-header>
                    <s-table-header>Expires</s-table-header>
                    <s-table-header>Status</s-table-header>
                    <s-table-header>Actions</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {data.codes.map((c) => (
                      <s-table-row key={c.id}>
                        <s-table-cell>
                          <s-stack gap="small-300">
                            <s-text type="strong">{c.code}</s-text>
                            {c.description ? (
                              <s-text color="subdued">{c.description}</s-text>
                            ) : null}
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>{c.label}</s-table-cell>
                        <s-table-cell>
                          {planNames(c.plans)}
                          {c.intervals.length
                            ? ` · ${c.intervals.join(", ")}`
                            : ""}
                        </s-table-cell>
                        <s-table-cell>
                          {c.redeemed}
                          {c.maxRedemptions !== null
                            ? ` / ${c.maxRedemptions}`
                            : ""}
                          {c.pending > 0 ? ` (+${c.pending} pending)` : ""}
                        </s-table-cell>
                        <s-table-cell>{c.expiresAt ?? "—"}</s-table-cell>
                        <s-table-cell>
                          {!c.active ? (
                            <s-badge>Inactive</s-badge>
                          ) : c.expired ? (
                            <s-badge tone="warning">Expired</s-badge>
                          ) : c.maxRedemptions !== null &&
                            c.redeemed + c.pending >= c.maxRedemptions ? (
                            <s-badge tone="warning">Limit reached</s-badge>
                          ) : (
                            <s-badge tone="success">Active</s-badge>
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack direction="inline" gap="small-300">
                            <s-button
                              variant="tertiary"
                              disabled={busy}
                              onClick={() =>
                                fetcher.submit(
                                  { intent: "toggle", id: c.id },
                                  { method: "post" },
                                )
                              }
                            >
                              {c.active ? "Deactivate" : "Activate"}
                            </s-button>
                            <s-button
                              icon="delete"
                              tone="critical"
                              variant="tertiary"
                              accessibilityLabel={`Delete ${c.code}`}
                              disabled={busy || c.everRedeemed}
                              onClick={() =>
                                setRemoving({ id: c.id, code: c.code })
                              }
                            />
                          </s-stack>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}
            </s-stack>
          </s-section>
        </s-stack>
      </s-page>

      <s-modal id={ADD_MODAL} heading="New coupon">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field
              label="Code"
              details="Letters, numbers, dashes. Stored upper-case."
              value={code}
              onInput={(e) => setCode(e.currentTarget.value.toUpperCase())}
            />
            <s-button onClick={() => setCode(generatePromoCode())}>
              Generate
            </s-button>
          </s-stack>
          <s-text-field
            label="Internal note"
            placeholder="e.g. Black Friday 2026, agency partner"
            value={description}
            onInput={(e) => setDescription(e.currentTarget.value)}
          />
          <s-stack direction="inline" gap="base">
            <s-select
              label="Type"
              value={kind}
              onChange={(e) =>
                setKind(e.currentTarget.value === "fixed" ? "fixed" : "percent")
              }
            >
              <s-option value="percent">Percentage off</s-option>
              <s-option value="fixed">Fixed amount off (USD)</s-option>
            </s-select>
            <s-number-field
              label={
                kind === "percent"
                  ? "Percent (1–100)"
                  : "Amount per billing cycle (USD)"
              }
              min={0}
              max={kind === "percent" ? 100 : undefined}
              step={kind === "percent" ? 1 : 0.01}
              value={value}
              error={value.trim() ? (valueProblem ?? undefined) : undefined}
              onInput={(e) => setValue(e.currentTarget.value)}
            />
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-number-field
              label="Duration (billing cycles)"
              details="Blank = forever. Yearly plans: 1 cycle = 1 year."
              min={1}
              step={1}
              value={duration}
              onInput={(e) => setDuration(e.currentTarget.value)}
            />
            <s-number-field
              label="Max redemptions"
              details="Blank = unlimited. One redemption per store."
              min={1}
              step={1}
              value={maxRedemptions}
              onInput={(e) => setMaxRedemptions(e.currentTarget.value)}
            />
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-text-field
              label="Expires on (UTC)"
              placeholder="YYYY-MM-DD"
              details="Blank = never. Valid through 23:59:59 UTC on that date."
              value={expiresAt}
              onInput={(e) => setExpiresAt(e.currentTarget.value)}
            />
            <s-select
              label="Billing interval"
              value={intervals}
              onChange={(e) =>
                setIntervals(
                  e.currentTarget.value as "both" | "monthly" | "yearly",
                )
              }
            >
              <s-option value="both">Monthly and yearly</s-option>
              <s-option value="monthly">Monthly only</s-option>
              <s-option value="yearly">Yearly only</s-option>
            </s-select>
          </s-stack>
          <s-stack gap="small-300">
            <s-text type="strong">Plans</s-text>
            <s-text color="subdued">
              Leave all unchecked to allow any paid plan.
            </s-text>
            <s-stack direction="inline" gap="base">
              {data.paidPlans.map((p) => (
                <s-checkbox
                  key={p.id}
                  label={p.name}
                  checked={plans.includes(p.id)}
                  onChange={(e) => togglePlan(p.id, e.currentTarget.checked)}
                />
              ))}
            </s-stack>
          </s-stack>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={busy}
          disabled={!canSubmit}
          onClick={() => {
            const form = new FormData();
            form.set("intent", "add");
            form.set("code", code);
            form.set("description", description);
            form.set("kind", kind);
            form.set("value", value);
            form.set("durationIntervals", duration);
            form.set("maxRedemptions", maxRedemptions);
            form.set("expiresAt", expiresAt);
            form.set("intervals", intervals);
            plans.forEach((p) => form.append("plans", p));
            fetcher.submit(form, { method: "post" });
          }}
        >
          Create coupon
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => modalEl(ADD_MODAL)?.hideOverlay()}
        >
          Cancel
        </s-button>
      </s-modal>

      <ConfirmDeleteModal
        open={removing !== null}
        title={`Delete ${removing?.code ?? "this coupon"}?`}
        body="Merchants will no longer be able to apply it. This can't be undone."
        confirmLabel="Delete coupon"
        loading={busy}
        onConfirm={() =>
          fetcher.submit(
            { intent: "remove", id: removing?.id ?? "" },
            { method: "post" },
          )
        }
        onCancel={() => setRemoving(null)}
      />
    </PlatformShell>
  );
}
