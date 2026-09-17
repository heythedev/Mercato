/**
 * Create every table this database is missing, bypassing `prisma migrate deploy`.
 *
 * DATABASE_URL is a PgBouncer transaction-pooled connection with no directUrl,
 * so Prisma's migration engine hangs against it — measured: `prisma migrate
 * status` ran past 300s with no output. The same caveat is recorded in
 * 20260907160219_add_product_normalized_name_index, whose index (and its
 * sibling) were applied this way too, which is why both exist in the database
 * while neither appears in _prisma_migrations.
 *
 * Every statement is IF NOT EXISTS, so running this is always safe and always
 * idempotent. It supersedes the two single-table scripts.
 *
 *   pnpm exec tsx scripts/apply-pending-tables.ts
 *
 * PowerShell, when the execution policy blocks the pnpm shim:
 *   & "$env:APPDATA\npm\pnpm.cmd" exec tsx scripts/apply-pending-tables.ts
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";

const TABLES: { name: string; statements: string[] }[] = [
  {
    name: "ServiceUsage",
    statements: [
      `CREATE TABLE IF NOT EXISTS "ServiceUsage" (
         "id" TEXT NOT NULL,
         "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "service" TEXT NOT NULL,
         "model" TEXT,
         "feature" TEXT NOT NULL,
         "projectId" TEXT,
         "userId" TEXT,
         "inputTokens" INTEGER NOT NULL DEFAULT 0,
         "outputTokens" INTEGER NOT NULL DEFAULT 0,
         "units" INTEGER NOT NULL DEFAULT 0,
         "durationMs" INTEGER,
         "ok" BOOLEAN NOT NULL DEFAULT true,
         CONSTRAINT "ServiceUsage_pkey" PRIMARY KEY ("id")
       )`,
      `CREATE INDEX IF NOT EXISTS "ServiceUsage_createdAt_idx" ON "ServiceUsage"("createdAt")`,
      `CREATE INDEX IF NOT EXISTS "ServiceUsage_service_createdAt_idx" ON "ServiceUsage"("service", "createdAt")`,
      `CREATE INDEX IF NOT EXISTS "ServiceUsage_feature_createdAt_idx" ON "ServiceUsage"("feature", "createdAt")`,
      `CREATE INDEX IF NOT EXISTS "ServiceUsage_projectId_idx" ON "ServiceUsage"("projectId")`,
    ],
  },
  {
    name: "ExportDefault",
    statements: [
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
    ],
  },
  {
    name: "ProductAttribute",
    statements: [
      `CREATE TABLE IF NOT EXISTS "ProductAttribute" (
         "id" TEXT NOT NULL,
         "productId" TEXT NOT NULL,
         "attribute" TEXT NOT NULL,
         "value" TEXT NOT NULL,
         "source" TEXT NOT NULL,
         "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
         CONSTRAINT "ProductAttribute_pkey" PRIMARY KEY ("id")
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "ProductAttribute_productId_attribute_key"
         ON "ProductAttribute"("productId", "attribute")`,
      `CREATE INDEX IF NOT EXISTS "ProductAttribute_productId_idx" ON "ProductAttribute"("productId")`,
      // Added separately so a re-run does not fail on an existing constraint.
      `DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'ProductAttribute_productId_fkey'
         ) THEN
           ALTER TABLE "ProductAttribute"
             ADD CONSTRAINT "ProductAttribute_productId_fkey"
             FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
         END IF;
       END $$`,
    ],
  },
];

(async () => {
  for (const t of TABLES) {
    for (const sql of t.statements) await prisma.$executeRawUnsafe(sql);
    const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
      select count(*) as n from information_schema.tables where table_name = ${t.name}`;
    console.log(`  ${Number(n) > 0 ? "ok  " : "FAIL"} ${t.name}`);
  }
  console.log("\nAll pending tables are present.");
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
