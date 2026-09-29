/**
 * A backup, taken from a read-only database.
 *
 * On 28 Sep 2026 this project's disk filled, Postgres went read-only, then
 * refused to start at all. The dashboard said "LAST BACKUP: No backups", and
 * for several hours the only copy of 130,000 products was inside an instance
 * that would not open. Nobody should be one disk-full away from that.
 *
 * Reads only, so it runs while the database is read-only — which is exactly
 * when it is most needed and when every other tool is refused. It is also the
 * first thing to run once writes return, BEFORE any cleanup touches a row.
 *
 * Streams row by row and gzips as it goes: the Product table alone is 751MB
 * and loading it into memory would fail on this laptop.
 *
 * Excludes WalmartItemCache and KeepaProductCache by default — a cache is not
 * a thing you back up. Pass --with-caches if you want them anyway.
 *
 *   pnpm exec tsx scripts/backup-db.ts [outDir]
 *   pnpm exec tsx scripts/backup-db.ts ./backup --with-caches
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Client } from "pg";
import QueryStream from "pg-query-stream";

/** Restored in this order: a parent before anything that references it. */
const TABLES = [
  "Team",
  "User",
  "Account",
  "Session",
  "Project",
  "Product",
  "ProductAttribute",
  "ExportTemplate",
  "ExportJob",
  "ExportJobFile",
  "ServiceUsage",
  "BalanceSnapshot",
  "KeepaCodeLookup",
];

const CACHES = ["WalmartItemCache", "KeepaProductCache"];

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith("--")) ?? `backup-${new Date().toISOString().slice(0, 10)}`;
const withCaches = args.includes("--with-caches");

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  fs.mkdirSync(outDir, { recursive: true });
  const client = new Client({ connectionString, statement_timeout: 0 });
  await client.connect();

  // Explicitly, on the session. Passing statement_timeout to the Client only
  // sets a startup parameter, and Supabase's role default (2 minutes) wins —
  // which killed the first run 5 tables in, part-way through Product. A dump
  // of a 751MB table is a legitimately long statement.
  await client.query(`SET statement_timeout = 0`);
  await client.query(`SET idle_in_transaction_session_timeout = 0`);

  const { rows: [ro] } = await client.query<{ v: string }>(
    `select current_setting('default_transaction_read_only') as v`,
  );
  console.log(`database is ${ro.v === "on" ? "READ-ONLY (fine — this only reads)" : "writable"}`);
  console.log(`writing to ${path.resolve(outDir)}\n`);

  const wanted = withCaches ? [...TABLES, ...CACHES] : TABLES;
  const manifest: Record<string, { rows: number; bytes: number }> = {};
  let grandRows = 0;
  let grandBytes = 0;

  for (const table of wanted) {
    // A table absent from this database is not an error — the schema has
    // moved over time and a backup should not fail on a name that has gone.
    const { rows: [exists] } = await client.query<{ ok: boolean }>(
      `select to_regclass($1) is not null as ok`,
      [`public."${table}"`],
    );
    if (!exists?.ok) {
      console.log(`  ${table.padEnd(18)} skipped (no such table)`);
      continue;
    }

    const file = path.join(outDir, `${table}.jsonl.gz`);
    // One JSON object per line rather than one big array: a 751MB array has
    // to be parsed whole to read any of it, and cannot be appended to or
    // resumed. Line-delimited restores with a stream and greps with a shell.
    const query = new QueryStream(`select * from "${table}"`, [], { batchSize: 500 });
    const stream = client.query(query);

    let rows = 0;
    const source = Readable.from(
      (async function* () {
        for await (const row of stream) {
          rows++;
          yield JSON.stringify(row) + "\n";
        }
      })(),
    );

    await pipeline(source, zlib.createGzip({ level: 6 }), fs.createWriteStream(file));

    const bytes = fs.statSync(file).size;
    manifest[table] = { rows, bytes };
    grandRows += rows;
    grandBytes += bytes;
    console.log(`  ${table.padEnd(18)} ${String(rows).padStart(7)} rows   ${mb(bytes).padStart(10)}`);
  }

  const meta = {
    takenAt: new Date().toISOString(),
    databaseWasReadOnly: ro.v === "on",
    includesCaches: withCaches,
    tables: manifest,
    totals: { rows: grandRows, bytes: grandBytes },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(meta, null, 2));

  console.log(`\n  ${String(grandRows).padStart(7)} rows total, ${mb(grandBytes)} on disk`);
  console.log(`  manifest.json written — check it before trusting this backup`);
  if (!withCaches) console.log(`  caches excluded (re-fetched on demand); --with-caches to include them`);

  await client.end();
})().catch(async (e) => {
  console.error("\nBACKUP FAILED:", String(e).slice(0, 400));
  process.exit(1);
});
