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

const TABLES: { name: string; column?: string; statements: string[] }[] = [
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
  {
    name: "BalanceSnapshot",
    statements: [
      `CREATE TABLE IF NOT EXISTS "BalanceSnapshot" (
         "id" TEXT NOT NULL,
         "service" TEXT NOT NULL,
         "balanceCents" INTEGER NOT NULL,
         "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
         CONSTRAINT "BalanceSnapshot_pkey" PRIMARY KEY ("id")
       )`,
      `CREATE INDEX IF NOT EXISTS "BalanceSnapshot_service_capturedAt_idx"
         ON "BalanceSnapshot"("service", "capturedAt")`,
    ],
  },
  {
    // A column, not a table — the export records which required cells it could
    // not fill so the export screen can offer to set a default for each.
    name: "ExportJob",
    column: "unfilledRequired",
    statements: [`ALTER TABLE "ExportJob" ADD COLUMN IF NOT EXISTS "unfilledRequired" JSONB`],
  },
  {
    name: "Team",
    statements: [
      `CREATE TABLE IF NOT EXISTS "Team" (
         "id" TEXT NOT NULL,
         "name" TEXT NOT NULL,
         "slug" TEXT NOT NULL,
         "allowedMarketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
         "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
         CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "Team_slug_key" ON "Team"("slug")`,
      `CREATE INDEX IF NOT EXISTS "Team_slug_idx" ON "Team"("slug")`,
    ],
  },
  {
    // Every teamId is NULLABLE and unindexed data until the backfill runs, so
    // adding these changes nothing about how the app behaves.
    name: "User",
    column: "teamId",
    statements: [
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "teamId" TEXT`,
      `CREATE INDEX IF NOT EXISTS "User_teamId_idx" ON "User"("teamId")`,
    ],
  },
  {
    name: "Project",
    column: "teamId",
    statements: [
      `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "teamId" TEXT`,
      `CREATE INDEX IF NOT EXISTS "Project_teamId_idx" ON "Project"("teamId")`,
    ],
  },
  {
    name: "ExportTemplate",
    column: "teamId",
    statements: [
      `ALTER TABLE "ExportTemplate" ADD COLUMN IF NOT EXISTS "teamId" TEXT`,
      `CREATE INDEX IF NOT EXISTS "ExportTemplate_teamId_idx" ON "ExportTemplate"("teamId")`,
    ],
  },
  {
    // The one place teams change an EXISTING constraint. The old unique was
    // (marketplace, attribute); per team it has to include teamId. Postgres
    // treats NULLs as distinct, so that alone would let two GLOBAL rows share a
    // marketplace+attribute — hence the partial index covering teamId IS NULL.
    name: "ExportDefault",
    column: "teamId",
    statements: [
      `ALTER TABLE "ExportDefault" ADD COLUMN IF NOT EXISTS "teamId" TEXT`,
      `CREATE INDEX IF NOT EXISTS "ExportDefault_teamId_idx" ON "ExportDefault"("teamId")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "ExportDefault_teamId_marketplace_attribute_key"
         ON "ExportDefault"("teamId", "marketplace", "attribute")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "ExportDefault_global_marketplace_attribute_key"
         ON "ExportDefault"("marketplace", "attribute") WHERE "teamId" IS NULL`,
      // The old constraint would reject a team's override of a global column.
      `ALTER TABLE "ExportDefault" DROP CONSTRAINT IF EXISTS "ExportDefault_marketplace_attribute_key"`,
    ],
  },
];

(async () => {
  for (const t of TABLES) {
    for (const sql of t.statements) await prisma.$executeRawUnsafe(sql);
    // Verify what was actually asked for: an added column is not proved present
    // by its table existing, which is what the table check would have reported.
    const [{ n }] = t.column
      ? await prisma.$queryRaw<{ n: bigint }[]>`
          select count(*) as n from information_schema.columns
          where table_name = ${t.name} and column_name = ${t.column}`
      : await prisma.$queryRaw<{ n: bigint }[]>`
          select count(*) as n from information_schema.tables where table_name = ${t.name}`;
    console.log(`  ${Number(n) > 0 ? "ok  " : "FAIL"} ${t.name}${t.column ? "." + t.column : ""}`);
  }
  console.log("\nAll pending tables are present.");
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
