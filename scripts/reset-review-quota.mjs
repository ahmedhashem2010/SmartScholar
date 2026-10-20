import "./_env.mjs";
import { requireEnv } from "./_env.mjs";
requireEnv("DATABASE_URL");
import { PrismaClient } from "@prisma/client";

/**
 * Operator tool: give ONE account a fresh daily AI-review quota.
 *
 *   node scripts/reset-review-quota.mjs someone@example.com          # dry run
 *   node scripts/reset-review-quota.mjs someone@example.com --yes    # apply
 *
 * Why a script: the daily limit (DAILY_REVIEW_LIMIT) is a product rule applied
 * to everyone, so it must not grow a per-user exception in the route. A support
 * reset is a database fact, not a code path — this deletes today's
 * ReviewDailyUsage row and nothing else. The shared limit is untouched, and
 * every other account keeps its usage.
 *
 * Dry run is the default. `--all-days` clears the whole history for that user
 * (rarely what you want; the quota only ever reads today's row).
 */

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  const apply = process.argv.includes("--yes");
  const allDays = process.argv.includes("--all-days");

  if (!email || email.startsWith("--")) {
    console.error("Usage: node scripts/reset-review-quota.mjs <email> [--all-days] [--yes]");
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, name: true },
  });

  if (!user) {
    console.error(`No User row for ${email}.`);
    console.error("The account may never have completed onboarding, in which case it has no quota rows either.");
    process.exitCode = 1;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const where = allDays ? { userId: user.id } : { userId: user.id, day: today };

  const rows = await prisma.reviewDailyUsage.findMany({
    where,
    orderBy: { day: "desc" },
    select: { day: true, count: true },
  });

  console.log(`\nUser:  ${user.email} (${user.name ?? "no name"})`);
  console.log(`Id:    ${user.id}`);
  console.log(`Scope: ${allDays ? "all days" : `today only (${today})`}`);
  console.log(rows.length ? "Rows:" : "Rows: none");
  for (const row of rows) console.log(`  ${row.day}  count=${row.count}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --yes to delete the row(s) above.\n");
    return;
  }

  const { count } = await prisma.reviewDailyUsage.deleteMany({ where });
  console.log(`\nDeleted ${count} row(s). Reviews used today is now 0.\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
