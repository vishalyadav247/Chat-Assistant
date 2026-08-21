import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { logError } from "../log.server";

// Central analytics event recorder. The event-name union is the FULL vocabulary
// declared up front (specs 02/03/06/09/10/12/13/14) — 13/14 aggregation depends
// on these names staying stable. Add names here, never inline strings.

export type AnalyticsEventType =
  // 02 sync
  | "catalog_synced"
  | "collection_synced"
  | "discount_synced"
  // 03 pipeline (one per turn, payload carries intent/outcome/sourceLayer)
  | "turn_completed"
  | "turn_blocked"
  | "turn_off_topic"
  | "turn_fell_back"
  | "curated_served"
  | "recommendation_shown"
  | "llm_error"
  | "moderation_error"
  | "embedding_skipped"
  // 05/06 widget
  | "widget_settings_saved"
  | "widget_opened"
  | "prechat_submitted"
  | "product_card_clicked"
  | "added_to_cart"
  // 11 contacts (payload: contactId, from, to, source — powers the contact
  // Activity timeline's conversion entries)
  | "contact_converted"
  // 09 curated admin
  | "curated_answer_saved"
  | "curated_stock_flagged"
  // 10 inbox / handover
  | "handover_triggered"
  | "conversation_resolved"
  | "conversation_blocked"
  | "human_replied"
  | "survey_submitted"
  // 12 proactive
  | "campaign_view"
  | "campaign_click"
  | "campaign_atc"
  | "campaign_order"
  // 08 test AI
  | "test_feedback"
  // 15 billing
  | "plan_changed"
  | "usage_cap_reached";

/**
 * `where` fragment for KPI readers: keep every event EXCEPT the ones the
 * pipeline tagged `payload.isTest === true` (Test-AI turns, QA D3).
 *
 * A bare `NOT: { payload: { path: ["isTest"], equals: true } }` is WRONG on
 * Postgres: `payload#>'{isTest}'` is SQL NULL when the key (or the whole
 * payload) is absent, so `NOT (NULL = true)` is NULL and real events are
 * dropped too (verified: 4 rows in, 1 out). The two null branches below put
 * them back — verified 3 of 4 rows, the expected answer.
 */
export const NOT_TEST_EVENT: Prisma.AnalyticsEventWhereInput = {
  OR: [
    { payload: { equals: Prisma.DbNull } },
    { payload: { path: ["isTest"], equals: Prisma.AnyNull } },
    { NOT: { payload: { path: ["isTest"], equals: true } } },
  ],
};

export async function recordEvent(
  shopId: string,
  type: AnalyticsEventType,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.analyticsEvent.create({
      data: {
        shopId: requireShopId(shopId),
        type,
        payload: (payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    // Analytics must never break the request path.
    logError("analytics_event_error", error, { type, shopId });
  }
}
