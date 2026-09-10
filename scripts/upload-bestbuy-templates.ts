/**
 * Bulk-load Best Buy's real category templates as ADMIN (global) templates.
 *
 * Best Buy issues 22 group templates that between them cover all 1,450 leaf
 * categories — verified: 1,449 exact matches against the Mirakl taxonomy, the
 * 1 apparent miss being "Prepared/Preserved Foods", whose own name contains the
 * separator. Uploading 22 files by hand through the UI is the kind of chore a
 * script should do once.
 *
 * The workbook is stored BYTE-FOR-BYTE UNCHANGED in fileData and used as the
 * base workbook at export time, exactly like every other template: the export
 * writes product rows into the Data sheet and leaves the ReferenceData sheet,
 * the Columns requirement matrix, dropdowns, widths and styling untouched. What
 * the client downloads is Best Buy's own file with their data in it.
 *
 * Idempotent: a template already present (same marketplace + name) is UPDATED
 * in place, so re-running after Best Buy revises a template refreshes it
 * without creating duplicates.
 *
 * Run:  npx tsx -r dotenv/config scripts/upload-bestbuy-templates.ts
 *       npx tsx -r dotenv/config scripts/upload-bestbuy-templates.ts --dry-run
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import JSZip from "jszip";
import { prisma } from "../src/lib/db";

const DIR = process.env.BESTBUY_TEMPLATE_DIR ?? "Best buy templates";
const MARKETPLACE = "bestbuy";
const DRY = process.argv.includes("--dry-run");

/** Read one sheet's first N rows as a string grid. */
async function readSheetRows(buf: Buffer, sheetName: string, maxRows: number): Promise<string[][]> {
  const z = await JSZip.loadAsync(buf);
  const wb = await z.file("xl/workbook.xml")!.async("string");
  const rels = await z.file("xl/_rels/workbook.xml.rels")!.async("string");
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
    .map((m) => ({ name: m[1]!, rid: m[2]! }));
  const target = sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase());
  if (!target) return [];
  const rel = new RegExp(`Id="${target.rid}"[^>]*Target="([^"]+)"`).exec(rels);
  if (!rel) return [];
  const xml = await z.file("xl/" + rel[1]!.replace(/^\/?xl\//, ""))!.async("string");
  const ss = (await z.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const strings = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((t) => t[1]!)
      .join("")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );

  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    // Handles both <c ...>…</c> and self-closing <c … /> (blank cells) — missing
    // the self-closing form silently shifts every column after a gap.
    for (const cm of rm[1]!.matchAll(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g)) {
      const chunk = cm[0];
      const type = /\st="(\w+)"/.exec(chunk)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(chunk)?.[1];
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(chunk)?.[1];
      cells.push(inline ?? (type === "s" && v ? strings[Number(v)] ?? "" : v ?? ""));
    }
    rows.push(cells);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

/** A readable template name from the file name, preserving what it covers. */
function templateName(file: string): string {
  return file
    .replace(/\.xlsx$/i, "")
    .replace(/^best\s*buy\s*templates?\s*[-–—]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim() || file.replace(/\.xlsx$/i, "");
}

(async () => {
  if (!existsSync(DIR)) throw new Error(`Template folder not found: ${DIR}`);
  const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".xlsx") && !f.startsWith("~$"));
  if (!files.length) throw new Error(`No .xlsx files in ${DIR}`);
  console.log(`${files.length} template file(s) in "${DIR}"${DRY ? "  (DRY RUN)" : ""}\n`);

  let created = 0, updated = 0, totalBytes = 0, totalCats = 0;

  for (const file of files) {
    const buf = readFileSync(join(DIR, file));
    // Data sheet: row 1 = human labels, row 2 = Mirakl attribute codes.
    const data = await readSheetRows(buf, "Data", 2);
    const labels = data[0] ?? [];
    const codes = data[1] ?? [];
    // Columns sheet row 1: Code | Label | Description | Value example | <category paths…>
    const colsHeader = (await readSheetRows(buf, "Columns", 1))[0] ?? [];
    const categoryCount = colsHeader.slice(4).filter(Boolean).length;

    if (!labels.length || !codes.length) {
      console.warn(`  SKIP ${file} — no Data sheet header rows found`);
      continue;
    }

    // Same shape the UI upload stores: [{ key, label }]. `key` is the Mirakl
    // attribute code, which is what the importer matches on.
    const columns = labels.map((label, i) => ({
      key: (codes[i] ?? label ?? "").trim(),
      label: (label ?? "").trim(),
    })).filter((c) => c.key || c.label);

    const name = templateName(file);
    totalBytes += buf.length;
    totalCats += categoryCount;

    console.log(
      `  ${name.slice(0, 46).padEnd(46)} ${String(Math.round(buf.length / 1024)).padStart(5)} KB  ` +
      `${String(columns.length).padStart(5)} cols  ${String(categoryCount).padStart(4)} categories`,
    );
    if (DRY) continue;

    // userId null = admin/global template, visible to every user.
    const existing = await prisma.exportTemplate.findFirst({
      where: { marketplace: MARKETPLACE, name },
      select: { id: true },
    });
    const payload = {
      name,
      marketplace: MARKETPLACE,
      category: null,
      fileFormat: "xlsx",
      columns,
      fileData: buf,
      userId: null,
    };
    if (existing) {
      await prisma.exportTemplate.update({ where: { id: existing.id }, data: payload });
      updated++;
    } else {
      await prisma.exportTemplate.create({ data: payload });
      created++;
    }
  }

  console.log(
    `\n${DRY ? "would load" : "loaded"}: ${created} created, ${updated} updated  |  ` +
    `${(totalBytes / 1024 / 1024).toFixed(1)} MB  |  ${totalCats} category columns total`,
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FATAL", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
