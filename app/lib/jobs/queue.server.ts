import { PgBoss } from "pg-boss";
import { env } from "../env.server";
import { registerHandlers } from "./handlers.server";
import { registerComplianceJobs } from "../compliance/jobs.server";
import {
  registerAnalyticsJobs,
  ANALYTICS_ROLLUP_JOB,
  ANALYTICS_ROLLUP_CRON,
} from "../analytics/rollup.server";

// pg-boss singleton — same global pattern as db.server.ts so Vite HMR doesn't
// spawn duplicate pollers (duplicate job execution). Lazy start on first use.

declare global {
  // eslint-disable-next-line no-var
  var pgBossGlobal: { boss: PgBoss; started: Promise<void> } | undefined;
}

async function start(boss: PgBoss): Promise<void> {
  boss.on("error", (error: unknown) => console.error("pgboss_error", error));
  await boss.start();
  await registerHandlers(boss);
  await registerComplianceJobs(boss);
  await registerAnalyticsJobs(boss);
  await boss.schedule(ANALYTICS_ROLLUP_JOB, ANALYTICS_ROLLUP_CRON, {}, {}).catch(
    (error: unknown) => console.error("analytics_rollup_schedule_error", error),
  );
}

export function getQueue(): { boss: PgBoss; started: Promise<void> } {
  if (!global.pgBossGlobal) {
    const boss = new PgBoss({ connectionString: env().DATABASE_URL });
    global.pgBossGlobal = { boss, started: start(boss) };
  }
  return global.pgBossGlobal;
}

/** Enqueue a job (webhook handlers call ONLY this — fast, <10ms). */
export async function enqueue(name: string, data: object): Promise<void> {
  const { boss, started } = getQueue();
  await started;
  await boss.send(name, data);
}
