/**
 * Give every existing account the write tools it had before the per-account
 * choice existed.
 *
 * The choice shipped with an empty default and no backfill, so the deploy that
 * introduced it revoked MCP write access for everybody at once: writes had
 * been governed by MCP_WRITE_ENABLED alone and were on, and there was no
 * earlier per-account answer to carry forward. Every row read as "chose
 * nothing", which the endpoint correctly honoured as read-only.
 *
 * This sets those rows to ['*'] AND today's eleven names. Both, deliberately:
 * the deployment currently running predates the sentinel and resolves a stored
 * choice by matching names, so '*' alone would leave it reading zero tools and
 * nothing would change until the next deploy. The names make it work now; the
 * sentinel makes a twelfth tool work later. The next tick of any checkbox
 * rewrites the row to whichever of the two the person actually meant.
 *
 *   pnpm exec tsx scripts/backfill-mcp-write-tools.ts        # report only
 *   pnpm exec tsx scripts/backfill-mcp-write-tools.ts --apply
 *
 * RUN IT ONCE. It cannot tell "never chose" from "deliberately switched them
 * all off" — both are an empty list — so running it after somebody has chosen
 * None would hand that person back what they just turned off. It is deliberately
 * not part of apply-pending-tables.ts, which is safe to run any number of times.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { ALL_WRITE_TOOLS, WRITE_TOOLS } from "../src/lib/mcp/write-tools";

const apply = process.argv.includes("--apply");

(async () => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, mcpWriteTools: true },
    orderBy: { email: "asc" },
  });

  // A row holding nothing but the sentinel is one this script wrote on an
  // earlier run, before the names were added alongside it — it is still
  // read-only everywhere the sentinel is not understood yet, so it is treated
  // as unfinished rather than as somebody's choice.
  const empty = users.filter(
    (u) =>
      u.mcpWriteTools.length === 0 ||
      (u.mcpWriteTools.length === 1 && u.mcpWriteTools[0] === ALL_WRITE_TOOLS),
  );
  const already = users.length - empty.length;

  console.log(`${users.length} account(s); ${already} already have a choice stored.`);
  if (empty.length === 0) {
    console.log("Nothing to backfill.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n${empty.length} read-only account(s) would get all ${WRITE_TOOLS.length} write tools:`);

  for (const u of empty) console.log(`  ${u.email ?? u.id} (${u.role})`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write.");
    await prisma.$disconnect();
    return;
  }

  const { count } = await prisma.user.updateMany({
    where: { id: { in: empty.map((u) => u.id) } },
    data: { mcpWriteTools: [ALL_WRITE_TOOLS, ...WRITE_TOOLS.map((t) => t.name)] },
  });
  console.log(`\nUpdated ${count} account(s).`);
  console.log("Each person's Claude picks the tools up on its next connection (/mcp, or a new chat).");
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
