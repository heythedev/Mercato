/**
 * Create the ServiceUsage table directly, bypassing `prisma migrate deploy`.
 *
 * This project's DATABASE_URL is a PgBouncer transaction-pooled connection with
 * no `directUrl`, so Prisma's migration engine hangs against it — the same
 * caveat recorded in 20260907160219_add_product_normalized_name_index. That
 * migration and its sibling were applied this way too, which is why both
 * indexes exist in the database while neither appears in _prisma_migrations.
 *
 * The statements match prisma/migrations/20260915120000_add_service_usage
 * exactly, with IF NOT EXISTS added so a re-run is harmless.
 *
 *   pnpm exec tsx scripts/apply-service-usage-table.ts
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";

const STATEMENTS = [
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
];

(async () => {
  for (const sql of STATEMENTS) {
    await prisma.$executeRawUnsafe(sql);
    console.log(`  ok: ${sql.split("\n")[0].slice(0, 72)}…`);
  }
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    select count(*) as n from information_schema.tables where table_name = 'ServiceUsage'`;
  const idx = await prisma.$queryRaw<{ indexname: string }[]>`
    select indexname from pg_indexes where tablename = 'ServiceUsage' order by indexname`;
  console.log(`\nServiceUsage exists: ${Number(n) > 0}; indexes: ${idx.map((i) => i.indexname).join(", ")}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
