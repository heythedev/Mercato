/**
 * Repair the stored column definitions on the Best Buy templates.
 *
 * The 22 templates were loaded through the admin UI, whose XLSX reader picks a
 * single header row and caps it at 1,024 columns. Both behaviours are wrong for
 * Best Buy's files: they carry TWO header rows — row 1 human labels, row 2 the
 * Mirakl attribute codes — and up to 4,108 columns. The result was every column
 * keyed by its label and everything past column 1,024 dropped, so the exporter
 * could not map "Floor_Tiles.productWidth" to a product field and left required
 * cells empty.
 *
 * Only `columns` is rewritten. `fileData` is already the untouched workbook and
 * re-sending 39 MB through the pooler to change nothing would be a needless
 * risk.
 *
 * Idempotent. Run:
 *   npx tsx -r dotenv/config scripts/fix-bestbuy-template-columns.ts [--dry-run]
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import JSZip from "jszip";
import { prisma } from "../src/lib/db";

const DIR = process.env.BESTBUY_TEMPLATE_DIR ?? "Best buy templates";
const DRY = process.argv.includes("--dry-run");

/** Template names differ in punctuation and spacing between file and DB. */
const norm = (s: string) => s.toLowerCase().replace(/\.xlsx$/i, "").replace(/[^a-z0-9]+/g, "");

/**
 * Same letters, any order. One file is named "...musical isntruments" while the
 * template it was uploaded as says "instruments", and a transposed pair is the
 * one typo punctuation-stripping cannot bridge. Only ever used as a fallback,
 * and only when it picks out exactly one unused file.
 */
const anagram = (s: string) => norm(s).split("").sort().join("");

async function readDataHeaderRows(buf: Buffer): Promise<{ labels: string[]; codes: string[] }> {
  const z = await JSZip.loadAsync(buf);
  const wb = await z.file("xl/workbook.xml")!.async("string");
  const rels = await z.file("xl/_rels/workbook.xml.rels")!.async("string");
  const sheet = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
    .map((m) => ({ name: m[1]!, rid: m[2]! }))
    .find((s) => s.name.toLowerCase() === "data");
  if (!sheet) return { labels: [], codes: [] };
  const rel = new RegExp(`Id="${sheet.rid}"[^>]*Target="([^"]+)"`).exec(rels);
  if (!rel) return { labels: [], codes: [] };
  const xml = await z.file("xl/" + rel[1]!.replace(/^\/?xl\//, ""))!.async("string");
  const ss = (await z.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const strings = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]!).join("")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );
  // Self-closing <c … /> marks a blank cell; missing it shifts every later column.
  const cellsOf = (rowXml: string) =>
    [...rowXml.matchAll(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g)].map((cm) => {
      const chunk = cm[0];
      const type = /\st="(\w+)"/.exec(chunk)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(chunk)?.[1];
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(chunk)?.[1];
      return inline ?? (type === "s" && v ? strings[Number(v)] ?? "" : v ?? "");
    });
  const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 2);
  return { labels: rows[0] ? cellsOf(rows[0][1]!) : [], codes: rows[1] ? cellsOf(rows[1][1]!) : [] };
}

(async () => {
  if (!existsSync(DIR)) throw new Error(`Template folder not found: ${DIR}`);
  const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".xlsx") && !f.startsWith("~$"));
  const byName = new Map(files.map((f) => [norm(f), f]));
  const byAnagram = new Map<string, string[]>();
  for (const f of files) {
    const k = anagram(f);
    byAnagram.set(k, [...(byAnagram.get(k) ?? []), f]);
  }
  const used = new Set<string>();

  const rows = await prisma.exportTemplate.findMany({
    where: { marketplace: "bestbuy" },
    select: { id: true, name: true, columns: true },
  });
  console.log(`${rows.length} bestbuy template(s) in the database, ${files.length} file(s) on disk${DRY ? "  (DRY RUN)" : ""}\n`);

  let fixed = 0, unmatched = 0;
  for (const row of rows) {
    let file = byName.get(norm(row.name));
    if (!file) {
      const near = (byAnagram.get(anagram(row.name)) ?? []).filter((f) => !used.has(f));
      if (near.length === 1) {
        file = near[0];
        console.log(`  (matched "${row.name}" to "${file}" on transposed letters)`);
      }
    }
    if (!file) {
      console.warn(`  NO FILE for "${row.name}"`);
      unmatched++;
      continue;
    }
    const { labels, codes } = await readDataHeaderRows(readFileSync(join(DIR, file)));
    if (!labels.length || !codes.length) {
      console.warn(`  SKIP "${row.name}" — no Data header rows`);
      unmatched++;
      continue;
    }
    const columns = labels
      .map((label, i) => ({ key: (codes[i] ?? label ?? "").trim(), label: (label ?? "").trim() }))
      .filter((c) => c.key || c.label);
    used.add(file);
    const before = Array.isArray(row.columns) ? row.columns.length : 0;
    if (!DRY) await prisma.exportTemplate.update({ where: { id: row.id }, data: { columns } });
    console.log(`  ${row.name.slice(0, 44).padEnd(44)} ${String(before).padStart(5)} -> ${String(columns.length).padStart(5)} cols   key0=${columns[0]?.key}`);
    fixed++;
  }
  console.log(`\n${fixed} repaired, ${unmatched} unmatched`);
  await prisma.$disconnect();
})();
