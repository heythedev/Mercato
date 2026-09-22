/**
 * Put existing data into a team, so per-team scoping has something to scope.
 *
 * Everything in the database predates teams and carries `teamId = null`. Left
 * that way, switching isolation on would show a team member an empty app. This
 * assigns one team to every user and stamps each project and template with its
 * owner's team.
 *
 * Nothing about how the app behaves changes when this runs: `teamId` is not
 * read by any query until the authz scopes start using it. It is safe to run
 * before the UI exists, and safe to run twice — every write is conditional on
 * the row still being unassigned.
 *
 * The super admin is included. `isAdmin` bypasses team scoping entirely, so
 * belonging to a team costs them nothing and keeps their projects — which is
 * all of them today — inside the team their colleagues can be given access to.
 *
 *   pnpm exec tsx scripts/backfill-teams.ts                    # dry run
 *   pnpm exec tsx scripts/backfill-teams.ts --confirm
 *   pnpm exec tsx scripts/backfill-teams.ts --confirm --name "Virventures"
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { MARKETPLACE_IDS } from "../src/lib/marketplaces/catalog";

const CONFIRM = process.argv.includes("--confirm");
const nameArg = process.argv.indexOf("--name");
const TEAM_NAME = nameArg > -1 ? process.argv[nameArg + 1] : "Default team";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "team";

(async () => {
  const [users, projects, templates] = await Promise.all([
    prisma.user.count({ where: { teamId: null } }),
    prisma.project.count({ where: { teamId: null } }),
    prisma.exportTemplate.count({ where: { teamId: null, userId: { not: null } } }),
  ]);

  console.log(`Team to use: "${TEAM_NAME}" (slug: ${slugify(TEAM_NAME)})\n`);
  console.log(`  users with no team      : ${users}`);
  console.log(`  projects with no team   : ${projects}`);
  console.log(`  user-owned templates    : ${templates}`);
  console.log(
    `\n  Global templates (userId null) are deliberately left global — they are\n` +
      `  meant to be shared across every team, which is what teamId null means.`,
  );

  if (!CONFIRM) {
    console.log("\nDry run — nothing was changed. Re-run with --confirm to apply.");
    await prisma.$disconnect();
    return;
  }

  const team = await prisma.team.upsert({
    where: { slug: slugify(TEAM_NAME) },
    create: {
      name: TEAM_NAME,
      slug: slugify(TEAM_NAME),
      // The ceiling starts at everything; narrowing it is a decision for later,
      // and starting narrow would silently block project creation today.
      allowedMarketplaces: [...MARKETPLACE_IDS],
    },
    update: {},
    select: { id: true, name: true, slug: true },
  });
  console.log(`\nTeam ${team.slug} → ${team.id}`);

  const u = await prisma.user.updateMany({ where: { teamId: null }, data: { teamId: team.id } });
  console.log(`  users assigned     : ${u.count}`);

  // Each project follows its OWNER's team rather than being assigned in bulk,
  // so this stays correct once more than one team exists.
  const owners = await prisma.user.findMany({
    where: { teamId: { not: null } },
    select: { id: true, teamId: true },
  });
  let projectCount = 0;
  let templateCount = 0;
  for (const owner of owners) {
    const p = await prisma.project.updateMany({
      where: { userId: owner.id, teamId: null },
      data: { teamId: owner.teamId },
    });
    projectCount += p.count;
    const t = await prisma.exportTemplate.updateMany({
      where: { userId: owner.id, teamId: null },
      data: { teamId: owner.teamId },
    });
    templateCount += t.count;
  }
  console.log(`  projects stamped   : ${projectCount}`);
  console.log(`  templates stamped  : ${templateCount}`);
  console.log(
    "\nNo behaviour has changed: nothing reads teamId until the authz scopes do.",
  );

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
