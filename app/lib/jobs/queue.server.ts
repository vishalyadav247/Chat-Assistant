import { PgBoss } from "pg-boss";
import { env } from "../env.server";
import { registerHandlers } from "./handlers.server";
import { registerComplianceJobs } from "../compliance/jobs.server";
import {
  registerAnalyticsJobs,
  ANALYTICS_ROLLUP_JOB,
  ANALYTICS_ROLLUP_CRON,
} from "../analytics/rollup.server";
import { logError } from "../log.server";

// pg-boss singleton — same global pattern as db.server.ts so Vite HMR doesn't
// spawn duplicate pollers (duplicate job execution). Lazy start on first use.

declare global {
  // eslint-disable-next-line no-var
  var pgBossGlobal: { boss: PgBoss; started: Promise<void> } | undefined;
}

async function start(boss: PgBoss): Promise<void> {
  boss.on("error", (error: unknown) => logError("pgboss_error", error));
  await boss.start();
  await registerHandlers(boss);
  await registerComplianceJobs(boss);
  await registerAnalyticsJobs(boss);
  await boss.schedule(ANALYTICS_ROLLUP_JOB, ANALYTICS_ROLLUP_CRON, {}, {}).catch(
    (error: unknown) => logError("analytics_rollup_schedule_error", error),
  );
}

export function getQueue(): { boss: PgBoss; started: Promise<void> } {
  if (!global.pgBossGlobal) {
    const boss = new PgBoss({ connectionString: env().DATABASE_URL });
    // A failed start must NOT be cached: the rejected `started` promise would
    // be awaited by every future enqueue(), so one transient DB blip at boot
    // (container starts before Postgres accepts connections) would break job
    // processing until the process restarted. Drop the singleton so the next
    // caller retries from scratch.
    const started = start(boss).catch((error: unknown) => {
      global.pgBossGlobal = undefined;
      void boss.stop().catch(() => undefined);
      throw error;
    });
    global.pgBossGlobal = { boss, started };
  }
  return global.pgBossGlobal;
}

/**
 * Start the queue at server boot instead of on the first enqueue().
 *
 * The cron schedules (reconcile, retention purge, uninstall purge, curated
 * revalidate, auto-resolve, analytics rollup) are registered inside start(),
 * and pg-boss only fires a schedule while a worker is actually polling. With
 * lazy start, a process that boots at 02:00 and sees no traffic until 09:00
 * silently skips that day's windows — including uninstallPurge, which performs
 * the day-7 GDPR erasure. Called for effect from entry.server.tsx.
 */
export function startQueueOnBoot(): void {
  try {
    void getQueue().started.catch((error: unknown) =>
      logError("pgboss_boot_start_error", error),
    );
  } catch (error) {
    // env() throwing (misconfiguration) must not take the web server down —
    // it is already reported at boot by shopify.server.ts.
    logError("pgboss_boot_start_error", error);
  }
}

/** Enqueue a job (webhook handlers call ONLY this — fast, <10ms). */
export async function enqueue(name: string, data: object): Promise<void> {
  const { boss, started } = getQueue();
  await started;
  await boss.send(name, data);
}
