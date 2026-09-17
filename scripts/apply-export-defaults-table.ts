/**
 * Create the ExportDefault table directly, bypassing `prisma migrate deploy`.
 *
 * Same reason as scripts/apply-service-usage-table.ts: DATABASE_URL is a
 * PgBouncer transaction-pooled connection with no directUrl, so Prisma's
 * migration engine hangs against it. The statements match
 * prisma/migrations/20260917120000_add_export_defaults exactly, with
 * IF NOT EXISTS added so a re-run is harmless.
 *
 *   pnpm exec tsx scripts/apply-export-defaults-table.ts
 *
 * PowerShell, if execution policy blocks the pnpm shim:
 *   & "$env:APPDATA\npm\pnpm.cmd" exec tsx scripts/apply-export-defaults-table.ts
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "ExportDefault" (
     "id" TEXT NOT NULL,
     "marketplace" TEXT NOT NULL,
     "attribute" TEXT NOT NULL,
     "label" TEXT,
     "value" TEXT NOT NULL,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedBy" TEXT,
     CONSTRAINT "ExportDefault_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ExportDefault_marketplace_attribute_key"
     ON "ExportDefault"("marketplace", "attribute")`,
  `CREATE INDEX IF NOT EXISTS "ExportDefault_marketplace_idx" ON "ExportDefault"("marketplace")`,
];

(async () => {
  for (const sql of STATEMENTS) {
    await prisma.$executeRawUnsafe(sql);
    console.log(`  ok: ${sql.split("\n")[0].slice(0, 72)}…`);
  }
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    select count(*) as n from information_schema.tables where table_name = 'ExportDefault'`;
  const idx = await prisma.$queryRaw<{ indexname: string }[]>`
    select indexname from pg_indexes where tablename = 'ExportDefault' order by indexname`;
  console.log(`\nExportDefault exists: ${Number(n) > 0}; indexes: ${idx.map((i) => i.indexname).join(", ")}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
