/**
 * One-off backfill: fill in Walmart's own Spec Product Type for products that
 * were verified BEFORE item 1 (the whole-catalog Product Type lookup) existed
 * — without re-running verification, which would re-spend Walmart Affiliate
 * calls and re-trigger the AI image sweep for no reason. This only adds two
 * fields to each product's existing `liveData` JSON (productType,
 * catalogCategoryPath); every other stored field is left untouched.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/backfill-walmart-product-types.ts "ROCO-3000-MS" "TOPD MS" "TOPD 2"
 *   npx tsx scripts/backfill-walmart-product-types.ts --apply "ROCO-3000-MS" ...
 *
 * Dry-run by default (reports what it WOULD write, touches nothing). Pass
 * --apply as the first argument to actually persist the results.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { findWalmartCatalogMatch } from "../src/lib/walmart/seller-client";
import { AdaptiveLimiter, runPool } from "../src/lib/walmart/throttle";

async function main() {
  const rawArgs = process.argv.slice(2);
  const apply = rawArgs[0] === "--apply";
  const projectNames = apply ? rawArgs.slice(1) : rawArgs;
  if (!projectNames.length) {
    console.error("Usage: tsx scripts/backfill-walmart-product-types.ts [--apply] <project name> [more names...]");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  console.log(`${apply ? "APPLYING" : "DRY RUN (pass --apply to write)"} — projects: ${projectNames.join(", ")}`);

  type Row = { id: string; upc: string | null; liveData: unknown };
  const projects = await prisma.project.findMany({
    where: { name: { in: projectNames }, marketplace: { equals: "walmart", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!projects.length) {
    console.error("No matching Walmart projects found for those names.");
    await prisma.$disconnect();
    process.exit(1);
  }

  for (const project of projects) {
    console.log(`\n=== ${project.name} (${project.id}) ===`);
    const rows: Row[] = [];
    let cursor: string | null = null;
    for (;;) {
      const where: Prisma.ProductWhereInput = {
        projectId: project.id,
        verifyStatus: { in: ["ok", "warning"] },
        upc: { not: null },
        ...(cursor ? { id: { gt: cursor } } : {}),
      };
      const page: Row[] = await prisma.product.findMany({
        where,
        orderBy: { id: "asc" },
        take: 1000,
        select: { id: true, upc: true, liveData: true },
      });
      if (!page.length) break;
      rows.push(...page);
      cursor = page[page.length - 1].id;
    }

    // Walmart's Affiliate API returns itemId as a JSON NUMBER, not a string —
    // confirmed against production data. Accept either and coerce to string;
    // a strict `typeof === "string"` check here made a first version of this
    // script (and the same check in verify.ts) find nothing to do at all.
    const rawItemId = (ld: Record<string, unknown> | null | undefined): string => {
      const v = ld?.itemId;
      return typeof v === "string" || typeof v === "number" ? String(v) : "";
    };
    const targets = rows.filter((r) => {
      const ld = r.liveData as Record<string, unknown> | null;
      const hasType = typeof ld?.productType === "string" && ld.productType.trim();
      return r.upc && rawItemId(ld) && !hasType;
    });
    console.log(`${rows.length} verified products, ${targets.length} missing a Product Type and eligible for backfill`);
    if (!targets.length) continue;

    const limiter = new AdaptiveLimiter({ start: 3, min: 1, max: 8, growthThreshold: 30 });
    let hits = 0;
    let noMatch = 0;
    let failed = 0;
    let timedOut = 0;
    let settled = 0;
    const t0 = Date.now();
    const PROGRESS_EVERY = 100;
    // seller-client.ts's fetchWithRetry sets no timeout on the underlying
    // fetch() — a hung connection (observed once against the live API while
    // building this script) can otherwise stall the whole pool forever with
    // no visible progress and nothing to kill it. This can't cancel the
    // underlying request, only stop WAITING on it so the script keeps moving.
    const REQUEST_TIMEOUT_MS = 20_000;
    const withTimeout = <T,>(p: Promise<T>): Promise<T | "timeout"> =>
      Promise.race([p, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), REQUEST_TIMEOUT_MS))]);

    await runPool(targets, limiter, async (r) => {
      const ld = r.liveData as Record<string, unknown>;
      const itemId = rawItemId(ld);
      const match = await withTimeout(findWalmartCatalogMatch(r.upc!, itemId).catch(() => undefined));
      settled++;
      if (settled % PROGRESS_EVERY === 0) {
        console.log(`  ${settled}/${targets.length} (${((Date.now() - t0) / 1000).toFixed(0)}s, concurrency ${limiter.width}, ${limiter.stats.rateLimited} rate-limited)`);
      }
      if (match === "timeout") { timedOut++; return; }
      if (match === undefined) { failed++; return; }
      if (!match || !match.productType) { noMatch++; return; }
      hits++;
      if (!apply) return;
      const newLiveData = { ...ld, productType: match.productType, ...(match.categoryPath?.length ? { catalogCategoryPath: match.categoryPath } : {}) };
      await prisma.product.update({
        where: { id: r.id },
        data: { liveData: newLiveData as Prisma.InputJsonValue },
      });
    });

    console.log(
      `done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${hits} ${apply ? "written" : "would be written"}, ` +
        `${noMatch} no Walmart match for this exact item, ${failed} lookup failures, ${timedOut} timed out ` +
        `(all left untouched), concurrency settled at ${limiter.width}, ${limiter.stats.rateLimited} rate-limited waits`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
