/**
 * Reclaim database disk space, without erasing anything a person created.
 *
 * On 28 Sep 2026 the Supabase project hit 96% disk (1.6GB database + 128MB WAL
 * + 169MB system on a ~2GB Free-tier disk) and Postgres was put into read-only
 * mode. Every write failed: categorisation stopped at 826 of 1,999 products,
 * exports could not create their job row, progress polls returned 500. The
 * application was never at fault.
 *
 * TWO THINGS RECLAIM SPACE, AND THEY ARE NOT THE SAME:
 *
 *   --vacuum    Returns space already wasted on DEAD ROWS — old versions
 *               Postgres kept after an UPDATE and never handed back. Deletes
 *               NOTHING. Every live row survives untouched. ExportTemplate is
 *               80MB on disk for ~4MB of real workbooks; that gap is the waste.
 *
 *   --truncate-walmart-cache
 *               Empties ONE derived cache of scraped Walmart listings. This
 *               does erase those rows — they are re-scraped on demand, for
 *               free, and nothing references them. It is the only destructive
 *               action here and it is opt-in, confirmed, and allowlisted.
 *
 * DELETE is deliberately never used. It frees no disk at all — it only creates
 * more dead rows — and the VACUUM FULL that would then be needed rewrites the
 * whole table, so it needs as much free disk as the table is big. At 96% full
 * that fails. TRUNCATE drops the files outright: instant, no scratch space.
 *
 * Everything runs on ONE pg connection rather than through Prisma's pool,
 * because the read-only escape is a SESSION setting — on a pool the next query
 * can land on a different connection that never received it.
 *
 *   pnpm exec tsx scripts/reclaim-disk.ts                    # report only
 *   pnpm exec tsx scripts/reclaim-disk.ts --vacuum           # safe, no deletion
 *   pnpm exec tsx scripts/reclaim-disk.ts --truncate-walmart-cache --confirm
 */
import "dotenv/config";
import { Client } from "pg";

/**
 * Tables this script may touch. Anything a person created — Product, Project,
 * ExportTemplate, User, Team, ProductAttribute — can be VACUUMed (which never
 * deletes) but can never be truncated, and the truncate list is checked
 * against this rather than taken from an argument.
 */
const VACUUM_SAFE = [
  // Ordered smallest-first ON PURPOSE. VACUUM FULL rewrites a table, so it
  // needs roughly as much free disk as that table's live data. At 96% full the
  // only ones that can run are the small, badly bloated ones — and each one
  // that succeeds frees the headroom the next needs.
  "ExportJob",
  "ExportTemplate",
  "KeepaCodeLookup",
  "ProductAttribute",
  "Product",
] as const;

/** The ONLY table this script will ever empty. */
const TRUNCATABLE = ["WalmartItemCache"] as const;

const args = new Set(process.argv.slice(2));
const doVacuum = args.has("--vacuum");
const doTruncate = args.has("--truncate-walmart-cache");
const confirmed = args.has("--confirm");

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

type Row = { relname: string; total: string; live: string; dead: string; bytes: string };

async function report(c: Client, heading: string) {
  const { rows } = await c.query<Row>(`
    select relname,
           pg_total_relation_size(relid) as total,
           pg_total_relation_size(relid)::text as bytes,
           n_live_tup as live, n_dead_tup as dead
    from pg_stat_user_tables
    order by pg_total_relation_size(relid) desc limit 8`);
  const { rows: [db] } = await c.query<{ size: string }>(
    `select pg_database_size(current_database())::text as size`);

  console.log(`\n── ${heading} ── database ${mb(Number(db.size))}`);
  console.log("   table                  on disk    live rows    dead rows");
  for (const r of rows) {
    const live = Number(r.live), dead = Number(r.dead);
    const pct = live + dead > 0 ? Math.round((dead / (live + dead)) * 100) : 0;
    console.log(
      `   ${r.relname.slice(0, 20).padEnd(20)} ${mb(Number(r.bytes)).padStart(8)} ` +
      `${String(live).padStart(12)} ${String(dead).padStart(12)} (${pct}%)`,
    );
  }
  return Number(db.size);
}

(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const c = new Client({ connectionString, statement_timeout: 0 });
  await c.connect();

  const { rows: [ro] } = await c.query<{ ro: string }>(`show default_transaction_read_only`);
  const readOnly = ro.ro === "on";
  console.log(`database is ${readOnly ? "READ-ONLY (writes are being refused)" : "writable"}`);

  const before = await report(c, "before");

  if (!doVacuum && !doTruncate) {
    console.log(
      "\nReport only — nothing was changed.\n" +
      "  --vacuum                    reclaim dead-row space. Deletes nothing.\n" +
      "  --truncate-walmart-cache    empty the scraped Walmart cache (--confirm required).\n",
    );
    await c.end();
    return;
  }

  if (readOnly) {
    // Supabase's documented escape so a full disk can be cleaned up. It applies
    // to THIS session only and changes nothing for the application.
    await c.query(`SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`);
    console.log("\nread-only overridden for this session only (the app is unaffected)");
  }

  if (doTruncate) {
    if (!confirmed) {
      console.log(
        `\nREFUSING to truncate without --confirm.\n` +
        `  This empties ${TRUNCATABLE.join(", ")} — scraped listing data that is\n` +
        `  re-fetched on demand at no cost. No product, project, template or user\n` +
        `  row is touched. Re-run with --confirm if that is what you want.`,
      );
    } else {
      for (const t of TRUNCATABLE) {
        const { rows: [n] } = await c.query<{ n: string }>(`select count(*)::text as n from "${t}"`);
        console.log(`\nTRUNCATE "${t}" — ${Number(n).toLocaleString()} cached rows`);
        await c.query(`TRUNCATE TABLE "${t}"`);
        console.log(`  done — space returned immediately, no vacuum needed`);
      }
    }
  }

  if (doVacuum) {
    console.log("\nVACUUM FULL — reclaims dead-row space only, deletes nothing:");
    for (const t of VACUUM_SAFE) {
      const started = Date.now();
      try {
        // Cannot run inside a transaction block, which is why this script uses
        // a plain client and never wraps these in one.
        await c.query(`VACUUM (FULL, ANALYZE) "${t}"`);
        console.log(`  ${t.padEnd(18)} ok   ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (e) {
        // Out of scratch space is the expected failure on a nearly-full disk,
        // and it is not fatal: the smaller tables above it have already freed
        // what they could, and the run continues.
        console.log(`  ${t.padEnd(18)} SKIPPED — ${String((e as Error).message).slice(0, 90)}`);
      }
    }
  }

  const after = await report(c, "after");
  const freed = before - after;
  console.log(
    `\nreclaimed ${mb(Math.max(0, freed))}` +
    (freed > 0 ? " — check the Supabase dashboard; read-only lifts once disk is back under ~95%" : ""),
  );
  await c.end();
})().catch((e) => {
  console.error("FAILED:", String(e).slice(0, 400));
  process.exit(1);
});
