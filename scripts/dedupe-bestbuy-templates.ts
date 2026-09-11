/**
 * Remove the duplicate Best Buy templates.
 *
 * The 22 real templates were uploaded through the admin UI and are named after
 * their files ("Best buy Template Health and Beauty"). A second set of 22 was
 * then created by accident when scripts/upload-bestbuy-templates.ts was run
 * with `--dry` — the script tests for `--dry-run`, so the "dry run" wrote. That
 * set carries the same files under names with the "Best buy Template" prefix
 * stripped ("Health and Beauty"), leaving 44 rows where every category is
 * covered twice: each export scans double the templates and either copy can win
 * the match.
 *
 * The uploaded originals are kept because they hold the names the user chose and
 * the ids anything else may already reference; the stripped-name copies go.
 *
 * Safety: refuses to run unless the split is exactly the shape described above —
 * both groups present, and every deletion candidate paired with a survivor of
 * the same column count. Dry run by default.
 *
 *   npx tsx -r dotenv/config scripts/dedupe-bestbuy-templates.ts            # preview
 *   npx tsx -r dotenv/config scripts/dedupe-bestbuy-templates.ts --apply    # delete
 */
import { prisma } from "../src/lib/db";

const APPLY = process.argv.includes("--apply");

/** The uploaded originals all begin with "Best…"; the accidental copies do not. */
const isOriginal = (name: string) => /^\s*best/i.test(name);

(async () => {
  const rows = await prisma.exportTemplate.findMany({
    where: { marketplace: "bestbuy" },
    select: { id: true, name: true, columns: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const colCount = (c: unknown) => (Array.isArray(c) ? c.length : 0);
  const keep = rows.filter((r) => isOriginal(r.name));
  const drop = rows.filter((r) => !isOriginal(r.name));

  console.log(`${rows.length} bestbuy template(s): ${keep.length} to keep, ${drop.length} to remove${APPLY ? "" : "   (DRY RUN)"}\n`);

  if (!keep.length || !drop.length) {
    throw new Error(`refusing to run: expected both groups, got keep=${keep.length} drop=${drop.length}`);
  }

  // Every copy must correspond to a survivor with the same column count, or the
  // two sets are not the duplicate pair this script was written for.
  const keptSizes = new Map<number, number>();
  for (const k of keep) keptSizes.set(colCount(k.columns), (keptSizes.get(colCount(k.columns)) ?? 0) + 1);
  const unpaired = drop.filter((d) => !keptSizes.get(colCount(d.columns)));
  if (unpaired.length) {
    throw new Error(
      `refusing to run: ${unpaired.length} candidate(s) have no matching original — ` +
      unpaired.map((u) => `"${u.name}"`).join(", "),
    );
  }

  for (const d of drop) {
    console.log(`  remove  ${String(colCount(d.columns)).padStart(5)} cols  ${d.name}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply to remove them.");
    await prisma.$disconnect();
    return;
  }

  const res = await prisma.exportTemplate.deleteMany({ where: { id: { in: drop.map((d) => d.id) } } });
  const left = await prisma.exportTemplate.count({ where: { marketplace: "bestbuy" } });
  console.log(`\ndeleted ${res.count}; ${left} bestbuy template(s) remain`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error((e as Error).message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
