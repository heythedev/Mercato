/**
 * Pull Best Buy's REAL category tree from Mirakl (H11) and write it to
 * src/lib/ai/data/bestbuy_categories.csv, replacing the hand-made 230-row
 * approximation that was capping categorization accuracy.
 *
 * Run: npx tsx -r dotenv/config scripts/fetch-bestbuy-taxonomy.ts
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { getHierarchies, hierarchiesToLeafPaths, miraklConfigured } from "../src/lib/bestbuy/mirakl-client";

(async () => {
  if (!miraklConfigured()) throw new Error("BESTBUY_MIRAKL_URL / BESTBUY_MIRAKL_KEY not set");

  const nodes = await getHierarchies();
  const leaves = hierarchiesToLeafPaths(nodes);
  const byLevel = nodes.reduce<Record<number, number>>((a, n) => ((a[n.level] = (a[n.level] ?? 0) + 1), a), {});
  console.log(`fetched ${nodes.length} nodes  levels=${JSON.stringify(byLevel)}  leaves=${leaves.length}`);

  const depth = leaves.reduce<Record<number, number>>((a, l) => {
    const d = l.path.split(" > ").length;
    a[d] = (a[d] ?? 0) + 1;
    return a;
  }, {});
  console.log("leaf path depth distribution:", JSON.stringify(depth));

  // CSV: one row per leaf. Code is kept because Mirakl's product import and the
  // attribute lookup both key on it, not on the human label.
  const esc = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = ["Category,Subcategory,Sub-Subcategory,Sub-Sub-Subcategory,Code"];
  for (const { code, path } of leaves.sort((a, b) => a.path.localeCompare(b.path))) {
    const p = path.split(" > ");
    rows.push([p[0] ?? "", p[1] ?? "", p[2] ?? "", p[3] ?? "", code].map(esc).join(","));
  }
  const out = join(process.cwd(), "src/lib/ai/data/bestbuy_categories.csv");
  writeFileSync(out, rows.join("\n") + "\n", "utf8");
  console.log(`wrote ${rows.length - 1} leaf categories -> ${out}`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
