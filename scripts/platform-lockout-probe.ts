/* One-shot probe for the platform-admin per-account lockout (spec 19 audit fix).
 *   npx tsx scripts/platform-lockout-probe.ts
 * Creates a throwaway admin, fails 5 logins → expects lock; correct password
 * while locked → rejected; expired lock → signs in + counters reset. Cleans up.
 */
import db from "../app/db.server";
import { verifyPlatformLogin } from "../app/lib/platform/platform-auth.server";
import { hashPassword } from "../app/lib/team/password.server";

const EMAIL = "lock-probe@example.com";

async function main() {
  await db.platformAdmin.deleteMany({ where: { email: EMAIL } });
  await db.platformAdmin.create({
    data: { email: EMAIL, name: "Lock Probe", passwordHash: await hashPassword("right-pass-123") },
  });

  for (let i = 1; i <= 5; i++) {
    const r = await verifyPlatformLogin(EMAIL, `wrong-${i}`);
    console.log(`attempt ${i}:`, r.ok ? "FAIL — accepted wrong password" : r.error);
  }

  const locked = await verifyPlatformLogin(EMAIL, "right-pass-123");
  console.log("correct pw while locked:", locked.ok ? "FAIL — let in" : locked.error);

  await db.platformAdmin.update({ where: { email: EMAIL }, data: { lockedUntil: new Date(Date.now() - 1000) } });
  const after = await verifyPlatformLogin(EMAIL, "right-pass-123");
  const row = await db.platformAdmin.findUnique({ where: { email: EMAIL } });
  const reset = row?.failedLogins === 0 && row?.lockedUntil === null;
  console.log("after lock expiry:", after.ok ? "signed in" : "FAIL — still rejected", "| counters reset:", reset);

  if (!after.ok || !reset || locked.ok) throw new Error("lockout probe FAILED");
  console.log("\nlockout probe PASS");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.platformAdmin.deleteMany({ where: { email: EMAIL } });
    await db.$disconnect();
  });
