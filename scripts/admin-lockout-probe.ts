/* One-shot probe for /admin sign-in (spec 19 audit fix + the 2026-09-03
 * env-credentials change).
 *   npx tsx scripts/admin-lockout-probe.ts
 *
 * Checks, against the CURRENT .env of whichever environment you run it in:
 *   1. an env-managed row (empty hash) left behind by an older .env cannot sign
 *      in — the production bug was an operator account outliving the variable
 *      that created it;
 *   2. five wrong passwords lock the root account;
 *   3. the correct password is refused while the lock holds;
 *   4. once the lock expires the correct password works and counters reset.
 *
 * Accounts created at /admin/access are ordinary password logins and are not
 * what this probes. It locks the root account for a moment and clears the
 * counters again at the end — run it on dev, not while someone is using the
 * production console.
 */
import db from "../app/db.server";
import { verifyAdminLogin } from "../app/lib/admin/admin-auth.server";

const EMAIL = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const IMPOSTOR = "lock-probe@example.com";

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error("set ADMIN_EMAIL and ADMIN_PASSWORD in .env first");

  // 1. A leftover env-managed row is not a login: no hash, so nothing to match.
  await db.adminUser.deleteMany({ where: { email: IMPOSTOR } });
  await db.adminUser.create({ data: { email: IMPOSTOR, name: "Lock Probe", passwordHash: "" } });
  const impostor = await verifyAdminLogin(IMPOSTOR, "impostor-pass-123");
  console.log("stale env-managed row:", impostor.ok ? "FAIL — signed in" : impostor.error);

  for (let i = 1; i <= 5; i++) {
    const r = await verifyAdminLogin(EMAIL, `wrong-${i}`);
    console.log(`attempt ${i}:`, r.ok ? "FAIL — accepted wrong password" : r.error);
  }

  const locked = await verifyAdminLogin(EMAIL, PASSWORD);
  console.log("correct pw while locked:", locked.ok ? "FAIL — let in" : locked.error);

  await db.adminUser.update({ where: { email: EMAIL }, data: { lockedUntil: new Date(Date.now() - 1000) } });
  const after = await verifyAdminLogin(EMAIL, PASSWORD);
  const row = await db.adminUser.findUnique({ where: { email: EMAIL } });
  const reset = row?.failedLogins === 0 && row?.lockedUntil === null;
  console.log("after lock expiry:", after.ok ? "signed in" : "FAIL — still rejected", "| counters reset:", reset);

  if (impostor.ok || locked.ok || !after.ok || !reset) throw new Error("sign-in probe FAILED");
  console.log("\nsign-in probe PASS");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.adminUser.deleteMany({ where: { email: IMPOSTOR } });
    if (EMAIL) {
      await db.adminUser
        .updateMany({ where: { email: EMAIL }, data: { failedLogins: 0, lockedUntil: null } })
        .catch(() => undefined);
    }
    await db.$disconnect();
  });
