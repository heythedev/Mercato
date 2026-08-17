// Full clone of the old Neon DB into the current DB (Supabase).
//
// Context: the Neon free-tier project hit its monthly data-transfer quota in
// Aug 2026 and refuses ALL connections until the quota resets (1st of the
// month) or the plan is upgraded. Production was repointed to a fresh
// Supabase DB in the meantime, so the old data has to be copied over once
// Neon answers again.
//
// Usage:
//   node scripts/migrate-neon-to-supabase.cjs --core     # users + access + templates only (MERGE, deletes nothing)
//   node scripts/migrate-neon-to-supabase.cjs [--force]  # full clone incl. projects/products (REPLACES target data)
//
// Reads OLD_DATABASE_URL (Neon, source) and DATABASE_URL (target) from .env.
//
// --core is the priority restore: every user account (with role and
// allowedMarketplaces), their Google sign-in links, and all export templates.
// It merges — users that already exist on the target (matched by email) get
// their access restored in place, new-DB projects are untouched.
//
// The full clone clears the target's application tables and replaces them with
// an exact copy of the source — ids included, so old login sessions keep
// working. It aborts before touching the target if the source is unreachable,
// or if the target already contains projects (pass --force to delete them).
const { createRequire } = require("module");
const req = createRequire(process.cwd() + "/package.json");
req("dotenv").config();
const { Client } = req("pg");

const BATCH = 200;

// Insert order respects foreign keys (parents before children). Keys are the
// primary key (or unique) columns used for keyset pagination.
const TABLES = [
  { name: "User", keys: ["id"] },
  { name: "Account", keys: ["id"] },
  { name: "Session", keys: ["id"] },
  { name: "VerificationToken", keys: ["identifier", "token"] },
  { name: "Project", keys: ["id"] },
  { name: "Product", keys: ["id"] },
  { name: "ExportTemplate", keys: ["id"] },
  { name: "KeepaCodeLookup", keys: ["code", "domain"] },
  { name: "KeepaProductCache", keys: ["asin", "domain"] },
  { name: "WalmartItemCache", keys: ["code"] },
];

// Priority restore: users (with role + allowedMarketplaces), their OAuth
// sign-in links, and export templates. Merge semantics — nothing is deleted.
async function restoreCore(oldDb, newDb) {
  const idMap = new Map(); // old user id -> id on the target

  const users = await oldDb.query('SELECT row_to_json(t.*) AS r FROM "User" t ORDER BY "id"');
  let inserted = 0;
  let merged = 0;
  for (const { r: u } of users.rows) {
    const existing = await newDb.query('SELECT id FROM "User" WHERE email = $1', [u.email]);
    if (existing.rows.length) {
      // Same person already exists on the new DB (e.g. re-seeded admin or a
      // re-registered user): restore their access onto that row, keep its id
      // so anything they created since the swap stays linked.
      const newId = existing.rows[0].id;
      idMap.set(u.id, newId);
      await newDb.query(
        'UPDATE "User" SET name = COALESCE($2, name), image = COALESCE($3, image), password = COALESCE($4, password), role = $5, "allowedMarketplaces" = $6 WHERE id = $1',
        [newId, u.name, u.image, u.password, u.role, u.allowedMarketplaces],
      );
      merged += 1;
    } else {
      idMap.set(u.id, u.id);
      await newDb.query('INSERT INTO "User" SELECT * FROM json_populate_record(NULL::"User", $1::json)', [
        JSON.stringify(u),
      ]);
      inserted += 1;
    }
  }
  console.log(`Users: ${inserted} restored, ${merged} merged into existing accounts`);

  const accounts = await oldDb.query('SELECT row_to_json(t.*) AS r FROM "Account" t ORDER BY "id"');
  let oauthLinks = 0;
  for (const { r: a } of accounts.rows) {
    if (!idMap.has(a.userId)) continue;
    a.userId = idMap.get(a.userId);
    const res = await newDb.query(
      'INSERT INTO "Account" SELECT * FROM json_populate_record(NULL::"Account", $1::json) ON CONFLICT ("provider", "providerAccountId") DO NOTHING',
      [JSON.stringify(a)],
    );
    oauthLinks += res.rowCount;
  }
  console.log(`OAuth sign-in links: ${oauthLinks} restored`);

  const templates = await oldDb.query('SELECT row_to_json(t.*) AS r FROM "ExportTemplate" t ORDER BY "id"');
  let tpl = 0;
  for (const { r: t } of templates.rows) {
    if (t.userId != null) t.userId = idMap.get(t.userId) ?? null;
    const res = await newDb.query(
      'INSERT INTO "ExportTemplate" SELECT * FROM json_populate_record(NULL::"ExportTemplate", $1::json) ON CONFLICT ("id") DO NOTHING',
      [JSON.stringify(t)],
    );
    tpl += res.rowCount;
  }
  console.log(`Export templates: ${tpl} restored (of ${templates.rows.length} in the old DB)`);
}

(async () => {
  const force = process.argv.includes("--force");
  const core = process.argv.includes("--core");
  if (!process.env.OLD_DATABASE_URL) {
    console.error("ABORT: OLD_DATABASE_URL is not set in .env");
    process.exit(1);
  }
  const oldDb = new Client({ connectionString: process.env.OLD_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const newDb = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Preflight the SOURCE first — if Neon is still quota-blocked we must find
  // out before clearing anything on the target.
  try {
    await oldDb.connect();
    const counts = await oldDb.query(
      'SELECT (SELECT COUNT(*)::int FROM "User") AS users, (SELECT COUNT(*)::int FROM "ExportTemplate") AS templates, (SELECT COUNT(*)::int FROM "Project") AS projects, (SELECT COUNT(*)::int FROM "Product") AS products',
    );
    console.log("Old DB reachable. Available to copy:", JSON.stringify(counts.rows[0]));
  } catch (e) {
    console.error("ABORT: old DB unreachable —", e.message);
    console.error("Nothing was changed. Try again after the Neon quota resets (1st of the month) or after upgrading the Neon plan.");
    process.exit(1);
  }

  await newDb.connect();

  if (core) {
    await restoreCore(oldDb, newDb);
    await oldDb.end();
    await newDb.end();
    return;
  }

  // Don't silently wipe projects created on the new DB since the swap.
  const existing = await newDb.query(
    'SELECT (SELECT COUNT(*)::int FROM "Project") AS projects, (SELECT COUNT(*)::int FROM "Product") AS products',
  );
  if (existing.rows[0].projects > 0 && !force) {
    console.error(`ABORT: the new DB already has ${existing.rows[0].projects} project(s) / ${existing.rows[0].products} product(s).`);
    console.error("Re-run with --force to DELETE them and replace everything with the old DB's data.");
    process.exit(2);
  }

  // Clear target tables child-first so FK constraints allow it.
  for (const t of [...TABLES].reverse()) {
    await newDb.query(`DELETE FROM "${t.name}"`);
  }
  console.log("New DB cleared.");

  // Copy each table via row_to_json → json_populate_recordset so Postgres
  // handles every column type (timestamps, jsonb, text[], bytea) itself.
  for (const t of TABLES) {
    const orderCols = t.keys.map((k) => `"${k}"`).join(", ");
    let copied = 0;
    let last = null;
    for (;;) {
      const params = [];
      let where = "";
      if (last) {
        where = `WHERE (${orderCols}) > (${t.keys.map((_, i) => `$${i + 1}`).join(", ")})`;
        params.push(...last);
      }
      const rows = await oldDb.query(
        `SELECT row_to_json(t.*) AS r FROM "${t.name}" t ${where} ORDER BY ${orderCols} LIMIT ${BATCH}`,
        params,
      );
      if (!rows.rows.length) break;
      await newDb.query(
        `INSERT INTO "${t.name}" SELECT * FROM json_populate_recordset(NULL::"${t.name}", $1::json)`,
        [JSON.stringify(rows.rows.map((x) => x.r))],
      );
      copied += rows.rows.length;
      const lastRow = rows.rows[rows.rows.length - 1].r;
      last = t.keys.map((k) => lastRow[k]);
      if (rows.rows.length < BATCH) break;
    }
    console.log(`${t.name}: ${copied} row(s) copied`);
  }

  const check = await newDb.query(
    'SELECT (SELECT COUNT(*)::int FROM "User") AS users, (SELECT COUNT(*)::int FROM "Project") AS projects, (SELECT COUNT(*)::int FROM "Product") AS products',
  );
  console.log("DONE. New DB now has:", JSON.stringify(check.rows[0]));
  await oldDb.end();
  await newDb.end();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
