/**
 * Remove the Best Buy group templates, reversibly.
 *
 * Best Buy issues 22 GROUP workbooks, each covering ~100 categories. They were
 * the only way to export before per-category uploads existed, and while any of
 * them is present the export name-matches every category against them — which
 * is exactly what the per-category workflow replaces. Removing them is a
 * deliberate step in that migration, not cleanup.
 *
 * It is also a one-way action on live data, so this script:
 *   1. lists what it would remove and does NOTHING unless --confirm is passed;
 *   2. writes each workbook back to disk FIRST, so the set can be restored with
 *      scripts/upload-bestbuy-templates.ts if the decision is reversed.
 *
 * Categorisation is unaffected: nothing in the categorize path reads
 * ExportTemplate (it works off the Best Buy taxonomy), so removing these rows
 * cannot disturb a category assignment.
 *
 *   pnpm exec tsx scripts/delete-bestbuy-templates.ts            # dry run
 *   pnpm exec tsx scripts/delete-bestbuy-templates.ts --confirm  # back up, then delete
 *
 * Per-category templates — the ones a seller uploads for a single category, and
 * the ones "Build from Best Buy" creates — are KEPT by default: they are the
 * new workflow. Pass --all to remove those too.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";

const CONFIRM = process.argv.includes("--confirm");
const ALL = process.argv.includes("--all");
const BACKUP_DIR = path.resolve(
  process.env.BESTBUY_TEMPLATE_BACKUP_DIR ?? "bestbuy-templates-backup",
);

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120);

(async () => {
  const rows = await prisma.exportTemplate.findMany({
    where: {
      marketplace: { equals: "bestbuy", mode: "insensitive" },
      // A group template covers many categories and declares none; a
      // per-category template names the one category it is for.
      ...(ALL ? {} : { OR: [{ category: null }, { category: "" }] }),
    },
    select: { id: true, name: true, category: true, fileFormat: true },
    orderBy: { createdAt: "asc" },
  });

  if (rows.length === 0) {
    console.log(
      ALL
        ? "No Best Buy templates in this database — nothing to remove."
        : "No Best Buy GROUP templates in this database — nothing to remove.\n" +
          "(Per-category templates are kept by default; pass --all to include them.)",
    );
    await prisma.$disconnect();
    return;
  }

  console.log(`${rows.length} Best Buy template(s) would be removed:\n`);
  for (const r of rows) {
    console.log(`  ${r.name}${r.category ? `   [category: ${r.category}]` : "   [group template]"}`);
  }

  if (!CONFIRM) {
    console.log(
      "\nDry run — nothing was changed.\n" +
        "Re-run with --confirm to back the workbooks up to\n  " +
        BACKUP_DIR +
        "\nand then delete the rows.",
    );
    await prisma.$disconnect();
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let saved = 0;
  // One at a time: fileData is up to ~4 MB per row and loading 22 at once is a
  // needless 39 MB spike.
  for (const r of rows) {
    const one = await prisma.exportTemplate.findUnique({
      where: { id: r.id },
      select: { fileData: true },
    });
    if (!one?.fileData) continue;
    const ext = r.fileFormat === "csv" ? "csv" : "xlsx";
    fs.writeFileSync(path.join(BACKUP_DIR, `${safeName(r.name)}.${ext}`), one.fileData as Buffer);
    saved++;
  }
  console.log(`\nBacked up ${saved} workbook(s) to ${BACKUP_DIR}`);

  const { count } = await prisma.exportTemplate.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  console.log(`Deleted ${count} template row(s).`);
  console.log("Categorisation is unaffected — it never reads ExportTemplate.");

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
