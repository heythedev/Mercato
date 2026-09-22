/**
 * Read-only survey of the Best Buy templates currently in the database.
 *
 * Deleting them is a one-way action on live data, so this reports exactly what
 * is there — count, sizes, owners, and whether the source workbooks still exist
 * on disk to re-upload from — before anything is removed.
 *
 *   pnpm exec tsx scripts/bestbuy-template-audit.ts
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";

const DIR = process.env.BESTBUY_TEMPLATE_DIR ?? "Best buy templates";

(async () => {
  const rows = await prisma.exportTemplate.findMany({
    where: { marketplace: { equals: "bestbuy", mode: "insensitive" } },
    select: { id: true, name: true, category: true, fileFormat: true, userId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Best Buy templates in the database: ${rows.length}\n`);
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(46).slice(0, 46)} ` +
        `cat=${(r.category ?? "—").padEnd(28).slice(0, 28)} ` +
        `owner=${r.userId ?? "global"}`,
    );
  }

  // Byte sizes come from SQL: selecting fileData would pull 39 MB into memory.
  const [size] = await prisma.$queryRaw<{ total: bigint | null; withfile: bigint }[]>`
    select sum(octet_length("fileData")) as total,
           count(*) filter (where "fileData" is not null) as withfile
    from "ExportTemplate" where lower(marketplace) = 'bestbuy'`;
  console.log(
    `\n  ${Number(size.withfile)} carry a workbook, ` +
      `${((Number(size.total ?? 0)) / 1024 / 1024).toFixed(1)} MB total`,
  );

  // Reversibility: the uploader script reads from this directory.
  const abs = path.resolve(DIR);
  const present = fs.existsSync(abs);
  const files = present ? fs.readdirSync(abs).filter((f) => /\.xlsx?$/i.test(f)) : [];
  console.log(`\n  Source workbooks at "${abs}": ${present ? `${files.length} files` : "NOT PRESENT"}`);
  console.log(
    present && files.length
      ? "  → deletion is reversible: scripts/upload-bestbuy-templates.ts can restore them."
      : "  → deletion is NOT reversible from disk; take a backup first.",
  );

  // What else points at these rows.
  const other = await prisma.exportTemplate.groupBy({
    by: ["marketplace"],
    _count: { _all: true },
  });
  console.log(
    "\n  Templates by marketplace: " +
      other.map((o) => `${o.marketplace}=${o._count._all}`).join(", "),
  );

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
