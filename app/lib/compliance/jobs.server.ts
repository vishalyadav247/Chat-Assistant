import type { PgBoss } from "pg-boss";
import db from "../../db.server";
import { pendingDataRequests } from "./data-request.server";

// Compliance job registry (spec 17). Registered by the pg-boss orchestrator
// (app/lib/jobs/queue.server.ts) alongside the core handlers.

export const COMPLIANCE_JOBS = {
  dataRequestReminder: "data-request-reminder",
} as const;

export const DATA_REQUEST_REMINDER_CRON = "29 6 * * *"; // daily, offset from other crons

/**
 * Merchant-notification seam. Email/notification delivery is a later feature;
 * for now the daily job logs a structured line per shop with open requests so
 * operations can act on overdue SLAs. No PII in logs — request ids and due
 * dates only, never customer emails.
 */
function notifyMerchantOfDataRequests(
  shopId: string,
  requests: Array<{ id: string; dueAt: Date; isOverdue: boolean }>,
): void {
  const overdue = requests.filter((r) => r.isOverdue);
  console.warn("data_request_reminder", {
    shopId,
    open: requests.length,
    overdue: overdue.length,
    requestIds: requests.map((r) => r.id),
    nextDueAt: requests[0]?.dueAt.toISOString(),
  });
}

export async function registerComplianceJobs(boss: PgBoss): Promise<void> {
  await boss.createQueue(COMPLIANCE_JOBS.dataRequestReminder).catch(() => {
    /* queue may already exist */
  });

  // Daily sweep: flag data requests still open (and especially those past the
  // 30-day SLA) per installed shop. Idempotent — read-only + logging.
  await boss.work(COMPLIANCE_JOBS.dataRequestReminder, async () => {
    const shops = await db.shop.findMany({
      where: { uninstalledAt: null },
      select: { id: true },
    });
    for (const shop of shops) {
      const open = await pendingDataRequests(shop.id);
      if (open.length > 0) notifyMerchantOfDataRequests(shop.id, open);
    }
  });

  await boss
    .schedule(COMPLIANCE_JOBS.dataRequestReminder, DATA_REQUEST_REMINDER_CRON, {}, {})
    .catch((error: unknown) => console.error("data_request_reminder_schedule_error", error));
}
