/* Platform admin account management (spec 19) — operator accounts for the
 * /platform dashboard. Usage:
 *   npx tsx scripts/platform-admin.ts create <email> <name> <password>
 *   npx tsx scripts/platform-admin.ts list
 *   npx tsx scripts/platform-admin.ts reset-password <email> <newPassword>
 *   npx tsx scripts/platform-admin.ts remove <email>
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword, passwordProblem } from "../app/lib/team/password.server";

const db = new PrismaClient();

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "create": {
      const [email, name, password] = args;
      if (!email || !name || !password) throw new Error("usage: create <email> <name> <password>");
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      const admin = await db.platformAdmin.create({
        data: { email: email.trim().toLowerCase(), name, passwordHash: await hashPassword(password) },
      });
      console.log(`created platform admin ${admin.email} (${admin.id})`);
      break;
    }
    case "list": {
      const admins = await db.platformAdmin.findMany({ orderBy: { createdAt: "asc" } });
      for (const a of admins) console.log(`${a.email}\t${a.name}\tcreated ${a.createdAt.toISOString()}`);
      if (admins.length === 0) console.log("(no platform admins — run the create command)");
      break;
    }
    case "reset-password": {
      const [email, password] = args;
      if (!email || !password) throw new Error("usage: reset-password <email> <newPassword>");
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      const admin = await db.platformAdmin.update({
        where: { email: email.trim().toLowerCase() },
        data: { passwordHash: await hashPassword(password) },
      });
      await db.platformSession.deleteMany({ where: { adminId: admin.id } });
      console.log(`password reset for ${admin.email}; all sessions revoked`);
      break;
    }
    case "remove": {
      const [email] = args;
      if (!email) throw new Error("usage: remove <email>");
      const admin = await db.platformAdmin.delete({ where: { email: email.trim().toLowerCase() } });
      console.log(`removed platform admin ${admin.email}`);
      break;
    }
    default:
      throw new Error("commands: create | list | reset-password | remove");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
