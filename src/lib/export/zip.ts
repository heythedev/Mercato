import JSZip from "jszip";
import type { Product as PrismaProduct, ExportTemplate } from "@prisma/client";

/**
 * The product shape the export actually needs.
 *
 * Deliberately narrower than Prisma's `Product`: the export route selects only
 * these columns, because loading every column (notably `liveData`, Walmart's
 * full listing payload at ~13KB each) cost 87MB and ~68s on a 7k project before
 * any rows were written. Typing against the real requirement keeps that select
 * honest — adding a field here is a compile error until the route selects it.
 */
type Product = Pick<
  PrismaProduct,
  | "id"
  | "name"
  | "vendorSku"
  | "upc"
  | "asin"
  | "brand"
  | "price"
  | "description"
  | "imageUrl"
  | "marketplaceCategory"
  | "categoryPath"
  | "specProductType"
  | "verifyStatus"
  | "vendorData"
  | "liveData"
>;
import { loadMathisCategoryPaths } from "../ai/mathis-taxonomy";
import { matchDropdownValues, dropdownKey, type DropdownQuery } from "../ai/match-dropdown";
import { exportGroupOf } from "./category-group";
import { applyWayfairEligibility } from "./wayfair-eligibility";
import { ASIN_RE } from "../barcode";
import { readXlsxGrid } from "../vendor/xlsx-lite";

type Column = { key: string; label: string; required?: boolean };

export type TemplateRow = {
  id: string;
  name: string;
  category?: string | null;
  fileFormat: string;
  columns: unknown;
  fileData?: Buffer | null; // included when caller wants formatting/dropdowns preserved
};

// ── Flat export (non-Mathis marketplaces, no templates required) ─────────────
// Exports all products as a single Excel file with standard enriched columns.
// Used for Amazon, Walmart, Best Buy, Temu, Sears — where templates are optional.

const FLAT_COLUMNS: Column[] = [
  { key: "item_sku",             label: "Item SKU" },
  { key: "upc",                  label: "UPC" },
  { key: "asin",                 label: "ASIN" },
  { key: "name",                 label: "Product Name" },
  { key: "brand",                label: "Brand" },
  { key: "price",                label: "Price" },
  { key: "standard_price",       label: "Standard Price" },
  { key: "quantity",             label: "Quantity" },
  { key: "condition",            label: "Condition" },
  { key: "description",          label: "Description" },
  { key: "main_image_url",       label: "Main Image URL" },
  { key: "product_image_2_url",  label: "Image 2 URL" },
  { key: "product_image_3_url",  label: "Image 3 URL" },
  { key: "category",             label: "Category" },
  { key: "category_path",        label: "Category Path" },
  { key: "country_of_origin",    label: "Country of Origin" },
  { key: "item_weight",          label: "Item Weight" },
  { key: "item_length",          label: "Item Length" },
  { key: "item_width",           label: "Item Width" },
  { key: "item_height",          label: "Item Height" },
  { key: "color",                label: "Color" },
  { key: "size",                 label: "Size" },
  { key: "material",             label: "Material" },
  { key: "keywords",             label: "Keywords" },
];

export async function generateFlatExport(
  products: Product[],
  marketplace: string,
): Promise<Buffer> {
  const eligible = eligibleProducts(products, marketplace);
  const zip = new JSZip();
  const safeName = sanitize(marketplace || "export");
  const buffer = await createXlsxFromScratch(eligible, FLAT_COLUMNS, "Products");
  zip.file(`${safeName}_export.xlsx`, buffer);
  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

// ── Category-split export without templates (Temu) ───────────────────────────
// Groups products by their AI-assigned marketplaceCategory and creates one
// Excel file per category using standard flat columns. No templates needed.

export async function generateFlatCategoryZip(
  products: Product[],
  marketplace: string,
): Promise<Buffer> {
  const zip = new JSZip();
  const eligible = eligibleProducts(products, marketplace);

  const groups = new Map<string, Product[]>();
  for (const p of eligible) {
    const cat = p.marketplaceCategory;
    if (!cat || cat === "Uncategorized") continue;
    // Mathis groups by department; other marketplaces by full category path.
    const group = exportGroupOf(cat, marketplace);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(p);
  }

  // Fall back to single flat file if nothing was categorized
  if (groups.size === 0) {
    const buffer = await createXlsxFromScratch(eligible, FLAT_COLUMNS, "Products");
    zip.file(`${sanitize(marketplace)}_export.xlsx`, buffer);
    return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
  }

  for (const [category, categoryProducts] of groups) {
    await new Promise<void>((r) => setImmediate(r));
    const fileName = sanitize(category);
    const buffer = await createXlsxFromScratch(categoryProducts, FLAT_COLUMNS, category);
    zip.file(`${fileName}.xlsx`, buffer);
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

// ── Category-split export (primary mode) ─────────────────────────────────────
// Each category is auto-matched to the closest template by name similarity.
// The defaultTemplateId is used as the fallback when no close match is found.

export async function generateCategoryZip(
  products: Product[],
  templates: TemplateRow[],
  marketplace = "amazon",
  defaultTemplateId?: string,
): Promise<{ zip: Buffer; missingTemplateCategories: string[] }> {
  console.log(`[export] generateCategoryZip called: ${products.length} products, ${templates.length} templates, marketplace=${marketplace}`);
  const zipOut = new JSZip();
  // Fallback priority:
  //   1) explicitly selected template
  //   2) template whose name contains "other(s)/general/default" AND has fileData
  //   3) template with the MOST COLUMNS that also has fileData (most fields = most general)
  //   4) any template with fileData
  //   5) first template
  const isGenericTemplate = (t: TemplateRow) =>
    /\bother(s)?\b|\bgeneral\b|\bdefault\b/i.test(t.name) && !!t.fileData;
  const withFile = templates.filter((t) => t.fileData);
  const mostColumns = withFile.length
    ? withFile.reduce((a, b) =>
        (b.columns as Column[]).length > (a.columns as Column[]).length ? b : a)
    : null;
  const fallback = templates.find((t) => t.id === defaultTemplateId)
    ?? templates.find(isGenericTemplate)
    ?? mostColumns
    ?? templates[0];
  console.log(`[export] fallback template: "${fallback?.name}" (cols=${Array.isArray(fallback?.columns) ? (fallback.columns as Column[]).length : "?"})`);

  const eligible = eligibleProducts(products, marketplace);

  // ── Pass 1: group products by category key (no template assignment yet) ──────
  // For Mathis the group is the DEPARTMENT (first path segment), so every subcategory
  // under "Baby & Kids > …" lands in one "Baby & Kids" file rather than one file per
  // leaf. Other marketplaces continue to group on the full category path.
  const grouped = new Map<string, { catLabel: string; isUncategorized: boolean; catProducts: Product[] }>();
  for (const p of eligible) {
    const cat = p.marketplaceCategory;
    const isUncategorized = !cat || cat === "Uncategorized";
    const group = isUncategorized ? "" : exportGroupOf(cat!, marketplace);
    const catKey = isUncategorized ? `__uncategorized__` : group;
    if (!grouped.has(catKey)) grouped.set(catKey, { catLabel: group, isUncategorized, catProducts: [] });
    grouped.get(catKey)!.catProducts.push(p);
  }

  // ── Extract category lists from template XLSX files ──────────────────────────
  // Temu templates ship with a category-scope sheet (and/or sample data) that
  // lists the exact Temu taxonomy paths each template covers. Build a map of
  // templateId → Set<lowerCasedCategoryPath> for use in Pass 2 matching.
  //
  // When a template has no embedded category list, the template NAME is used as
  // a category path (Temu template names ARE paths: "Home & Kitchen / Furniture /
  // Chairs"). This means auto-assignment works for all templates, not just those
  // that happen to have an embedded category sheet.
  const isTemu = marketplace.toLowerCase() === "temu";
  const tmplCats = new Map<string, Set<string>>();
  const normSepGlobal = (s: string) => s.replace(/ \/ /g, " > ");
  if (isTemu) {
    await Promise.all(templates.map(async (t) => {
      let cats: string[] = [];
      if (t.fileData) {
        cats = await extractTemuTemplateCategories(t.fileData as Buffer);
      }
      if (cats.length) {
        tmplCats.set(t.id, new Set(cats.map(c => c.toLowerCase())));
        console.log(`[export] Template "${t.name}" lists ${cats.length} embedded category paths`);
      } else {
        // Derive coverage from template name — Temu template names are category paths
        // (e.g. "Home & Kitchen / Furniture / Chairs"). Strip trailing numbers/codes.
        const nameAsPath = normSepGlobal(t.name).replace(/\s*\(\d+\)\s*$/, "").trim();
        if (nameAsPath.includes(" > ")) {
          tmplCats.set(t.id, new Set([nameAsPath.toLowerCase()]));
          console.log(`[export] Template "${t.name}" — derived path from name: "${nameAsPath}"`);
        }
      }
    }));
  }

  // ── Pass 2: assign best template to each group ────────────────────────────────
  // Priority order:
  //   1) Exact category-path match from template's embedded category sheet (Temu only)
  //   2) Name/category word-overlap (findBestTemplate)
  //   3) Column-overlap — only when no OTHER/GENERAL catch-all template exists
  //
  // For Temu: if the only available match is the catch-all "OTHER" template,
  // the category is flagged as needing a dedicated template and excluded from
  // the export — it should NOT be lumped into the generic catch-all file.
  const hasCatchAll = isGenericTemplate(fallback);
  const missingTemplateCategories: string[] = [];
  const byCategory = new Map<string, { template: TemplateRow; catLabel: string; products: Product[] }>();
  for (const [catKey, { catLabel, isUncategorized, catProducts }] of grouped.entries()) {
    let tpl: TemplateRow;
    if (isUncategorized) {
      tpl = fallback;
    } else {
      // 1) Category-path match against each template's coverage list.
      //    Coverage comes from embedded category sheets OR (for most templates)
      //    parsed from the template name itself.
      //    Matching rules:
      //      a) Exact: template path == product category
      //      b) Template is parent: product cat starts with template path + " > "
      //         ("Kitchen & Dining > Dinnerware" covers "Kitchen & Dining > Dinnerware > Placemats")
      //      c) Product is parent: template path starts with product cat + " > "
      //         (product "Kitchen & Dining" matches template "Kitchen & Dining > Dinnerware > Placemats")
      //    When multiple templates match, prefer the most specific (most path segments).
      const lowerCat = normSepGlobal(catLabel).toLowerCase();
      const isSegmentPrefix = (prefix: string, full: string) =>
        full === prefix || full.startsWith(prefix + " > ");

      let bestPathMatch: TemplateRow | undefined;
      let bestMatchDepth = -1;
      if (tmplCats.size > 0) {
        for (const t of templates) {
          const cats = tmplCats.get(t.id);
          if (!cats) continue;
          for (const c of cats) {
            const nc = normSepGlobal(c).toLowerCase();
            if (isSegmentPrefix(nc, lowerCat) || isSegmentPrefix(lowerCat, nc)) {
              const depth = nc.split(" > ").length;
              if (depth > bestMatchDepth) {
                bestMatchDepth = depth;
                bestPathMatch = t;
              }
            }
          }
        }
      }

      if (bestPathMatch) {
        tpl = bestPathMatch;
        console.log(`[export] Path match (depth=${bestMatchDepth}): "${tpl.name}" for "${catLabel}"`);
      } else if (isTemu && tmplCats.size > 0) {
        // Templates have coverage paths but none matched this category.
        // Rather than assigning a wrong template via word-overlap, mark it missing
        // so the user knows to upload a dedicated template for this category.
        missingTemplateCategories.push(catLabel);
        console.log(`[export] No matching template for "${catLabel}" — flagged as missing`);
        continue;
      } else {
        // 2) Name/word-overlap (non-Temu, or Temu templates without any path data).
        // minScore=4 guards against false matches from a single shared word
        // (e.g. "office" scoring "Office Supplies File Cabinets" for "Office Furniture").
        // When no template reaches the threshold, findBestTemplate returns fallback
        // so the column-overlap pass below can make a better choice.
        tpl = findBestTemplate(catLabel, templates, fallback, 4);
        // 3) Column overlap — only when no designated catch-all exists
        if (tpl === fallback && templates.length > 1 && !hasCatchAll) {
          tpl = bestByColumnOverlap(catProducts, templates, fallback);
        }
      }

      // For Temu: if the best we found is the generic catch-all, exclude this
      // category and tell the user they need a dedicated template for it.
      if (isTemu && hasCatchAll && tpl === fallback) {
        missingTemplateCategories.push(catLabel);
        console.log(`[export] No specific template for "${catLabel}" — excluded, needs a dedicated template`);
        continue;
      }
    }
    console.log(`[export] Group "${catLabel || "(uncategorized)"}" → template "${tpl.name}"`);
    byCategory.set(catKey, { template: tpl, catLabel: isUncategorized ? "" : catLabel, products: catProducts });
  }

  for (const [catKey, { template, catLabel, products: catProducts }] of byCategory.entries()) {
    await new Promise<void>((r) => setImmediate(r)); // yield so HTTP polls can be served

    const columns = template.columns as Column[];
    // Name the file after the category (e.g. "Baby & Kids.xlsx"), falling back to
    // the template name for uncategorized products.
    const fileName = catKey === "__uncategorized__" ? sanitize(template.name) : sanitize(catLabel);

    if (template.fileFormat === "csv") {
      zipOut.file(`${fileName}.csv`, generateCsv(catProducts, columns));
    } else if (template.fileData) {
      console.log(`[export] Filling template "${template.name}" (${marketplace}) fileData size=${Buffer.byteLength(template.fileData as Buffer)}`);
      const buffer = await fillTemplateXlsx(catProducts, columns, template.fileData as Buffer, marketplace);
      zipOut.file(`${fileName}.xlsx`, buffer);
    } else {
      console.warn(`[export] Template "${template.name}" (${marketplace}) has NO fileData — plain workbook will be generated. Re-upload the template file to fix this.`);
      const buffer = await createXlsxFromScratch(catProducts, columns, catLabel || template.name);
      zipOut.file(`${fileName}.xlsx`, buffer);
    }
  }

  const zipBuffer = await (zipOut.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>);
  return { zip: zipBuffer, missingTemplateCategories };
}

// Pick the best-matching template for a category using word-overlap scoring.
// Falls back to the provided default when no template scores above zero.
//
// For taxonomy paths like "Furniture > Living Room > Sofas", the department
// (first segment) is the primary signal — matching export templates by leaf
// words (e.g. "Kitchen" inside "Organization > Kitchen > …") caused wrong files.
export function findBestTemplate<T extends { id: string; name: string; category?: string | null }>(
  category: string,
  templates: T[],
  fallback: T,
  minScore = 0,
): T {
  if (templates.length <= 1) return fallback;

  // Fold accents so "Décor" ↔ "Decor", then strip to alphanumerics.
  // Also normalise " / " → " > " so Temu template names ("Home & Kitchen / Furniture / Chairs")
  // score against our arrow-format categories ("Furniture > Dining Room > Chairs") correctly.
  const fold = (s: string) =>
    s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const norm = (s: string) => fold(s.replace(/ \/ /g, " > ")).replace(/[^a-z0-9]+/g, " ").trim();

  // Prefer matching on the department (level-1) of a "A > B > C" path.
  const department = category.split(/\s*>\s*/)[0]?.trim() || category;
  const normDept = norm(department);
  const normCat = norm(category);
  // Deduplicate catWords so a word appearing multiple times in the path (e.g.
  // "office" in "Office > Office Furniture > Ergonomic Office Chairs") only
  // counts once — otherwise the repeated word inflates the score and causes
  // false matches to templates that merely share the department name.
  const catWords = [...new Set(normCat.split(" ").filter((w) => w.length > 2))];

  // Score one candidate string against the product category path.
  const scoreTarget = (raw: string): number => {
    const target = norm(raw);
    const bareName = target.replace(/\s+\d+$/, "").trim();
    const targetWords = target.split(" ").filter((w) => w.length > 2);
    let sc = 0;
    if (target === normDept || bareName === normDept) sc += 20;
    // Give +12 prefix bonus only when the department is multi-word or long (≥ 9 chars).
    // A single short word like "office" or "audio" (6 chars) would match the
    // beginning of any template whose name starts with that word — e.g. "Office
    // Supplies File Cabinets" for "Office > Office Furniture > Ergonomic Office Chairs"
    // — which is a false match. Require more specificity before giving +12.
    else if (normDept.startsWith(target) || (target.startsWith(normDept) && (normDept.includes(" ") || normDept.length >= 9))) sc += 12;
    else if (
      (target.length >= 5 && normDept.startsWith(target.slice(0, 5))) ||
      (normDept.length >= 5 && target.startsWith(normDept.slice(0, 5)))
    ) sc += 10;
    for (const word of catWords) if (targetWords.includes(word)) sc += 2;
    for (const word of targetWords) if (catWords.includes(word)) sc += 1;
    if (target.includes(normCat)) sc += 5;
    if (normCat.includes(target)) sc += 3;
    if (target === normCat) sc += 10;
    return sc;
  };

  let best = fallback;
  let bestScore = 0;

  for (const t of templates) {
    // Score against BOTH the template name AND its category field — take the higher.
    // A template may have a descriptive name ("Home & Kitchen / Furniture / Dining Room
    // Furniture / Chairs") but a short internal category label ("TEMU CHAIRS (1)").
    // Using only `category || name` caused the category label to win and the descriptive
    // name to be ignored, resulting in a zero score and false "no match" warnings.
    const score = Math.max(
      scoreTarget(t.name),
      t.category ? scoreTarget(t.category) : 0,
    );
    if (score > bestScore) { bestScore = score; best = t; }
  }

  // If nothing scored above the caller's minimum, the "best" is still too weak
  // to be trusted — return the fallback so column-based matching can take over.
  if (bestScore < minScore) return fallback;
  return best;
}

// Secondary template picker: when name-overlap gives no match, score templates by
// how many of their column keys/labels appear in the products' vendorData keys.
// The template whose columns best cover what the products actually have = nearest match.
function bestByColumnOverlap(
  products: Product[],
  templates: TemplateRow[],
  fallback: TemplateRow,
): TemplateRow {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Collect every vendorData key across all products in this group
  const productKeys = new Set<string>();
  for (const p of products) {
    const vd = p.vendorData as Record<string, unknown> | null;
    if (vd) for (const k of Object.keys(vd)) productKeys.add(norm(k));
  }
  if (productKeys.size === 0) return fallback;

  // Build column→frequency map so common columns count less, unique columns count more
  const colFreq = new Map<string, number>();
  for (const t of templates) {
    const seen = new Set<string>();
    for (const col of (t.columns as Column[] | null) ?? []) {
      for (const ck of [norm(col.key ?? ""), norm(col.label ?? "")]) {
        if (ck && !seen.has(ck)) { seen.add(ck); colFreq.set(ck, (colFreq.get(ck) ?? 0) + 1); }
      }
    }
  }
  const total = templates.length;

  let best = fallback;
  let bestScore = 0; // must beat 0 — ties leave fallback in place

  for (const t of templates) {
    const cols = t.columns as Column[];
    if (!Array.isArray(cols)) continue;
    let score = 0;
    for (const col of cols) {
      for (const ck of [norm(col.key ?? ""), norm(col.label ?? "")]) {
        if (ck && productKeys.has(ck)) {
          // IDF-style: columns unique to fewer templates carry more weight
          const freq = colFreq.get(ck) ?? 1;
          score += (total - freq + 1) / total;
        }
      }
    }
    // fileData bonus so formatted templates are preferred when scores tie
    const adjusted = score + (t.fileData ? 0.01 : 0);
    if (adjusted > bestScore) { bestScore = adjusted; best = t; }
  }

  if (best !== fallback) {
    console.log(`[export] Column-overlap match: "${best.name}" (productKeys=${productKeys.size}, score=${bestScore.toFixed(2)})`);
  }
  return best;
}

// Scan a Temu XLSX template's shared strings for category paths listed in its
// category-scope / sample sheets (values like "Jewelry & Accessories > Hats & Caps").
// These are used for exact-path matching so each template is chosen based on the
// actual categories it covers, not just its file name.
async function extractTemuTemplateCategories(fileData: Buffer): Promise<string[]> {
  try {
    const tplZip = await JSZip.loadAsync(fileData);
    const ssFile = tplZip.files["xl/sharedStrings.xml"];
    if (!ssFile) return [];
    const ssXml = await ssFile.async("string");
    const found: string[] = [];
    // Each <si>…</si> is one shared string; pull all <t> text nodes inside it
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let siM: RegExpExecArray | null;
    while ((siM = siRe.exec(ssXml))) {
      let text = "";
      const tRe = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
      let tM: RegExpExecArray | null;
      while ((tM = tRe.exec(siM[1]))) text += tM[1];
      text = text.trim();
      // Temu template files use " / " as the path separator; normalize to " > " so
      // matching is consistent regardless of which separator the template uses.
      const normalised = text.replace(/ \/ /g, " > ");
      if (normalised.includes(" > ") && normalised.split(" > ").length >= 2 && text.length < 300) {
        found.push(normalised);
      }
    }
    return [...new Set(found)];
  } catch {
    return [];
  }
}

// ── Single-template export (non-Mathis marketplaces with user-selected template) ─
// Exports ALL products into one file using the chosen template's column definitions.
// Uses TemplateRow (no fileData blob) so it never calls fillTemplateXlsx or blocks the event loop.

export async function generateSingleTemplateExport(
  products: Product[],
  template: TemplateRow,
  marketplace: string,
  fileData?: Buffer | null,
): Promise<Buffer> {
  const zip = new JSZip();
  const eligible = eligibleProducts(products, marketplace);
  const columns = template.columns as Column[];
  const fileName = sanitize(template.name);

  // For Walmart item_match: if a product has no marketplaceCategory, fall back to
  // the template's own category so "Spec Product Type" is never left blank.
  const templateCategory = (template as { category?: string | null }).category ?? null;
  const withCategoryFallback = templateCategory && marketplace.toLowerCase() === "walmart"
    ? eligible.map(p => p.marketplaceCategory ? p : { ...p, marketplaceCategory: templateCategory })
    : eligible;

  if (template.fileFormat === "csv") {
    zip.file(`${fileName}.csv`, generateCsv(withCategoryFallback, columns));
  } else if (fileData) {
    // Preserve original template formatting, dropdowns, validations
    const buffer = await fillTemplateXlsx(withCategoryFallback, columns, fileData, marketplace);
    zip.file(`${fileName}.xlsx`, buffer);
  } else {
    const buffer = await createXlsxFromScratch(withCategoryFallback, columns, template.name);
    zip.file(`${fileName}.xlsx`, buffer);
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

// ── Legacy multi-template export (kept for backward compat) ──────────────────

export async function generateExportZip(
  products: Product[],
  templates: ExportTemplate[],
  marketplace = "amazon",
): Promise<Buffer> {
  const zip = new JSZip();
  const eligible = eligibleProducts(products, marketplace);

  for (const template of templates) {
    const columns = template.columns as Column[];
    const filtered = template.category
      ? eligible.filter((p) => p.marketplaceCategory === template.category)
      : eligible;

    const fileName = sanitize(template.name);
    const fileData = template.fileData ? (template.fileData as Buffer) : null;

    if (template.fileFormat === "csv") {
      zip.file(`${fileName}.csv`, generateCsv(filtered, columns));
    } else if (fileData) {
      const buffer = await fillTemplateXlsx(filtered, columns, fileData, marketplace);
      zip.file(`${fileName}.xlsx`, buffer);
    } else {
      const buffer = await createXlsxFromScratch(filtered, columns, template.name);
      zip.file(`${fileName}.xlsx`, buffer);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

function eligibleProducts(products: Product[], marketplace: string): Product[] {
  let base = products;
  const anyVerified = products.some((p) => p.verifyStatus != null);
  // Only exclude hard API errors — ok, warning, not_found, and un-verified (null) all export.
  if (anyVerified) base = base.filter((p) => p.verifyStatus !== "error");

  // Wayfair has extra pre-listing gates (category/shipping/brand-risk). Excluded
  // products are removed here; flagged-but-kept products stay in the export and are
  // surfaced separately via the review report (see applyWayfairEligibility / the
  // export route's Wayfair branch). See wayfair-eligibility.ts.
  if (marketplace.toLowerCase() === "wayfair") {
    base = applyWayfairEligibility(base).eligible;
  }

  return base;
}

// Fallback when the uploaded template can't be parsed. Produces a bare workbook
// with none of the template's styling, structure, or dropdown validations — so
// it always logs WHY, otherwise the degradation is invisible and surfaces later
// as "the downloaded file doesn't match the template I uploaded".
function bailToScratch(
  products: Product[],
  columns: Column[],
  marketplace: string,
  reason: string,
): Promise<Buffer> {
  console.warn(
    `[export] Template preservation failed${marketplace ? ` (${marketplace})` : ""}: ${reason}. ` +
    `Falling back to a generated workbook — original formatting and dropdowns will be lost.`,
  );
  return createXlsxFromScratch(products, columns, "Sheet1");
}

// ── Fill existing template file with product rows ─────────────────────────────
// Uses pure JSZip + XML string manipulation — no ExcelJS.
// Memory cost: ~3–5× template file size (vs ExcelJS at 50–200×, which OOMs on
// Render's 512MB free tier). All original formatting is preserved verbatim:
// styles, column widths, frozen panes, merged cells, dropdown validations,
// conditional formatting — nothing in the XML is touched except <sheetData> rows.

async function fillTemplateXlsx(
  products: Product[],
  columns: Column[],
  fileData: Buffer,
  marketplace = "",
): Promise<Buffer> {
  console.log(`[export] fillTemplateXlsx called: ${products.length} products, fileData=${fileData?.length ?? 0} bytes, marketplace=${marketplace}`);
  const tplZip = await JSZip.loadAsync(fileData);

  // ── Locate target worksheet ────────────────────────────────────────────────
  const relsXml = await tplZip.file("xl/_rels/workbook.xml.rels")?.async("string") ?? "";
  const rIdToTarget = new Map<string, string>();
  // Order-independent: extract Id= and Target= from each <Relationship> regardless of attribute order
  for (const m of relsXml.matchAll(/<Relationship\b([^>]+)/gi)) {
    const attrStr = m[1];
    const idM = attrStr.match(/\bId="([^"]+)"/i);
    const tgtM = attrStr.match(/\bTarget="([^"]+)"/i);
    if (idM && tgtM) {
      const t = tgtM[1];
      rIdToTarget.set(idM[1], t.startsWith("xl/") ? t : `xl/${t}`);
    }
  }
  const wbXml = await tplZip.file("xl/workbook.xml")?.async("string") ?? "";
  // Order-independent: extract name= and r:id= from each <sheet> regardless of attribute order
  const sheetDefs = [...wbXml.matchAll(/<sheet\b([^>]+)/gi)].map(m => ({
    name: m[1].match(/\bname="([^"]*)"/i)?.[1] ?? "",
    rId:  m[1].match(/\br:id="([^"]*)"/i)?.[1] ?? "",
  })).filter(sd => sd.name && sd.rId);

  // name→path map for resolving dropdown range references (=Lists!$A$1:$A$10)
  const sheetNameToPath = new Map<string, string>();
  for (const sd of sheetDefs) {
    const p = rIdToTarget.get(sd.rId);
    if (p) sheetNameToPath.set(sd.name.toLowerCase(), p);
  }

  // Defined names → the range they point at. Real marketplace templates (Mathis included)
  // name every dropdown's option list, so a dataValidation reads
  //   formula1 = Validation_<hash>_product_RUG_SHAPE
  // which only becomes a usable range via this map (→ ReferenceData!$R$2:$R$7).
  const definedNames = new Map<string, string>();
  for (const m of wbXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const nm = m[1].match(/\bname="([^"]+)"/i)?.[1];
    const target = xmlUnescape(m[2].trim());
    if (nm && target) definedNames.set(nm, target);
  }

  // Pick the target sheet using the same scoring logic as the template upload
  // (readXlsxGrid) so both agree on which sheet contains the product data.
  // Multi-sheet templates (e.g. Instructions + Data) would otherwise cause
  // fillTemplateXlsx to read from the wrong sheet → header mismatch → bailToScratch.
  let preferredSheetName: string | null = null;
  try {
    const gridResult = await readXlsxGrid(fileData, 5);
    preferredSheetName = gridResult.sheetName;
  } catch { /* ignore — fall back below */ }

  const targetDef =
    (preferredSheetName ? sheetDefs.find(s => s.name === preferredSheetName) : null)
    ?? sheetDefs.find(s => /^template$/i.test(s.name))
    ?? sheetDefs[0];
  const sheetPath = targetDef ? rIdToTarget.get(targetDef.rId) : null;
  if (!sheetPath || !tplZip.file(sheetPath)) {
    return bailToScratch(
      products, columns, marketplace,
      `no usable worksheet found (sheets: ${sheetDefs.map(s => s.name).join(", ") || "none"})`,
    );
  }
  let sheetXml = await tplZip.file(sheetPath)!.async("string");

  // ── Text-formatted styles ──────────────────────────────────────────────────
  // A cell whose style already carries a Text number format (built-in numFmtId
  // 49, or a custom "@" format) displays digits literally — no scientific
  // notation. For those cells a long numeric id can be written as a NUMBER and
  // still render exactly, which avoids Excel's "number stored as text" green
  // triangle that a shared-string (t="s") value would trigger. Collect the set
  // of such style (xf) indices so writeCell can decide per cell.
  const textFormatStyles = new Set<string>();
  {
    const stylesXml = await tplZip.file("xl/styles.xml")?.async("string") ?? "";
    // Custom numFmts that are text ("@") → collect their ids.
    const textNumFmtIds = new Set<string>(["49"]); // 49 = built-in Text
    for (const m of stylesXml.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) {
      if (/@/.test(m[2])) textNumFmtIds.add(m[1]);
    }
    const cellXfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
    let idx = 0;
    for (const xf of cellXfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
      const numFmtId = xf[0].match(/\bnumFmtId="(\d+)"/)?.[1];
      if (numFmtId && textNumFmtIds.has(numFmtId)) textFormatStyles.add(String(idx));
      idx++;
    }
  }

  // ── Shared strings ─────────────────────────────────────────────────────────
  // Keep original <si> XML elements verbatim so rich-text formatting (bold,
  // colored text, fonts) in template header cells is fully preserved.
  // New plain-text entries for product data are appended after the originals.
  const ssPath = "xl/sharedStrings.xml";
  const existingSsXml = await tplZip.file(ssPath)?.async("string") ?? "";
  const originalSiXmls: string[] = [];   // raw inner XML of each <si>, kept as-is
  const ssArr: string[] = [];            // plain-text equivalent (for header parsing & dropdown resolution)
  for (const m of existingSsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    originalSiXmls.push(m[1]);
    ssArr.push(extractSsText(m[1]));
  }
  const ssMap = new Map<string, number>(ssArr.map((s, i) => [s, i]));
  const newSiTexts: string[] = [];       // product-data values appended as plain text
  const ssIdx = (s: string): number => {
    let i = ssMap.get(s);
    if (i !== undefined) return i;
    i = originalSiXmls.length + newSiTexts.length;
    ssMap.set(s, i);
    newSiTexts.push(s);
    return i;
  };

  // ── Parse header row ───────────────────────────────────────────────────────
  const sdMatch = sheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sdMatch) return bailToScratch(products, columns, marketplace, "template sheet has no <sheetData> block");
  const rowMatches = [...sdMatch[1].matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)];

  // Read a row's cells as letter→label, resolving shared-string refs.
  //
  // IMPORTANT: XML attribute order is not guaranteed. The original regex captured
  // only the attributes that appear AFTER r="..." which missed t="s" when it
  // preceded r= (e.g. <c t="s" r="Q2" s="12">). In that case the shared-string
  // lookup was skipped and the cell returned its raw index number ("42") instead
  // of the resolved text ("Additional Information (Optional)"), causing banner
  // detection to silently fail. Capture the full attribute string instead.
  const readRowLabels = (rowXml: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const cm of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const [, allAttrs, content] = cm;
      const letter = allAttrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      if (!letter) continue;
      const vVal = content.match(/<v>(\d+)<\/v>/)?.[1] ?? "";
      const tVal = content.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      // Check t="s" in the FULL attribute string — not just what follows r=
      const label = /\bt="s"/.test(allAttrs) && vVal ? (ssArr[parseInt(vVal)] ?? "") : xmlUnescape(tVal || vVal);
      if (label) out.set(letter, label);
    }
    return out;
  };

  // ── Header row = the row that best MATCHES our stored column definitions ────
  // Picking "the row with the most cells" breaks on real marketplace templates
  // that carry several banner/section rows above the real header. Walmart's
  // "MP Item Setup by Match" is the case in point: row 2 holds section markers
  // (SKU / Required / Optional), row 4 holds display labels ("Product ID"),
  // and row 5 holds the field codes ("productId") that the upload path stores
  // as the template's columns. Scoring by cell count chose row 2 and matched
  // almost nothing, so products were written into the header block instead of
  // the data area. Score each candidate row by how many stored columns it
  // actually resolves, and fall back to cell count only when nothing matches.
  const wantedKeys = new Set<string>();
  for (const col of columns) {
    wantedKeys.add(normalizeKey(col.label));
    wantedKeys.add(normalizeKey(col.key));
  }

  let headerRowNum = 0;
  let headerRowXml = "";
  let colLetterToHeader = new Map<string, string>();
  let bestMatches = 0;
  let bestCount = 0;

  for (const rm of rowMatches) {
    const labels = readRowLabels(rm[0]);
    if (!labels.size) continue;
    let matches = 0;
    for (const label of labels.values()) {
      if (wantedKeys.has(normalizeKey(label))) matches++;
    }
    const count = labels.size;
    // Prefer more stored-column matches; break ties on the denser row.
    if (matches > bestMatches || (matches === bestMatches && matches > 0 && count > bestCount)) {
      bestMatches = matches;
      bestCount = count;
      headerRowNum = parseInt(rm[1]);
      headerRowXml = rm[0];
      colLetterToHeader = labels;
    }
  }

  // Nothing matched the stored columns — fall back to the old densest-row rule
  // so templates whose headers drifted still produce the previous behaviour
  // (and, if that also fails to match, bailToScratch below reports why).
  if (bestMatches === 0) {
    let maxLiteral = 0;
    for (const rm of rowMatches) {
      const count = (rm[0].match(/<c\b/g)?.length ?? 0) - (rm[0].match(/<f>/g)?.length ?? 0);
      if (count > maxLiteral) { maxLiteral = count; headerRowNum = parseInt(rm[1]); headerRowXml = rm[0]; }
    }
    colLetterToHeader = headerRowXml ? readRowLabels(headerRowXml) : new Map();
  }

  if (!headerRowXml) return bailToScratch(products, columns, marketplace, "could not identify a header row in the template");

  // ── Map template columns to our column definitions ─────────────────────────
  type ColEntry = { col: Column; letter: string };
  const colEntries: ColEntry[] = [];
  for (const col of columns) {
    for (const [letter, header] of colLetterToHeader) {
      if (normalizeKey(header) === normalizeKey(col.label) || normalizeKey(header) === normalizeKey(col.key)) {
        colEntries.push({ col, letter });
        break;
      }
    }
  }
  console.log(`[export] colEntries matched: ${colEntries.length}, headerRowNum=${headerRowNum}, colLetterToHeader size=${colLetterToHeader.size}`);
  if (colEntries.length === 0) {
    // The most common cause of a "downloaded file doesn't match my template" report:
    // the template's header labels don't normalize-match the stored column
    // definitions, so the original workbook (styles, dropdowns, structure) is
    // discarded. Log both sides so the mismatch is diagnosable from the template.
    return bailToScratch(
      products, columns, marketplace,
      `no template header matched the stored column definitions — ` +
      `template headers: [${[...colLetterToHeader.values()].join(" | ")}] ; ` +
      `expected columns: [${columns.map(c => c.label ?? c.key).join(" | ")}]`,
    );
  }

  // OOXML requires cells within a row to appear in left-to-right column order
  colEntries.sort((a, b) => {
    if (a.letter.length !== b.letter.length) return a.letter.length - b.letter.length;
    return a.letter.localeCompare(b.letter);
  });

  // Detect the new-listing template BEFORE any injection. The item_match template
  // does NOT carry "specProductType" as a field code, so this stays false for it,
  // keeping exportEntries narrowed to required columns only for item_match.
  const isNewListingTemplate = colEntries.some((e) => {
    const n = normalizeKey(String(e.col.key ?? ""));
    return n === "specproducttype";
  });

  // Walmart item_match: "Spec Product Type" (column A) appears in a banner header
  // row rather than the main field-code row, so the column-matching loop above
  // doesn't find it. Scan every row up to the main header row and inject it so it
  // is written per-product. alwaysExport keeps it in exportEntries even when the
  // required-band filter is active, so only mandatory fields are exported.
  if (marketplace.toLowerCase() === "walmart" && !isNewListingTemplate) {
    outer: for (const rm of rowMatches) {
      const rn = parseInt(rm[1]);
      if (rn > headerRowNum) break;
      const labels = readRowLabels(rm[0]);
      for (const [letter, label] of labels) {
        if (normalizeKey(label) === "specproducttype") {
          colEntries.push({ col: { key: "specproducttype", label }, letter });
          colLetterToHeader.set(letter, label);
          break outer;
        }
      }
    }
    // Re-sort in case column A was injected at the end
    colEntries.sort((a, b) => {
      if (a.letter.length !== b.letter.length) return a.letter.length - b.letter.length;
      return a.letter.localeCompare(b.letter);
    });
  }

  // ── Required-column detection ──────────────────────────────────────────────
  // Scan every banner row (any row above the header) for cells whose text
  // contains "required" or "optional". This works whether the template uses
  // actual <mergeCell> elements or just styling — we look at the cell values
  // directly, not at the merge map.
  //
  // Each "anchor" cell marks the START of a section; the section ends just
  // before the next anchor. Required sections contribute their columns to
  // requiredLetters; optional sections are left blank.
  const colNum = (letter: string): number =>
    [...letter.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

  const requiredLetters = new Set<string>();
  let sawRequiredBanner = false;

  type BannerSection = { colN: number; isRequired: boolean };

  // Find the FIRST row above the header that has any "required" or "optional"
  // banner text — that is the main section-divider row. Sub-section label rows
  // that come below it (row 3, row 4) may also contain words like
  // "Conditionally Required" but as part of individual field names; scanning
  // those rows would create spurious required-section anchors at optional columns
  // (e.g. "External Product ID Type" appears alongside "Conditionally Required"
  // in row 3, which was mistakenly adding column R to requiredLetters).
  let bannerRowXml: string | null = null;
  for (const rm of rowMatches) {
    const rn = parseInt(rm[1]);
    if (rn >= headerRowNum) break;
    const labels = readRowLabels(rm[0]);
    if ([...labels.values()].some(l => /\b(required|optional)\b/i.test(l))) {
      bannerRowXml = rm[0];
      break; // use only the first matching row
    }
  }
  const bannerSections: BannerSection[] = [];
  if (bannerRowXml) {
    for (const [letter, label] of readRowLabels(bannerRowXml)) {
      const hasRequired = /\brequired\b/i.test(label);
      const hasOptional = /\boptional\b/i.test(label);
      if (!hasRequired && !hasOptional) continue;
      bannerSections.push({ colN: colNum(letter), isRequired: hasRequired && !hasOptional });
    }
  }

  // Sort left→right.
  const uniqueBanners = bannerSections
    .sort((a, b) => a.colN - b.colN);

  for (let i = 0; i < uniqueBanners.length; i++) {
    const section = uniqueBanners[i];
    const nextSection = uniqueBanners[i + 1];
    const sectionEnd = nextSection ? nextSection.colN - 1 : Infinity;
    if (!section.isRequired) continue;
    sawRequiredBanner = true;
    for (const { letter } of colEntries) {
      const n = colNum(letter);
      if (n >= section.colN && n <= sectionEnd) requiredLetters.add(letter);
    }
  }

  // Anything to the LEFT of the first required section (e.g. Spec Product Type
  // in column A/D, or an SKU column that predates the banner) is also required.
  if (sawRequiredBanner && requiredLetters.size) {
    const firstRequired = Math.min(...[...requiredLetters].map(colNum));
    for (const { letter } of colEntries) {
      if (colNum(letter) < firstRequired) requiredLetters.add(letter);
    }
  }

  // Columns that must always export even when they fall in the "Optional" band.
  // Product Category is the whole point of the categorize step, so it is filled
  // even though Walmart's template files it under Optional.
  const isCategoryCol = (e: ColEntry): boolean => {
    const header = colLetterToHeader.get(e.letter) ?? "";
    return [e.col.key, e.col.label, header].some((s) => {
      const n = normalizeKey(String(s ?? ""));
      return n === "productcategory" || n === "category";
    });
  };
  const alwaysExport = (e: ColEntry): boolean =>
    isCategoryCol(e) || normalizeKey(String(e.col.key ?? "")) === "specproducttype";

  // Narrow the export to required-band columns when the banner was found.
  // sawRequiredBanner is true only for templates (e.g. item_match) that carry
  // "Required" / "Optional" section markers; new-listing templates have no such
  // banners so sawRequiredBanner stays false and all mapped columns are exported.
  // (Do NOT guard on isNewListingTemplate — "Spec Product Type" in the display-
  //  label row normalises to the same key and would incorrectly set it to true.)
  const exportEntries = sawRequiredBanner && requiredLetters.size
    ? colEntries.filter((e) => requiredLetters.has(e.letter) || alwaysExport(e))
    : colEntries;

  // ── Dropdown options from dataValidations ──────────────────────────────────
  // Parse ALL dataValidation blocks first, then filter to type="list".
  // The old regex required type= to precede sqref= in the attribute list —
  // OOXML doesn't guarantee attribute order so some templates were missed.
  const dropdowns = new Map<string, string[]>(); // column letter → options

  // Excel writes dropdowns in THREE different encodings and a template can mix them.
  // Only the first was handled before, so columns using the others were treated as free
  // text and the raw vendor value was written straight through — that is how "Rectangle"
  // reached a cell whose list only offers "Rectangular".
  //
  //   1. paired         <dataValidation …><formula1>"A,B"</formula1></dataValidation>
  //   2. self-closing   <dataValidation … formula1="&quot;A,B&quot;"/>
  //   3. x14 extension  <x14:dataValidation …><x14:formula1><xm:f>Lists!$A$1:$A$9</xm:f>…
  //                     plus <xm:sqref> instead of a sqref attribute (Excel uses this
  //                     whenever the option list lives on another sheet)
  type RawDv = { attrs: string; body: string };
  const rawDvs: RawDv[] = [];
  // Paired or self-closing, with or without an x14: prefix
  for (const m of sheetXml.matchAll(
    /<(?:\w+:)?dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?dataValidation>)/g,
  )) {
    rawDvs.push({ attrs: m[1] ?? "", body: m[2] ?? "" });
  }

  for (const { attrs, body } of rawDvs) {
    if (!/\btype="list"/i.test(attrs)) continue;
    // sqref lives either in an attribute or, for x14 blocks, in an <xm:sqref> element
    const sqrefVal =
      attrs.match(/\bsqref="([^"]+)"/i)?.[1] ??
      body.match(/<(?:\w+:)?sqref[^>]*>([\s\S]*?)<\/(?:\w+:)?sqref>/i)?.[1]?.trim();
    if (!sqrefVal) continue;
    // sqref is a space-separated list of ranges. Take a column as a target only
    // when it is the ANCHOR (left) column of some sub-range — never merely the
    // right edge of a rectangular block. Amazon's template attaches a stray 2-D
    // range like "B9:C9" to the Listing Action validation, which previously
    // spread that dropdown onto column C and shadowed C's own (ID-Type) list.
    // Anchoring to the left column keeps each single-column validation (X#:X#)
    // authoritative for its own column while ignoring the incidental overlap.
    const letters = [...new Set(
      sqrefVal.split(/\s+/).map((tok) => tok.match(/^\$?([A-Z]+)/i)?.[1]?.toUpperCase()).filter(Boolean) as string[],
    )];
    if (!letters.length) continue;
    // formula1 may be an attribute, a <formula1> element, or an x14 <xm:f> element
    const rawFormula =
      body.match(/<(?:\w+:)?formula1[^>]*>\s*(?:<(?:\w+:)?f[^>]*>([\s\S]*?)<\/(?:\w+:)?f>|([\s\S]*?))\s*<\/(?:\w+:)?formula1>/i)
        ?.slice(1).find(Boolean)?.trim() ??
      attrs.match(/\bformula1="([^"]*)"/i)?.[1]?.trim() ??
      "";
    // XML-unescape formula1 (some exporters write &quot; instead of ")
    const formula = xmlUnescape(rawFormula);
    let opts: string[] = [];
    if (formula.startsWith('"') && formula.endsWith('"')) {
      // Inline list: "Yes,No" or "New,Used,Refurbished"
      opts = formula.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    } else if (formula) {
      // Range reference: Lists!$A$1:$A$10, =Sheet2!$B:$B, or a DEFINED NAME.
      // Mathis templates point every dropdown at a defined name (e.g.
      // "Validation_28ae…_product_RUG_SHAPE" → ReferenceData!$R$2:$R$7) rather than a
      // direct range. Resolve the name to its range first; unresolved names yield no
      // options, which would silently turn the column into free text.
      //
      // Amazon's listing-loader wraps every dropdown in INDIRECT(...) that
      // concatenates string literals, e.g.
      //   INDIRECT("PRODUCT"&"country_of_origin1.value")
      // which Excel evaluates to the defined name PRODUCTcountry_of_origin1.value
      // → 'Dropdown Lists'!$AK$4:$AK$271. Collapse such a formula to that name so
      // the defined-name lookup below resolves it (otherwise UPC/Country and every
      // other Amazon dropdown fails to match and gets blanked by the hard invariant).
      const bare = evalIndirectConcat(formula.replace(/^=/, "").trim());
      const ref = definedNames.get(bare) ?? bare;
      opts = await resolveXmlRangeDropdown(tplZip, ref, sheetNameToPath, ssArr);
    }
    if (opts.length) {
      for (const letter of letters) {
        if (!dropdowns.has(letter)) dropdowns.set(letter, opts);
      }
    }
  }

  // ── Category-column fallback (Mathis only) ────────────────────────────────
  // When the template's range-based category dropdown can't be resolved (sheet
  // name mismatch, encoding issue, etc.) seed it from the Mathis taxonomy CSV.
  // Only applies to Mathis exports — other marketplaces write category as plain
  // text and don't need a forced dropdown option list.
  const isMathis = marketplace.toLowerCase() === "mathis";
  if (isMathis) {
    const catEntry = colEntries.find(({ col }) =>
      normalizeKey(col.key) === "category" || normalizeKey(col.label) === "category"
    );
    if (catEntry && !dropdowns.has(catEntry.letter)) {
      try {
        const paths = loadMathisCategoryPaths();
        const mathisPaths = paths.map(p => "Mathis Home/" + p.split(" > ").map(s => s.trim()).join("/"));
        if (mathisPaths.length) dropdowns.set(catEntry.letter, mathisPaths);
      } catch { /* CSV unavailable — leave column without forced dropdown */ }
    }
  }

  // ── Find first actual data row (skip multi-row headers) ───────────────────
  // Mathis templates have two green header rows:
  //   Row 1 = human-readable labels  (Category, Shop SKU, …)
  //   Row 2 = internal field codes   (category, shopSKU, DIMH, …)  ← MUST be preserved
  //   Row 3+ = pink data-entry rows  ← where product data goes
  // Detect all consecutive "header-styled" rows after headerRowNum and skip them.
  const headerStyles = new Set<string>();
  for (const cm of headerRowXml.matchAll(/\bs="(\d+)"/g)) headerStyles.add(cm[1]);

  // A row that still carries long prose in every populated cell is the
  // template's per-column help text, not a data row. Walmart's template puts
  // one directly under the field-code header ("Alphanumeric, 50 characters -
  // The string of letters…"); writing products there destroys the instructions
  // and leaves the real entry area empty. Treat any row whose populated cells
  // average well beyond a plausible data value as part of the header block.
  const isHelpTextRow = (rowXml: string): boolean => {
    const labels = readRowLabels(rowXml);
    if (labels.size < 2) return false;
    const lens = [...labels.values()].map((v) => v.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    return avg > 80;
  };

  let firstDataRowNum = headerRowNum + 1;
  for (const rm of rowMatches) {
    const rn = parseInt(rm[1]);
    if (rn <= headerRowNum) continue;
    // Count how many cells in this row carry a header-type style vs. a different style
    const cellStylesInRow = [...rm[0].matchAll(/\bs="(\d+)"/g)].map(m => m[1]);
    const nonHeaderCells = cellStylesInRow.filter(s => !headerStyles.has(s)).length;
    if ((cellStylesInRow.length > 0 && nonHeaderCells === 0) || isHelpTextRow(rm[0])) {
      // Subheader / field-code / help-text row → keep it, data starts below
      firstDataRowNum = rn + 1;
    } else {
      // First row with different (data) styling — this is where products go
      firstDataRowNum = rn;
      break;
    }
  }

  // ── Build output rows using the template's own pre-formatted rows ──────────
  // Index all rows starting from firstDataRowNum; these carry the pink cell styles.
  const allDataRows = new Map<number, string>();
  for (const rm of rowMatches) {
    const rn = parseInt(rm[1]);
    if (rn >= firstDataRowNum) allDataRows.set(rn, rm[0]);
  }

  console.log(`[export] firstDataRowNum=${firstDataRowNum}, allDataRows.size=${allDataRows.size}, borrowedStyle will be empty=${allDataRows.size === 0}`);
  // Borrow the data-entry style per column for rows beyond the template.
  // Scan EVERY template data row, not just the first: templates often leave
  // some columns absent from the first row but styled further down, and a
  // column we never see styled would otherwise export unformatted.
  const borrowedStyle = new Map<string, string>(); // letter → s-index
  for (const rn of [...allDataRows.keys()].sort((a, b) => a - b)) {
    for (const cm of (allDataRows.get(rn) ?? "").matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"([^>]*)/g)) {
      const s = cm[2].match(/\bs="(\d+)"/)?.[1];
      if (s && !borrowedStyle.has(cm[1])) borrowedStyle.set(cm[1], s);
    }
  }
  // Columns the template never styles in its data area (Walmart ships rows with
  // only D/F/G/H) still need the shaded entry format, or the export shows a few
  // styled columns beside plain white ones. Fall back to the most common data
  // style so every mapped column matches the template's look.
  const styleFreq = new Map<string, number>();
  for (const s of borrowedStyle.values()) styleFreq.set(s, (styleFreq.get(s) ?? 0) + 1);
  const dominantDataStyle = [...styleFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (dominantDataStyle) {
    for (const { letter } of colEntries) {
      if (!borrowedStyle.has(letter)) borrowedStyle.set(letter, dominantDataStyle);
    }
  }
  console.log(`[export] borrowedStyle populated: ${borrowedStyle.size} columns, dominantDataStyle=${dominantDataStyle ?? "none"}, allStyleValues=[${[...new Set(borrowedStyle.values())].slice(0,5).join(",")}]`);

  const outputRows: string[] = [];

  // ── Dropdown-constrained values ────────────────────────────────────────────
  // Every column carrying a dataValidation list MUST receive one of its own options
  // verbatim, otherwise the marketplace rejects the row on import. Resolution order:
  //   1. pickDropdownValue — deterministic (exact → word overlap → substring)
  //   2. AI nearest-compatible match, for values with no lexical overlap
  //      ("Charcoal" → "Grey", "Boucle" → "Fabric")
  //   3. Blank — better an empty optional cell than an invalid value
  // The raw value is never written through to a dropdown column.

  // Normalize a path-style value ("A > B") to the slash form Mathis dropdowns use.
  const toDropdownRaw = (raw: string): string =>
    (raw.includes(" > ") && !raw.includes("/"))
      ? (isMathis
          ? "Mathis Home/" + raw.split(" > ").map(s => s.trim()).join("/")
          : raw.split(" > ").map(s => s.trim()).join("/"))
      : raw;

  // Pass 1 — collect values the deterministic matcher could not place.
  const aiQueries: DropdownQuery[] = [];
  for (const p of products) {
    // Only the columns we actually export — resolving dropdowns for blanked
    // optional columns would spend AI calls on values nothing ever writes.
    for (const { col, letter } of exportEntries) {
      const options = dropdowns.get(letter);
      if (!options) continue;
      // specproducttype is always written raw — no AI dropdown matching needed
      if (normalizeKey(String(col.key ?? "")) === "specproducttype") continue;
      const raw = String(getProductField(p, col.key) ?? "");
      if (!raw.trim()) continue;
      const candidate = toDropdownRaw(raw);
      if (pickDropdownValue(candidate, options) === null) {
        aiQueries.push({ column: colLetterToHeader.get(letter) ?? col.label ?? col.key, value: candidate, options });
      }
    }
  }
  const aiMatches = aiQueries.length ? await matchDropdownValues(aiQueries) : new Map<string, string>();

  const isTemu = marketplace.toLowerCase() === "temu";
  const isWalmart = marketplace.toLowerCase() === "walmart";
  const isAmazon = marketplace.toLowerCase() === "amazon" || marketplace.toLowerCase() === "amazon_us";
  // Map a categorized value (a rich "A > B > C" path, or already a flat value)
  // down to one of the 75 categories the Walmart template dropdown accepts.
  // Loaded lazily so non-Walmart exports never touch the taxonomy files.
  const { mapToTemplateCategory } = isWalmart
    ? await import("@/lib/ai/walmart-taxonomy")
    : { mapToTemplateCategory: (): string | null => null };

  // Shipping weight is a required numeric field and Walmart rejects a blank or
  // zero value, so a product whose vendor sheet has no usable weight gets a
  // nominal 0.1 lb rather than failing the row. Matches the template's own
  // field code ("ShippingWeight") and label ("Shipping Weight (lbs)").
  const WEIGHT_FALLBACK = "0.1";
  const isShippingWeightCol = (col: Column, letter: string): boolean => {
    const header = colLetterToHeader.get(letter) ?? "";
    return [col.key, col.label, header].some((s) => {
      const n = normalizeKey(String(s ?? ""));
      return n === "shippingweight" || n === "shippingweightlbs";
    });
  };

  // Amazon's template repeats the same label across sibling columns — five
  // "Other Image Location" columns, five "Features", etc. They all normalise to
  // one key, so getProductField can't tell #1 from #5. Pre-compute each repeated
  // column's ordinal (0-based) among its like-labelled siblings, keyed by letter,
  // so colVal can pull image #2 into the second "Other Image" column and so on.
  const amazonSiblingOrdinal = new Map<string, number>();
  if (isAmazon) {
    const seen = new Map<string, number>();
    for (const { letter } of [...colEntries].sort((a, b) => colNum(a.letter) - colNum(b.letter))) {
      const nk = normalizeKey(colLetterToHeader.get(letter) ?? "");
      const n = seen.get(nk) ?? 0;
      amazonSiblingOrdinal.set(letter, n);
      seen.set(nk, n + 1);
    }
  }
  // Vendor extra-image URLs in order, resolved once per product (memoised by id).
  const _extraImgCache = new Map<string, string[]>();
  const extraImages = (p: Product): string[] => {
    const hit = _extraImgCache.get(p.id);
    if (hit) return hit;
    const vd = p.vendorData as Record<string, unknown> | null;
    const vdNorm = vd ? getVdNorm(vd) : null;
    const pick = (...aliases: string[]): string => {
      if (!vdNorm) return "";
      for (const a of aliases) {
        const v = vdNorm.get(normalizeKey(a));
        if (v != null && String(v).trim() !== "") return String(v).trim();
      }
      return "";
    };
    const urls = [
      pick("image_url2", "image_url_2", "image2", "other_image_url1", "alternate_image1", "secondary_image"),
      pick("image_url3", "image_url_3", "image3", "other_image_url2", "alternate_image2"),
      pick("image_url4", "image_url_4", "image4", "other_image_url3", "alternate_image3"),
      pick("image_url5", "image_url_5", "image5", "other_image_url4", "alternate_image4"),
      pick("image_url6", "image_url_6", "image6", "other_image_url5", "alternate_image5"),
    ];
    _extraImgCache.set(p.id, urls);
    return urls;
  };

  // Compute the final value for a column (dropdown-safe)
  const colVal = (p: Product, col: Column, letter: string): string => {
    let raw = String(getProductField(p, col.key) ?? "");

    // Temu-specific field coercions applied before dropdown matching
    if (isTemu) {
      const nk = normalizeKey(col.key);
      // Status: Temu uses "1" (on-sale) / "0" (off-sale) — map the generic "on_sale" default
      if (nk === "status" && (raw === "on_sale" || raw === "")) raw = "1";
      // Category: the template's top-level dropdown needs only level-1 of the path
      if (nk === "category" && raw.includes(" > ")) raw = raw.split(" > ")[0]?.trim() ?? raw;
      // "Product type" / "Goods type" on Temu = listing format ("Normal product" /
      // "Custom product"), NOT the marketplace category. The coreMap maps these to
      // marketplaceCategory (a " > " path) which is wrong here; also covers the case
      // where no category was assigned (raw="") — both should default to "Normal product".
      if ((nk === "producttype" || nk === "goodstype" || nk === "skutype") && (raw.includes(" > ") || !raw.trim())) raw = "Normal product";
    }

    // Amazon listing-loader field coercions applied before dropdown matching.
    if (isAmazon) {
      const nk = normalizeKey(col.key);
      const headerNk = normalizeKey(colLetterToHeader.get(letter) ?? "");
      // "Listing Action" (field code ::record_action) accepts "Create or Edit" /
      // "Delete" — NOT the generic "Add" the coreMap fills for other marketplaces.
      if (nk === "listingaction" && (raw === "Add" || !raw.trim())) raw = "Create or Edit";

      // "Features" here is supplemental_condition_information.features — a
      // refurbishment-type dropdown for NON-new items (Green Refurbishment, Parts
      // Inspected…), NOT product bullet points. The generic coreMap fills it with
      // the description, which is invalid for a New offer, so blank it.
      if (headerNk === "features") raw = "";

      // Columns intentionally left blank for the Amazon offer flow (filled by the
      // seller downstream, or matched by Amazon from the ASIN): gift wrap, main
      // image, and the external product id + its type. Blank regardless of source.
      if (headerNk === "isgiftwrapavailable" || headerNk === "mainimagelocation" ||
          headerNk === "externalproductidtype" || headerNk === "externalproductid") {
        raw = "";
      }

      // The five "Other Image Location" columns share one label; assign each the
      // next distinct vendor image by its ordinal among the siblings.
      if (headerNk === "otherimagelocation") {
        raw = extraImages(p)[amazonSiblingOrdinal.get(letter) ?? 0] ?? "";
      }

      // Never emit a lone dimension/weight UNIT when its paired value is blank —
      // Amazon rejects a unit with no value. Each "* Unit" sits immediately to the
      // right of its value column, so clear the unit if that neighbour is empty.
      if (/unit$/.test(headerNk) && raw.trim()) {
        const target = colNum(letter) - 1;
        const valueCol = colEntries.find((e) => colNum(e.letter) === target)?.col;
        const paired = valueCol ? String(getProductField(p, valueCol.key) ?? "").trim() : "";
        if (!paired) raw = "";
      }
    }

    if (isShippingWeightCol(col, letter)) {
      // Treat missing, non-numeric and non-positive alike — all are unusable.
      const n = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) && n > 0 ? String(n) : WEIGHT_FALLBACK;
    }

    // Walmart Product Category: prefer the live categoryPath (Walmart's own category
    // from the Affiliate API, stored during verification) over the AI-assigned broad
    // bucket from marketplaceCategory. For unverified products the AI bucket is used
    // as the fallback. Either way, mapToTemplateCategory below converts to one of the
    // 75 dropdown values the Walmart template accepts.
    if (isWalmart) {
      const nk = normalizeKey(col.key);
      const headerNk = normalizeKey(colLetterToHeader.get(letter) ?? "");
      if (nk === "productcategory" || nk === "category" ||
          headerNk === "productcategory" || headerNk === "category") {
        // categoryPath is Walmart's own live category ("Home > Table Lamps") — more
        // accurate than our AI guess. Use it when present.
        const livePath = (p as { categoryPath?: string | null }).categoryPath?.trim();
        if (livePath) raw = livePath;
        // If raw is still empty after the live path check, leave it blank rather
        // than writing an invalid value — mapToTemplateCategory handles the rest.
        if (raw.trim()) raw = mapToTemplateCategory(raw) ?? "";
      }
    }

    const options = dropdowns.get(letter);

    // Amazon numeric offer fields (price, min/max price, quantity, weights,
    // dimensions) carry a one-option "dropdown" that is really a sentinel action
    // — e.g. "Delete Offer (Sell on Amazon)" or "Delete Quantity Discounts". The
    // cell still accepts a typed number, so a numeric value must bypass dropdown
    // matching; otherwise the hard invariant below would blank every price.
    if (isAmazon && options && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
      const headerNk = normalizeKey(colLetterToHeader.get(letter) ?? "");
      const numericField =
        /price|quantity|weight|length|width|height|value|threshold|count|cells?|percentage/.test(headerNk) ||
        options.every((o) => /^delete\b/i.test(o)); // options are only Delete-sentinels
      if (numericField) return raw.trim();
    }

    // Spec Product Type is always written directly — bypass all dropdown logic so the
    // Walmart subcategory appears in the cell regardless of the template's validation list.
    if (isWalmart && normalizeKey(String(col.key ?? "")) === "specproducttype") return raw;

    if (!options) return raw;
    if (!raw.trim()) return "";
    const candidate = toDropdownRaw(raw);

    let value: string;
    const picked = pickDropdownValue(candidate, options);
    if (picked !== null) {
      value = picked;
    } else {
      // Deterministic matching failed — use the AI match, else blank the cell.
      const header = colLetterToHeader.get(letter) ?? col.label ?? col.key;
      value = aiMatches.get(dropdownKey(header, candidate)) ?? "";
    }

    // ── Hard invariant ───────────────────────────────────────────────────────
    // Matching the template is the core promise of this export, so a value that is
    // not in the list must never survive to the sheet — no matter which stage above
    // produced it or failed (AI unavailable, key missing, request error, stale match).
    // Anything unrecognised is dropped and logged rather than written as invalid data.
    //
    // Exception: "Spec Product Type" is written directly even when not in the
    // dropdown — the correct Walmart subcategory must appear in the cell regardless
    // of whether the template's validation list includes it.
    if (value && !options.some((o) => o === value)) {
      const header = colLetterToHeader.get(letter) ?? col.label ?? col.key;
      console.warn(
        `[export] dropped invalid dropdown value for "${header}": ${JSON.stringify(value)} ` +
        `(vendor value ${JSON.stringify(raw)}; ${options.length} allowed options)`,
      );
      return "";
    }
    return value;
  };

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const rn = firstDataRowNum + i;
    const tplRow = allDataRows.get(rn);

    // ── Rebuild the row cell-by-cell in strict column order ────────────────────
    // The previous in-place patch only wrote into cells the template row already
    // contained. Walmart's template ships data rows holding just D, F, G and H,
    // so every other mapped column (E, I, J, K, …) was silently dropped and the
    // export came out with a single filled column. Appending the missing cells
    // before </row> was no better: OOXML requires cells in ascending column
    // order, and an out-of-order row makes Excel treat the sheet as damaged.
    //
    // Rebuilding keeps the row's own <row> attributes (height, custom format)
    // and each existing cell's style, while guaranteeing every mapped column is
    // present and correctly ordered.
    const rowAttrs = tplRow
      ? (tplRow.match(/<row\b([^>]*)>/)?.[1] ?? ` r="${rn}"`)
      : ` r="${rn}"`;

    // Existing cell styles for this row, by column letter.
    const rowCellStyle = new Map<string, string>();
    if (tplRow) {
      for (const cm of tplRow.matchAll(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)) {
        const letter = cm[1].match(/\br="([A-Z]+)\d+"/)?.[1];
        const s = cm[1].match(/\bs="(\d+)"/)?.[1];
        if (letter && s) rowCellStyle.set(letter, s);
      }
    }
    // Style precedence: this row's own cell → the style borrowed from the first
    // template data row → none. This is what keeps the shaded data-entry
    // formatting on columns the template left empty.
    const styleFor = (letter: string): string => {
      const s = rowCellStyle.get(letter) ?? borrowedStyle.get(letter);
      return s ? ` s="${s}"` : "";
    };

    // Union of template columns and our mapped columns, ordered left-to-right so
    // untouched template cells (and their styling) survive alongside new ones.
    const letters = new Set<string>([...rowCellStyle.keys()]);
    for (const { letter } of colEntries) letters.add(letter);
    const ordered = [...letters].sort((a, b) =>
      a.length !== b.length ? a.length - b.length : a.localeCompare(b),
    );
    // Values only for the required columns. Optional columns still get an empty
    // styled cell below, so the template's look is unchanged — they just carry
    // no data.
    const valueByLetter = new Map(
      exportEntries.map(({ col, letter }) => [letter, colVal(p, col, letter)]),
    );

    const cells = ordered.map((letter) => {
      const ref = `${letter}${rn}`;
      const sAttr = styleFor(letter);
      const val = valueByLetter.get(letter);
      // Column the template styles but we have no data for → keep it empty so
      // the cell (and its fill/border) is preserved.
      if (val === undefined || val === "") return `<c r="${ref}"${sAttr}/>`;
      // Long numeric identifiers (UPC/GTIN) can't be written as a plain number in
      // a General-formatted cell — Excel renders them as 6.36E+11. So normally they
      // go out as a shared string. But if the cell's own style is a Text format
      // (numFmt 49 / "@"), a numeric value already displays literally, and writing
      // it as a NUMBER avoids the "number stored as text" green triangle that a
      // shared string triggers. Amazon's template styles its id columns as Text,
      // so this is the common case for UPC/EAN.
      const isLargeId = /^\d{10,}$/.test(val);
      const styleIdx = sAttr.match(/\bs="(\d+)"/)?.[1];
      const cellIsTextFormatted = styleIdx != null && textFormatStyles.has(styleIdx);
      const isNum = !Number.isNaN(Number(val)) && (!isLargeId || cellIsTextFormatted);
      return isNum
        ? `<c r="${ref}"${sAttr}><v>${x(val)}</v></c>`
        : `<c r="${ref}"${sAttr} t="s"><v>${ssIdx(val)}</v></c>`;
    }).join("");

    outputRows.push(`<row${rowAttrs}>${cells}</row>`);
  }

  // Remaining pre-formatted rows beyond the product count — clear values but
  // keep row structure and pink cell styles (empty input area stays styled).
  let maxTplRow = firstDataRowNum;
  for (const rn of allDataRows.keys()) { if (rn > maxTplRow) maxTplRow = rn; }
  for (let rn = firstDataRowNum + products.length; rn <= maxTplRow; rn++) {
    const tplRow = allDataRows.get(rn);
    if (!tplRow) continue;
    const cleared = tplRow
      .replace(/<v>[\s\S]*?<\/v>/g, "")
      .replace(/<f>[\s\S]*?<\/f>/g, "")
      .replace(/<is>[\s\S]*?<\/is>/g, "")
      .replace(/\s*\bt="[^"]*"/g, "")
      .replace(/<c\b([^>]*)><\/c>/g, "<c$1/>");
    outputRows.push(cleared);
  }

  // Assemble sheetData: ALL rows before firstDataRowNum (both header rows) + output rows
  const keptRows = rowMatches.filter(rm => parseInt(rm[1]) < firstDataRowNum).map(rm => rm[0]).join("");
  sheetXml = sheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${keptRows}${outputRows.join("")}</sheetData>`);

  // ── Expand TABLE and autoFilter refs to cover all exported data rows ────────
  // Template colours usually come from the TABLE style (not per-cell s="N").
  // If the table's ref ends before our last data row those rows appear plain white.
  // Parse the table ref, keep the column span, extend the end row.
  const lastDataRow = firstDataRowNum - 1 + products.length;

  // Helper: given a ref like "A1:AA10", extend the end-row to lastDataRow (never shrink)
  const extendRef = (ref: string): string => {
    const m = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
    if (!m) return ref;
    const newEnd = Math.max(parseInt(m[4], 10), lastDataRow);
    return `${m[1]}${m[2]}:${m[3]}${newEnd}`;
  };

  // Update xl/tables/*.xml — table ref + its nested autoFilter ref
  for (const [fpath, fobj] of Object.entries(tplZip.files)) {
    if (!/^xl\/tables\/[^/]+\.xml$/i.test(fpath)) continue;
    let tblXml = await fobj.async("string");
    tblXml = tblXml.replace(/(<table\b[^>]*\bref=")([^"]+)(")/i, (_, pre, ref, post) => {
      const newRef = extendRef(ref);
      console.log(`[export] table ref: ${ref} → ${newRef} (lastDataRow=${lastDataRow})`);
      return `${pre}${newRef}${post}`;
    });
    tblXml = tblXml.replace(/(<autoFilter\b[^>]*\bref=")([^"]+)(")/i, (_, pre, ref, post) => `${pre}${extendRef(ref)}${post}`);
    tplZip.file(fpath, tblXml);
  }

  // Also update the sheet-level <autoFilter> (some templates skip xl/tables/ entirely)
  sheetXml = sheetXml.replace(/(<autoFilter\b[^>]*\bref=")([^"]+)(")/i, (_, pre, ref, post) => `${pre}${extendRef(ref)}${post}`);

  // ── Extend dataValidation ranges to cover every exported row ────────────────
  // Templates ship a fixed validation window (Walmart's is E7:E1006). Exporting
  // more products than that leaves the overflow rows with no dropdown, so the
  // marketplace rejects values Excel never constrained. Widen each range's end
  // row the same way the table/autoFilter refs are widened above.
  const extendSqref = (sqref: string): string =>
    sqref.split(/\s+/).filter(Boolean).map((part) => {
      const m = part.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
      if (!m) return part;
      // Only stretch ranges that already end at or beyond the data area — never
      // shrink one, and never touch header-only ranges.
      const end = parseInt(m[4], 10);
      return end >= firstDataRowNum && end < lastDataRow
        ? `${m[1]}${m[2]}:${m[3]}${lastDataRow}`
        : part;
    }).join(" ");

  sheetXml = sheetXml.replace(
    /(<(?:\w+:)?dataValidation\b[^>]*\bsqref=")([^"]+)(")/gi,
    (_, pre, ref, post) => `${pre}${extendSqref(ref)}${post}`,
  );
  // x14 validations carry the range in an <xm:sqref> element instead
  sheetXml = sheetXml.replace(
    /(<(?:\w+:)?sqref[^>]*>)([\s\S]*?)(<\/(?:\w+:)?sqref>)/gi,
    (_, pre, ref, post) => `${pre}${extendSqref(ref.trim())}${post}`,
  );

  // ── Write modified files back into the ZIP ─────────────────────────────────
  tplZip.file(sheetPath, sheetXml);

  // Write back: original <si> elements preserved verbatim (rich text intact),
  // followed by new plain-text entries for product data values.
  const totalSs = originalSiXmls.length + newSiTexts.length;
  const newSsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totalSs}" uniqueCount="${totalSs}">
${originalSiXmls.map(si => `<si>${si}</si>`).join("")}${newSiTexts.map(s => `<si><t xml:space="preserve">${x(s)}</t></si>`).join("")}</sst>`;
  tplZip.file(ssPath, newSsXml);

  // Register sharedStrings in [Content_Types].xml if the template omitted it
  const ctXml = await tplZip.file("[Content_Types].xml")?.async("string") ?? "";
  if (ctXml && !ctXml.includes("sharedStrings")) {
    tplZip.file("[Content_Types].xml", ctXml.replace(
      "</Types>",
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    ));
  }

  return tplZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as unknown as Promise<Buffer>;
}

/** Resolve a dataValidation range reference (e.g. =Lists!$A$1:$A$10) by reading
 *  cells from the referenced sheet in the template ZIP. */
async function resolveXmlRangeDropdown(
  tplZip: JSZip,
  formula: string,
  sheetNameToPath: Map<string, string>,
  ssArr: string[],
): Promise<string[]> {
  const m = /^(?:'?([^'!]+)'?!)?\$?([A-Z]+)\$?(\d+)?(?::\$?[A-Z]+\$?(\d+)?)?$/i.exec(formula);
  if (!m) return [];
  const [, sheetName, colLetter, r1, r2] = m;
  const path = sheetName ? sheetNameToPath.get(sheetName.toLowerCase()) : null;
  if (!path) return [];
  const xml = await tplZip.file(path)?.async("string") ?? "";
  if (!xml) return [];
  const startRow = r1 ? parseInt(r1) : 1;
  const endRow = r2 ? parseInt(r2) : 9999;
  const targetCol = colLetter.toUpperCase();
  const opts: string[] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rn = parseInt(rm[1]);
    if (rn < startRow || rn > endRow) continue;
    for (const cm of rm[2].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (cm[1].toUpperCase() !== targetCol) continue;
      const isShared = /\bt="s"/.test(cm[2]);
      const vVal = cm[3].match(/<v>(\d+)<\/v>/)?.[1] ?? "";
      const tVal = cm[3].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      const val = isShared && vVal ? (ssArr[parseInt(vVal)] ?? "") : xmlUnescape(tVal || vVal);
      if (val.trim()) opts.push(val.trim());
    }
  }
  return opts;
}

/** Extract plain text from a shared-string <si> element (handles simple + rich text). */
function extractSsText(siXml: string): string {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(siXml))) out += xmlUnescape(m[1]);
  return out;
}

function xmlUnescape(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ── Create a fresh workbook — pure XML + JSZip, no ExcelJS ───────────────────
// ExcelJS.writeBuffer() is CPU-bound and blocks the Node.js event loop for
// several seconds per file. JSZip.generateAsync() uses native zlib (truly
// async) so it never blocks the event loop, keeping GET polls responsive.

async function createXlsxFromScratch(
  products: Product[],
  columns: Column[],
  sheetName: string,
): Promise<Buffer> {
  // Build all rows: header first, then one row per product.
  // Yield every 100 rows so the event loop stays free to serve GET poll requests
  // while generating large files (185+ products).
  const allRows: string[][] = [columns.map((c) => c.label)];
  for (let i = 0; i < products.length; i++) {
    if (i > 0 && i % 100 === 0) await new Promise<void>((r) => setImmediate(r));
    allRows.push(columns.map((c) => String(getProductField(products[i], c.key) ?? "")));
  }

  // Shared-string table (XLSX stores text by index to deduplicate)
  const ssArr: string[] = [];
  const ssMap = new Map<string, number>();
  const ssIdx = (s: string): number => {
    let i = ssMap.get(s);
    if (i === undefined) { i = ssArr.length; ssMap.set(s, i); ssArr.push(s); }
    return i;
  };
  for (const row of allRows) for (const cell of row) ssIdx(cell);

  // Column-letter helper: 1→A, 27→AA …
  const colLetter = (n: number): string => {
    let s = "";
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s;
  };

  // Sheet XML — numbers written inline, strings reference shared-string index.
  // Exception: numeric strings with 10+ digits (UPCs, EANs, GTINs, numeric ASINs)
  // must be forced to shared-string cells so Excel doesn't render them as 6.36E+11.
  const rowXml = allRows.map((row, ri) => {
    const cells = row.map((val, ci) => {
      const ref = `${colLetter(ci + 1)}${ri + 1}`;
      const isLargeId = /^\d{10,}$/.test(val);
      const isNum = val !== "" && !isLargeId && !Number.isNaN(Number(val));
      return isNum
        ? `<c r="${ref}"><v>${x(val)}</v></c>`
        : `<c r="${ref}" t="s"><v>${ssIdx(val)}</v></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");

  const safeSheet = sheetName.slice(0, 31).replace(/[\\/*?[\]:]/g, "_");

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowXml}</sheetData></worksheet>`;

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ssArr.length}" uniqueCount="${ssArr.length}">
${ssArr.map((s) => `<si><t xml:space="preserve">${x(s)}</t></si>`).join("")}
</sst>`;

  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${x(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const xlsxZip = new JSZip();
  xlsxZip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
  xlsxZip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  xlsxZip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  xlsxZip.file("xl/workbook.xml", wbXml);
  xlsxZip.file("xl/worksheets/sheet1.xml", sheetXml);
  xlsxZip.file("xl/sharedStrings.xml", ssXml);
  xlsxZip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`);

  return xlsxZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as unknown as Promise<Buffer>;
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function generateCsv(products: Product[], columns: Column[]): string {
  const header = columns.map((c) => `"${c.label}"`).join(",");
  const rows = products.map((p) =>
    columns.map((c) => {
      const val = getProductField(p, c.key);
      return `"${String(val ?? "").replace(/"/g, '""')}"`;
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

// ── Field resolver ────────────────────────────────────────────────────────────

// Cache the normalized-key → value map for vendorData objects.
// Without this, getProductField rebuilds the map on every cell (once per product × column),
// which for 370 products × 45 columns = 16,650 linear scans over vendorData keys.
// With the cache, the map is built ONCE per product and all subsequent lookups are O(1).
const _vdNormCache = new WeakMap<object, Map<string, unknown>>();

function getVdNorm(vd: Record<string, unknown>): Map<string, unknown> {
  const cached = _vdNormCache.get(vd);
  if (cached) return cached;
  const norm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(vd)) {
    if (v !== "" && v != null) norm.set(normalizeKey(k), v);
  }
  _vdNormCache.set(vd, norm);
  return norm;
}

// The normalized coreMap (200+ derived fields) depends ONLY on the product, but
// getProductField is called once per template column (80+ for Mathis). Rebuilding the
// whole coreMap every call is O(columns × coreMapSize) per product and, with a rich
// vendorData, degrades badly enough to hang a large export. Cache the finished
// normalized map per product so it's built exactly once.
const _coreNormCache = new WeakMap<object, Map<string, unknown>>();

function getProductField(p: Product, key: string): unknown {
  const nk = normalizeKey(key);
  // "Length - in" normalises to "lengthin" but coreMap has "length". Pre-compute a
  // unit-suffix-stripped form so both lookups can fall back to the bare field name.
  const bareNk = (() => {
    for (const s of ["lbs", "kg", "oz", "lb", "cm", "mm", "ft", "ml", "in", "g", "m", "l"]) {
      if (nk.endsWith(s) && nk.length > s.length + 2) return nk.slice(0, -s.length);
    }
    return null;
  })();
  const vd = p.vendorData as Record<string, unknown> | null;
  const ld = p.liveData as Record<string, unknown> | null;

  // O(1) vendorData lookup using the per-product normalized key map
  const vdNorm: Map<string, unknown> | null = vd ? getVdNorm(vd) : null;

  // Fast path: coreMap already built for this product on a previous column — reuse it
  // and run only the (cheap) lookups below, skipping the expensive coreMap rebuild.
  const cachedCore = _coreNormCache.get(p);
  if (cachedCore) {
    if (cachedCore.has(nk)) return cachedCore.get(nk);
    if (bareNk && cachedCore.has(bareNk)) return cachedCore.get(bareNk);
    return lookupVendorAndLive(nk, bareNk, key, vd, vdNorm, ld);
  }

  const fromVendor = (...aliases: string[]): unknown => {
    if (!vd || !vdNorm) return undefined;
    for (const alias of aliases) {
      // Exact original-key match (covers keys that are already lowercase / no spaces)
      if (alias in vd) { const v = vd[alias]; if (v !== "" && v != null) return v; }
      // O(1) normalized match via cached map
      const v = vdNorm.get(normalizeKey(alias));
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const fromLive = (field: string): unknown => ld?.[field] ?? undefined;

  const livePrice = typeof ld?.price === "number" && ld.price > 0 ? ld.price / 100 : null;
  const verifiedAsin = typeof ld?.asin === "string" ? ld.asin : null;
  // Marketplace product-page URL (e.g. Walmart https://www.walmart.com/ip/...),
  // built during verification and stored in liveData.productUrl. This is the
  // product listing link — NOT the image URL.
  const productPageUrl =
    (typeof ld?.productUrl === "string" && ld.productUrl) ||
    (fromVendor("product_url", "product_page_url", "listing_url", "item_url", "url") as string | undefined) ||
    "";

  const price = p.price != null
    ? p.price
    : (fromVendor("price", "retail_price", "unit_price", "cost", "msrp", "list_price", "wholesale") ?? livePrice ?? "");

  // ── Broad ID search across vendor data ──────────────────────────────────────
  // Covers any column a vendor might use for item/style/model/catalog numbers
  const anyVendorId = fromVendor(
    // Explicit seller-SKU columns come FIRST. Vendor sheets often carry both a real
    // "Shop SKU" (e.g. TOVF-TOVOC21017FBMP) and a generic "sku" column holding junk —
    // in the Mathis feed "sku" literally contains the text "ASIN". Alias order decides
    // the winner, so the specific, trustworthy headers must be tried before "sku".
    "shop_sku", "shopsku", "offer_sku", "offersku", "seller_sku", "merchant_sku", "vendor_sku", "supplier_sku",
    "item", "item_no", "item_number", "item_id", "item_#",
    "sku", "sku_id", "sku_no",
    "style", "style_no", "style_number", "style_id", "style_#",
    "model", "model_no", "model_number", "model_id",
    "part_no", "part_number", "part_id",
    "product_no", "product_number", "product_code",
    "article_no", "article_number", "article_id", "article",
    "catalog_no", "catalog_number", "cat_no",
    "design_no", "design_number", "design_id",
    "reference", "ref", "ref_no",
    "stock_no", "stock_number",
    "collection_code", "collection_id",
  );

  // Guaranteed unique ID: prefer meaningful identifiers, fall back to DB id (always non-empty)
  const goodsId   = p.upc ?? p.vendorSku ?? anyVendorId ?? p.id;
  const productId = p.upc ?? p.vendorSku ?? anyVendorId ?? p.asin ?? verifiedAsin ?? p.id;

  // SKU columns must carry the SELLER'S OWN item code — never a GLOBAL product identifier.
  // A UPC/EAN/GTIN (barcode) and an ASIN (Amazon's id) both identify the product across
  // all sellers, so neither is a shop SKU. Vendor sheets frequently put an ASIN in a
  // column literally headed "SKU", which is how ASINs ended up in Mathis' shopSKU column.
  // Every candidate is therefore shape-checked and rejected if it is a barcode or an ASIN.
  const isGlobalId = (v: unknown): boolean => {
    const s = String(v ?? "").trim();
    return /^\d{8,14}$/.test(s) || ASIN_RE.test(s);
  };
  // Some sheets put a FIELD NAME in the cell instead of a value — the Mathis feed's
  // "sku" column literally reads "ASIN" on every row. Such placeholder text is not a
  // code and must never reach the SKU column; it is rejected so the next candidate wins.
  const isPlaceholder = (v: unknown): boolean =>
    /^(asin|upc|ean|gtin|sku|shop\s*sku|offer\s*sku|barcode|n\/?a|none|null|tbd|-{1,}|#n\/a)$/i
      .test(String(v ?? "").trim());
  //
  // shopSKU is a REQUIRED unique seller identifier, so it can never be blank. When the
  // vendor supplied no usable code, derive a readable one from the brand + barcode
  // (e.g. "TOV-644114") rather than emitting the opaque database cuid. It is stable —
  // the same product always derives the same code — so re-exports stay consistent.
  const derivedSku = (): string => {
    const brandPart = String(p.brand ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const barcode = String(p.upc ?? "").replace(/\D/g, "");
    const tail = barcode ? barcode.slice(-6) : String(p.id).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-6);
    return [brandPart, tail].filter(Boolean).join("-") || p.id;
  };
  const skuId = [p.vendorSku, anyVendorId].find(
    (v) => v != null && String(v).trim() !== "" && !isGlobalId(v) && !isPlaceholder(v),
  )
  // isGlobalId rejects barcode-format values (8-14 digit numbers) to avoid
  // using a UPC as a SKU when a real alphanumeric SKU exists elsewhere.
  // But if the vendor sheet only has a barcode in the SKU column, the
  // fallback was a fabricated "BRAND-123456" code that Walmart rejects.
  // Use the raw vendorSku as a last resort — it is the seller's own
  // identifier even if it happens to be numeric.
  ?? (p.vendorSku != null && String(p.vendorSku).trim() !== "" && !isPlaceholder(p.vendorSku)
    ? String(p.vendorSku).trim()
    : null)
  ?? derivedSku();

  // Vendor sheets often store HTML in description/features (<p>…</p>, <li>…</li>).
  // Walmart wants plain text, so strip tags and collapse whitespace. Bullet-style
  // <li> items become "; "-separated so key features stay readable.
  const stripHtml = (s: string): string =>
    s
      .replace(/<\s*li[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
      .split("").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join("; ")
      .replace(/\s+/g, " ")
      .trim();

  // ── Description / details — prefer vendor text, fall back to product name ──
  const descriptionRaw =
    p.description ||
    (fromVendor("description", "long_description", "details", "notes", "specs", "specifications") as string | undefined) ||
    p.name ||
    (fromLive("description") as string | undefined) ||
    "";
  const descriptionText = /<[a-z][\s\S]*>/i.test(descriptionRaw) ? stripHtml(descriptionRaw) : descriptionRaw;

  // Key features / bullet points — vendors store these as HTML <li> lists.
  const featuresRaw = String(
    fromVendor("features", "key_features", "product_features", "bullet_points", "highlights") ?? "",
  );
  const featuresText = /<[a-z][\s\S]*>/i.test(featuresRaw) ? stripHtml(featuresRaw) : featuresRaw;

  const coreMap: Record<string, unknown> = {
    // Name / Title
    name: p.name || fromLive("title") || "",
    title: p.name || fromLive("title") || "",
    product_name: p.name || fromLive("title") || "",
    item_name: p.name || fromLive("title") || "",

    // SKU fields — guaranteed non-empty
    sku: skuId, vendor_sku: skuId, seller_sku: skuId, merchant_sku: skuId, sku_id: skuId,
    shop_sku: skuId, shopsku: skuId, item_sku: skuId,

    // Variant grouping — UPC or vendor SKU used as the group identifier
    variant_group_code: p.upc ?? fromVendor("variant_group_code", "group_code", "style_no", "style_number", "style") ?? p.vendorSku ?? anyVendorId ?? "",
    variant_code: p.upc ?? p.vendorSku ?? anyVendorId ?? "",
    group_code: p.upc ?? p.vendorSku ?? anyVendorId ?? "",

    // Barcode IDs
    upc: p.upc ?? fromVendor("upc", "ean", "barcode", "gtin") ?? "",
    ean: p.upc ?? fromVendor("ean", "upc", "barcode", "gtin") ?? "",
    barcode: p.upc ?? fromVendor("barcode", "upc", "ean") ?? "",
    gtin: p.upc ?? fromVendor("gtin", "upc", "ean") ?? "",
    asin: p.asin ?? verifiedAsin ?? "",
    merchant_suggested_asin: p.asin ?? verifiedAsin ?? "",

    // Temu / marketplace generic IDs — guaranteed non-empty
    goods_id: goodsId,
    product_id: productId,

    // Amazon flat-file external ID — detect type from digit count (UPC-12, EAN-13, GTIN-14, ASIN)
    external_product_id: p.upc ?? fromVendor("upc", "ean", "barcode") ?? p.asin ?? verifiedAsin ?? "",
    external_product_id_type: (() => {
      const barcodeVal = String(p.upc ?? fromVendor("upc", "ean", "barcode") ?? "");
      if (barcodeVal) return detectUpcType(barcodeVal);
      if (p.asin || verifiedAsin) return "ASIN";
      return "";
    })(),
    product_id_type: (() => {
      const barcodeVal = String(p.upc ?? fromVendor("upc", "ean", "barcode") ?? "");
      if (barcodeVal) return detectUpcType(barcodeVal);
      if (p.asin || verifiedAsin) return "ASIN";
      return "";
    })(),

    // Listing actions
    listing_action: "Add",
    add_delete: "a",
    update_delete: "PartialUpdate",
    operation_type: "Update",

    // Status
    status: fromVendor("status", "item_status", "product_status", "active") ?? "on_sale",
    active: "Y",

    // Brand / Manufacturer / Trademark
    // Live data is authoritative: marketplace brand ("iStep") beats vendor company code ("APS").
    // Walmart uses brandName, Amazon/Keepa uses brand — check both.
    brand: (fromLive("brand") as string) || (fromLive("brandName") as string) || p.brand || (fromVendor("brand", "brand_name", "manufacturer", "maker", "trademark") as string) || "",
    brand_name: (fromLive("brand") as string) || (fromLive("brandName") as string) || p.brand || (fromVendor("brand", "brand_name", "manufacturer") as string) || "",
    manufacturer: (fromLive("brand") as string) || (fromLive("brandName") as string) || p.brand || (fromVendor("manufacturer", "brand", "maker") as string) || "",
    // Temu uses "Trademark" for the brand column
    trademark: (fromLive("brand") as string) || (fromLive("brandName") as string) || p.brand || (fromVendor("trademark", "brand", "brand_name", "manufacturer") as string) || "",

    // Description / Details — never empty (falls back to product name)
    description: descriptionText,
    product_description: descriptionText,
    details: descriptionText,
    long_description: descriptionText,
    // Bullet points — cover numbered ("Bullet Point 1") and unnumbered ("Bullet Points") variants
    bullet_point1: fromVendor("bullet_point1", "bullet_point_1", "bullet1", "feature1", "key_feature_1") ?? p.name ?? "",
    bullet_point2: fromVendor("bullet_point2", "bullet_point_2", "bullet2", "feature2", "key_feature_2") ?? "",
    bullet_point3: fromVendor("bullet_point3", "bullet_point_3", "bullet3", "feature3", "key_feature_3") ?? "",
    bullet_point4: fromVendor("bullet_point4", "bullet_point_4", "bullet4", "feature4") ?? "",
    bullet_point5: fromVendor("bullet_point5", "bullet_point_5", "bullet5", "feature5") ?? "",
    bullet_points: fromVendor("bullet_points", "bullet_point1", "bullet1", "feature1") ?? p.name ?? "",

    // Price
    price,
    standard_price: price,
    // A vendor MSRP of 0 means "not set" — blank it rather than writing a
    // meaningless 0 (and never fall back to selling price for MSRP).
    msrp: (() => {
      const v = fromVendor("msrp", "list_price", "retail_price");
      const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? String(n) : "";
    })(),
    sale_price: fromVendor("sale_price", "promo_price") ?? price,
    minimum_seller_allowed_price: fromVendor("min_price", "minimum_price", "map_price") ?? price,
    maximum_seller_allowed_price: fromVendor("max_price", "maximum_price") ?? "",

    // ── Amazon "Tag/Listing" loader (new-version) column labels ───────────────
    // This template stores its ROW-4 human labels as the template columns (row 4
    // and the row-5 field codes tie on cell count, and the uploader keeps the
    // first). Those labels normalise to keys that the generic aliases above don't
    // cover, so the offer price came out blank. Map the label forms explicitly.
    // "Your Price USD (…)" → normalises to "yourpriceusd" after the parenthetical
    // marketplace/audience suffix is stripped by normalizeKey.
    yourpriceusd: price,
    // NOTE: the B2B duplicate — "Your Price USD (Amazon Business (B2B), US)" —
    // is deliberately NOT mapped. Filling it enrolls every product in Amazon
    // Business B2B pricing, which is a seller decision, not a default; the
    // original template's sample row leaves it blank too. (Its label also
    // normalises to "yourpriceusdus" because of nested parentheses, so it would
    // need a separate key anyway.)
    // Fulfillment channel / shipping template are account-specific; default to the
    // merchant-fulfilled values from the template's own sample row.
    fulfillmentchannelcode: "Fulfillment by Merchant (Default)",
    shippingtemplate: "Default_Shipping Template",

    // Handling time — vendor lead time if present, else Amazon's own default (blank
    // = 2 days), so only emit when the vendor actually supplies it.
    handlingtime: fromVendor("handling_time", "lead_time", "fulfillment_latency", "ship_time") ?? "",

    // Dimension / weight UNITS. Amazon requires a unit whenever the paired value is
    // present, and a value-without-unit errors — the far more likely failure than a
    // unit sitting beside a blank value. Default to US customary; colVal clears any
    // unit whose paired value came out empty so we never emit a lone unit.
    itemweightunit: fromVendor("weight_unit", "item_weight_unit") ?? "Pounds",
    itemlengthunit: fromVendor("length_unit", "dimension_unit", "dim_unit") ?? "Inches",
    itemwidthunit: fromVendor("width_unit", "dimension_unit", "dim_unit") ?? "Inches",
    itemheightunit: fromVendor("height_unit", "dimension_unit", "dim_unit") ?? "Inches",
    packagelengthunit: fromVendor("length_unit", "dimension_unit", "dim_unit") ?? "Inches",
    packagewidthunit: fromVendor("width_unit", "dimension_unit", "dim_unit") ?? "Inches",
    packageheightunit: fromVendor("height_unit", "dimension_unit", "dim_unit") ?? "Inches",
    packageweightunit: fromVendor("weight_unit", "package_weight_unit") ?? "Pounds",

    // Package dimensions/weight — fall back to the item's own values so the
    // shipping block is populated when the vendor only gives item dimensions.
    itempackagelength: fromVendor("package_length", "shipping_length", "length", "item_length") ?? "",
    itempackagewidth: fromVendor("package_width", "shipping_width", "width", "item_width") ?? "",
    itempackageheight: fromVendor("package_height", "shipping_height", "height", "item_height") ?? "",

    // Images — Amazon "…Location" columns take a URL. Main = the product image;
    // the five "Other Image" columns are disambiguated by column position in
    // colVal (they all share the label "Other Image Location").
    mainimagelocation: p.imageUrl || fromVendor("image_url", "main_image", "image", "primary_image") || fromLive("image") || "",
    otherimagelocation: "", // resolved per-column in colVal from vendor image_url2..6

    // Offer condition note — only meaningful for non-New; left to vendor data.
    offerconditionnote: fromVendor("condition_note", "condition_comment") ?? "",

    // Condition & quantity
    item_condition: "New",
    condition: "New",
    condition_type: "New",
    condition_note: "",
    quantity: fromVendor("quantity", "qty", "stock", "inventory", "available_qty", "on_hand") ?? "1",
    fulfillment_latency: fromVendor("lead_time", "fulfillment_latency", "handling_time") ?? "",

    // Dimensions
    dimensions: fromVendor("dimensions", "dims", "size", "product_size") ?? "",
    length: fromVendor("length", "item_length") ?? "",
    width: fromVendor("width", "item_width") ?? "",
    height: fromVendor("height", "item_height", "depth") ?? "",
    weight: fromVendor("weight", "item_weight", "unit_weight") ?? "",

    // Product-page URL — Walmart "product link"/URL columns must be the listing
    // page (https://www.walmart.com/ip/...), NOT the image URL.
    product_url: productPageUrl,
    product_page_url: productPageUrl,
    product_link: productPageUrl,
    listing_url: productPageUrl,
    item_url: productPageUrl,
    item_page_url: productPageUrl,
    buy_url: productPageUrl,
    site_product_link: productPageUrl,
    url: productPageUrl,

    // Image — covers generic keys and Mathis-specific names
    image_url: p.imageUrl || fromLive("image") || "",
    imageurl: p.imageUrl || fromLive("image") || "",
    main_image_url: p.imageUrl || fromLive("image") || "",
    // Image 1 / SILO: product's own image, else the first catalog/vendor image column.
    silo_image: p.imageUrl || fromVendor("silo_image", "silo image", "image_url_1", "image url 1", "image_url", "main_image", "hero_image", "primary_image") || fromLive("image") || "",
    image_1: p.imageUrl || fromVendor("image_url_1", "image url 1", "silo_image", "image_url") || fromLive("image") || "",
    image1: p.imageUrl || fromVendor("image_url_1", "image url 1", "silo_image", "image_url") || fromLive("image") || "",
    // Numbered images: catalog enrichment stores "Image URL N" (→ normalizes to imageurln,
    // same as "image_url_n" and "imageN"), so all three alias forms are checked.
    other_image_url1: fromVendor("image_url_2", "image url 2", "image_url2", "other_image_url1", "alternate_image1") ?? "",
    image_2: fromVendor("image_url_2", "image url 2", "image_url2", "image2", "product_image_2_url") ?? "",
    image_3: fromVendor("image_url_3", "image url 3", "image_url3", "image3", "product_image_3_url") ?? "",
    image_4: fromVendor("image_url_4", "image url 4", "image_url4", "image4", "product_image_4_url") ?? "",
    image_5: fromVendor("image_url_5", "image url 5", "image_url5", "image5", "product_image_5_url") ?? "",
    product_image_2_url: fromVendor("product_image_2_url", "image_url_2", "image url 2", "image_url2", "image2", "alternate_image1", "secondary_image") ?? "",
    product_image_3_url: fromVendor("product_image_3_url", "image_url_3", "image url 3", "image_url3", "image3", "alternate_image2") ?? "",
    product_image_4_url: fromVendor("product_image_4_url", "image_url_4", "image url 4", "image_url4", "image4", "alternate_image3") ?? "",
    product_image_5_url: fromVendor("product_image_5_url", "image_url_5", "image url 5", "image_url5", "image5", "alternate_image4") ?? "",
    product_image_6_url: fromVendor("product_image_6_url", "image_url_6", "image url 6", "image_url6", "image6", "alternate_image5") ?? "",
    product_image_7_url: fromVendor("product_image_7_url", "image_url_7", "image url 7", "image_url7", "image7", "alternate_image6") ?? "",
    product_image_8_url: fromVendor("product_image_8_url", "image_url_8", "image url 8", "image_url8", "image8", "alternate_image7") ?? "",
    product_image_9_url: fromVendor("product_image_9_url", "image_url_9", "image url 9", "image_url9", "image9", "alternate_image8") ?? "",
    product_image_10_url: fromVendor("product_image_10_url", "image_url_10", "image url 10", "image_url10", "image10", "alternate_image9") ?? "",

    // Walmart "Spec Product Type" — AI-assigned from the official Walmart PT
    // taxonomy (runs for both new-listing and item-match projects). Falls back to
    // the Affiliate API categoryPath leaf (live product data → accurate leaf name).
    // Do NOT fall back to marketplaceCategory: those are high-level buckets like
    // "Clothing" or "Furniture" which are wrong at the product-type granularity
    // that column D expects — blank is better than an invalid value.
    specproducttype: (p as { specProductType?: string | null }).specProductType
      || (p as { categoryPath?: string | null }).categoryPath?.split(" > ").at(-1)
      || "",
    spec_product_type: (p as { specProductType?: string | null }).specProductType
      || (p as { categoryPath?: string | null }).categoryPath?.split(" > ").at(-1)
      || "",

    // ── Walmart new-listing template field codes (row 5) ──────────────────────
    // These are the exact camelCase codes the "New listing" template uses; they
    // don't normalize-match the snake_case coreMap keys, so map them explicitly
    // from this vendor sheet's columns (and common variants).
    productname: p.name || fromVendor("title", "product_name", "name") || "",
    productidtype: p.upc ? (String(p.upc).replace(/\D/g, "").length === 13 ? "EAN" : "UPC") : "",
    productid: p.upc || fromVendor("upc", "ean", "gtin", "barcode") || "",
    countryoforiginsubstantialtransformation:
      fromVendor("origin", "country_of_origin", "country", "made_in", "coo") ?? "",
    shortdescription: descriptionText || "",
    keyfeatures: featuresText,
    mainimageurl: p.imageUrl || fromVendor("imageurl", "image_url", "main_image", "image") || fromLive("image") || "",
    productsecondaryimageurl:
      fromVendor("imageurl1", "image_url1", "additional_image_url", "other_image_url1", "image_url2") ?? "",
    modelnumber: fromVendor("model", "model_number", "model_no", "mpn") ?? "",
    colorcategory: fromVendor("color_category", "color", "colour") ?? "",
    manufacturername: fromVendor("manufacturer", "brand", "maker", "branch") ?? p.brand ?? "",

    // Category — filled from AI categorisation; blank for "Uncategorized" so no junk text in the cell
    category: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    category_name: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    feed_product_type: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    item_type: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    item_type_name: p.categoryPath ?? ((p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : ""),
    category_path: p.categoryPath ?? ((p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : ""),
    browse_node: p.categoryPath ?? "",
    product_type: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",

    // Temu listing-type field: "Goods type" / "goods_type" on the Temu template is the
    // listing format selector (Normal product / Custom product), NOT the category.
    // Setting it to the AI category path lets the colVal Temu coercion intercept " > "
    // and replace with "Normal product" — the correct value for standard listings.
    goods_type: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    // Temu packaging fields — vendor data is used when present; otherwise left blank
    // for the seller to fill in on Temu's portal.
    packaging_unit: fromVendor("packaging_unit", "pack_unit", "unit_type") ?? "",
    total_packaging_quantity: fromVendor("total_packaging_quantity", "packaging_quantity", "pack_quantity") ?? "",
    net_content: fromVendor("net_content", "unit_count", "quantity_per_package") ?? "",
    individually_packed: fromVendor("individually_packed", "individual_pack") ?? "",
    sku_type: fromVendor("sku_type", "goods_type", "product_kind") ?? "",

    // Temu-specific technique fields — pass through vendor data if present
    customization_processing_technique: fromVendor("customization_processing_technique", "processing_technique", "technique") ?? "",
    primary_technique: fromVendor("primary_technique", "technique", "process") ?? "",
    secondary_technique: fromVendor("secondary_technique", "secondary_process") ?? "",
    customization_option: fromVendor("customization_option", "customization") ?? "",

    // More name/title aliases
    product_title: p.name || fromLive("title") || "",
    display_name: p.name || fromLive("title") || "",
    short_name: p.name || "",

    // Short / long description aliases
    short_description: (descriptionText || "").slice(0, 200),
    short_desc: (descriptionText || "").slice(0, 200),
    full_description: descriptionText,
    product_features: featuresText || descriptionText,
    features: featuresText || descriptionText,
    key_features: featuresText || descriptionText,
    shelf_description: descriptionText,
    site_description: descriptionText,

    // Search / keywords
    keywords: fromVendor("keywords", "tags", "search_terms", "meta_keywords") ?? "",
    tags: fromVendor("tags", "keywords", "search_terms") ?? "",
    search_terms: fromVendor("search_terms", "keywords", "tags") ?? "",

    // Price / cost aliases
    retail_price: fromVendor("retail_price", "msrp", "list_price", "rrp", "suggested_retail_price") ?? price,
    map_price: fromVendor("map_price", "minimum_advertised_price", "min_price", "map") ?? price,
    cost: fromVendor("cost", "cost_price", "wholesale_price", "vendor_price", "net_price") ?? "",
    wholesale: fromVendor("wholesale", "wholesale_price", "cost_price", "net_price") ?? "",

    // Dimension aliases (many retailer templates use "Item Width" etc.)
    item_length: fromVendor("length", "item_length", "product_length") ?? "",
    item_width: fromVendor("width", "item_width", "product_width") ?? "",
    item_height: fromVendor("height", "item_height", "product_height", "depth") ?? "",
    item_depth: fromVendor("depth", "item_depth", "height") ?? "",
    item_weight: fromVendor("weight", "item_weight", "product_weight", "unit_weight") ?? "",
    product_length: fromVendor("length", "item_length", "product_length") ?? "",
    product_width: fromVendor("width", "item_width", "product_width") ?? "",
    product_height: fromVendor("height", "item_height", "product_height") ?? "",
    product_weight: fromVendor("weight", "item_weight", "product_weight") ?? "",
    package_weight: fromVendor("package_weight", "shipping_weight", "gross_weight") ?? "",
    // Vendor sheets label this many ways; fall back to the item/product weight
    // so a sheet that only carries a plain "Weight" column still populates
    // Walmart's required Shipping Weight instead of exporting blank.
    shipping_weight: fromVendor(
      "shipping_weight", "package_weight", "gross_weight",
      "ship_weight", "shipweight", "weight", "item_weight", "product_weight",
      "unit_weight", "weight_lbs", "weight_lb", "wt",
    ) ?? "",
    depth: fromVendor("depth", "item_depth", "height") ?? "",

    // Color / finish / attribute aliases
    primary_color: fromVendor("color", "colour", "primary_color", "color_name", "finish") ?? "",
    colour: fromVendor("colour", "color", "color_name") ?? "",
    color_name: fromVendor("color", "colour", "color_name") ?? "",
    finish: fromVendor("finish", "color", "colour", "surface_finish") ?? "",
    material_type: fromVendor("material", "materials", "material_type", "fabric", "fabric_type") ?? "",
    fabric: fromVendor("fabric", "material", "materials", "fabric_type") ?? "",
    product_type_keyword: p.marketplaceCategory ?? fromVendor("product_type", "item_type") ?? "",
    item_type_keyword: p.marketplaceCategory ?? fromVendor("item_type", "product_type") ?? "",

    // Misc
    merchant_catalog_number: skuId,
    unspsc_code: fromVendor("unspsc_code", "unspsc") ?? "",
    national_stock_number: fromVendor("national_stock_number", "nsn") ?? "",
    country_of_origin: fromVendor("country_of_origin", "country", "made_in", "origin") ?? "",
    material: fromVendor("material", "materials", "fabric", "composition") ?? "",
    color: fromVendor("color", "colour", "color_name") ?? "",
    size: fromVendor("size", "item_size", "dimensions") ?? "",
    age_group: fromVendor("age_group", "age", "age_range") ?? "",
    gender: fromVendor("gender", "target_gender") ?? "",
    pack_size: fromVendor("pack_size", "pack", "pieces_per_pack", "units_per_pack", "qty_per_pack") ?? "",

    // Furniture / lifestyle (Mathis Brothers and similar)
    assembly_required: fromVendor("assembly_required", "assembly", "requires_assembly", "self_assembly") ?? "",
    warranty: fromVendor("warranty", "warranty_description", "warranty_period", "warranty_info") ?? "",
    warranty_description: fromVendor("warranty_description", "warranty", "warranty_info") ?? "",
    collection: fromVendor("collection", "collection_name", "product_collection", "series") ?? "",
    style: fromVendor("style", "design_style", "furniture_style") ?? "",
    number_of_pieces: fromVendor("pieces", "number_of_pieces", "set_pieces", "quantity_per_set") ?? "",
    pieces: fromVendor("pieces", "number_of_pieces") ?? "",

    // "# of Pieces" → normalizes to "of_pieces" after stripping "#"
    of_pieces: fromVendor("pieces", "number_of_pieces", "set_pieces", "quantity_per_set") ?? "",

    // "Item #" and "Item Number" → normalizes to "item" / "item_number" → map to SKU
    item: skuId,
    item_number: skuId,

    // Retail-specific price labels
    net_price: fromVendor("net_price", "cost", "cost_price", "wholesale_price", "vendor_price") ?? "",
    list_price: fromVendor("list_price", "msrp", "retail_price", "rrp") ?? price,
    map: fromVendor("map", "map_price", "minimum_advertised_price", "min_price") ?? "",

    // Image aliases used in furniture/lifestyle templates
    lifestyle_image: fromVendor("lifestyle_image", "lifestyle_image_url", "room_scene", "room_image") || fromLive("image") || "",
    room_scene: fromVendor("room_scene", "room_scene_url", "lifestyle_image", "room_image") || fromLive("image") || "",
    hero_image: p.imageUrl || fromVendor("hero_image", "hero_image_url", "main_image", "silo_image", "image_url") || fromLive("image") || "",
    additional_image_1: fromVendor("additional_image_1", "alternate_image_1", "image_url2", "image2", "other_image1") ?? "",
    additional_image_2: fromVendor("additional_image_2", "alternate_image_2", "image_url3", "image3", "other_image2") ?? "",
    additional_image_3: fromVendor("additional_image_3", "alternate_image_3", "image_url4", "image4", "other_image3") ?? "",
    product_image_1_url: p.imageUrl || fromVendor("silo_image", "silo image", "main_image_url", "image_url", "image") || fromLive("image") || "",

    // Fabric / upholstery specific
    seat_material: fromVendor("seat_material", "seat_fabric", "upholstery_material", "fabric", "material") ?? "",
    frame_material: fromVendor("frame_material", "frame", "frame_type") ?? "",
    leg_material: fromVendor("leg_material", "legs", "leg_type") ?? "",
    fill_material: fromVendor("fill_material", "fill", "cushion_fill") ?? "",

    // Shipping / packaging
    package_length: fromVendor("package_length", "carton_length", "box_length") ?? "",
    package_width: fromVendor("package_width", "carton_width", "box_width") ?? "",
    package_height: fromVendor("package_height", "carton_height", "box_height") ?? "",

    // Misc Mathis fields
    finish_color: fromVendor("finish_color", "finish", "color", "colour") ?? "",
    seat_height: fromVendor("seat_height", "seat_h") ?? "",
    arm_height: fromVendor("arm_height", "arm_h") ?? "",
    seat_depth: fromVendor("seat_depth", "seat_d") ?? "",
    seat_width: fromVendor("seat_width", "seat_w") ?? "",
    min_height: fromVendor("min_height", "minimum_height", "collapsed_height") ?? "",
    max_height: fromVendor("max_height", "maximum_height", "extended_height") ?? "",
    number_of_drawers: fromVendor("number_of_drawers", "drawers", "num_drawers", "drawer_count") ?? "",
    number_of_shelves: fromVendor("number_of_shelves", "shelves", "num_shelves", "shelf_count") ?? "",
    number_of_doors: fromVendor("number_of_doors", "doors", "num_doors", "door_count") ?? "",

    // ── Walmart / Best Buy / multi-marketplace fields ────────────────────────
    // Manufacturer Part Number — universal across Walmart, Best Buy, Amazon
    mpn: fromVendor("mpn", "mfr_part_number", "manufacturer_part_number", "model_number", "model_no", "part_number") ?? "",
    manufacturer_part_number: fromVendor("manufacturer_part_number", "mpn", "mfr_part_number", "part_number", "model_number") ?? "",
    mfr_part_number: fromVendor("mpn", "mfr_part_number", "manufacturer_part_number", "model_number") ?? "",
    model_number: fromVendor("model_number", "model_no", "mpn", "model", "part_number") ?? "",
    model_name: fromVendor("model_name", "model", "model_number") ?? "",

    // Walmart-specific operational fields (safe defaults for new listings)
    fulfillment_type: fromVendor("fulfillment_type", "fulfillment", "shipping_type") ?? "3P",
    is_bundle: fromVendor("is_bundle", "bundle", "is_set") ?? "No",
    is_adult_product: fromVendor("is_adult", "is_adult_product", "adult") ?? "No",
    is_gift_wrap_available: fromVendor("gift_wrap", "is_gift_wrap_available") ?? "No",
    is_gift_message_available: fromVendor("gift_message", "is_gift_message_available") ?? "No",
    tax_code: fromVendor("tax_code", "tax_category", "tax_class") ?? "",
    site_start_date: fromVendor("site_start_date", "start_date", "launch_date") ?? "",
    site_end_date: fromVendor("site_end_date", "end_date") ?? "",
    ship_node: fromVendor("ship_node", "warehouse", "location") ?? "",
    multi_pack_quantity: fromVendor("multi_pack_quantity", "pack_size", "pack", "pieces_per_pack") ?? "1",
    minimum_order_quantity: fromVendor("minimum_order_quantity", "min_order_qty", "min_qty", "moq") ?? "1",

    // Compliance / regulatory (Mathis Prop-65, general marketplace compliance)
    prop_65: fromVendor("prop_65", "prop65", "california_prop_65", "proposition_65") ?? "",
    prop_65_chemical: fromVendor("prop_65_chemical", "chemical_name", "prop65_chemical") ?? "",
    made_in_usa: fromVendor("made_in_usa", "made_in_u_s_a", "us_made", "domestic") ?? "",
    flammability: fromVendor("flammability", "flammability_standard", "fire_rating") ?? "",
    certifications: fromVendor("certifications", "certification", "safety_certification") ?? "",

    // Best Buy / electronics-specific
    wireless: fromVendor("wireless", "is_wireless", "wifi", "bluetooth") ?? "",
    battery_life: fromVendor("battery_life", "battery_hours", "runtime") ?? "",
    connectivity: fromVendor("connectivity", "connection_type", "interface") ?? "",
    resolution: fromVendor("resolution", "display_resolution", "screen_resolution") ?? "",
    screen_size: fromVendor("screen_size", "display_size", "screen_diagonal") ?? "",
    storage_capacity: fromVendor("storage_capacity", "storage", "hard_drive", "memory") ?? "",
    processor: fromVendor("processor", "cpu", "processor_type", "chip") ?? "",
    operating_system: fromVendor("operating_system", "os") ?? "",

    // Temu / apparel / lifestyle
    pattern: fromVendor("pattern", "pattern_type", "print") ?? "",
    occasion: fromVendor("occasion", "use_occasion", "application") ?? "",
    season: fromVendor("season", "seasons") ?? "",
    room_type: fromVendor("room_type", "room", "room_style") ?? "",
    shape: fromVendor("shape", "product_shape") ?? "",
    closure_type: fromVendor("closure_type", "closure", "fastening") ?? "",
    care_instructions: fromVendor("care_instructions", "care", "washing_instructions", "cleaning") ?? "",
    number_of_items: fromVendor("number_of_items", "items_per_set", "pieces", "number_of_pieces") ?? "",
    voltage: fromVendor("voltage", "operating_voltage", "power_supply") ?? "",
    wattage: fromVendor("wattage", "power_watts", "watts") ?? "",

    // ── Walmart template column aliases ─────────────────────────────────────
    // "ProductId1" / "Product Id 1" → external product ID value (UPC/GTIN)
    product_id_1: p.upc ?? fromVendor("upc", "ean", "gtin", "barcode") ?? "",
    product_id_type_1: (() => {
      const b = String(p.upc ?? fromVendor("upc", "ean", "barcode") ?? "");
      return b ? detectUpcType(b) : "UPC";
    })(),
    // "ProductCategory" / "Product Category" → AI-assigned category
    product_category: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    // "Short Title" — Walmart limits item titles to 75 chars in some feeds
    short_title: (p.name || (fromLive("title") as string) || "").slice(0, 75),
    // Compliance / geo restrictions — usually empty for standard listings
    state_restrictions: fromVendor("state_restrictions", "staterestrictions") ?? "",
    states: fromVendor("states", "restricted_states", "state_list") ?? "",
    zip_codes: fromVendor("zip_codes", "zipcodes", "zip_code_list") ?? "",
    // Product attribute pairs (Walmart uses these for spec bullets)
    product_attribute_1_name: fromVendor("product_attribute_1_name", "attribute_1_name", "attr1_name", "attribute_name_1") ?? "",
    product_attribute_1_value: fromVendor("product_attribute_1_value", "attribute_1_value", "attr1_value", "attribute_value_1") ?? "",
    product_attribute_2_name: fromVendor("product_attribute_2_name", "attribute_2_name", "attr2_name", "attribute_name_2") ?? "",
    product_attribute_2_value: fromVendor("product_attribute_2_value", "attribute_2_value", "attr2_value", "attribute_value_2") ?? "",
    product_attribute_3_name: fromVendor("product_attribute_3_name", "attribute_3_name", "attr3_name") ?? "",
    product_attribute_3_value: fromVendor("product_attribute_3_value", "attribute_3_value", "attr3_value") ?? "",
    // Additional / offer attributes
    additional_attribute_1_name: fromVendor("additional_attribute_1_name", "additional_1_name", "add_attr_1_name") ?? "",
    additional_attribute_1_value: fromVendor("additional_attribute_1_value", "additional_1_value", "add_attr_1_value") ?? "",
    additional_attribute_2_name: fromVendor("additional_attribute_2_name", "additional_2_name") ?? "",
    additional_attribute_2_value: fromVendor("additional_attribute_2_value", "additional_2_value") ?? "",
    offer_attribute_name: fromVendor("offer_attribute_name", "offer_attr_name") ?? "",
    offer_attribute_value: fromVendor("offer_attribute_value", "offer_attr_value") ?? "",
    // Generic "Value" column that appears in some Walmart offer sheets
    value: fromVendor("value", "offer_attribute_value", "attribute_value") ?? "",

    // ── Sears-specific column mappings ──────────────────────────────────────
    // "Item ID" → seller's item SKU
    item_id: skuId,
    // "Permanent Product ID" → UPC/barcode
    permanent_product_id: p.upc ?? fromVendor("upc", "ean", "gtin", "barcode") ?? "",
    // "Item Class ID" → Sears category numeric ID (from vendor data if present)
    item_class_id: fromVendor("item_class_id", "class_id", "category_id", "itemclassid") ?? "",
    // "Item Class Display Path" → AI-assigned category path (the main category output)
    item_class_display_path: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    // "Action Flag" → "A" = Add/Update
    action_flag: fromVendor("action_flag", "actionflag") ?? "A",
    // "FBS Item" → Fulfilled By Sears — default N
    fbs_item: fromVendor("fbs_item", "fbsitem") ?? "N",
    // "Variation Group ID" → group variants by UPC or SKU
    variation_group_id: p.upc ?? p.vendorSku ?? anyVendorId ?? "",
    // "Seller Categories" → AI-assigned category
    seller_categories: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    // "Packing Slip Description" → product name
    packing_slip_description: p.name ?? "",

    // ── Mathis / Mirakl OFFER block (mandatory columns) ─────────────────────
    // These are the pink required columns in the Mathis template. Their field codes
    // are generic Mirakl offer keys, so they normalize to these names. Filled with the
    // seller SKU / IDs / price / a sensible new-in-stock offer so the row imports.
    offer_sku: skuId,
    "product-id": p.upc ?? skuId,
    product_id_value: p.upc ?? skuId,
    "product-id-type": p.upc ? detectUpcType(String(p.upc)) : "SKU",
    product_id_type_value: p.upc ? detectUpcType(String(p.upc)) : "SKU",
    offer_description: descriptionText || p.name || "",
    "offer-description": descriptionText || p.name || "",
    offer_internal_description: fromVendor("offer_internal_description", "internal_description", "internal_notes") ?? "",
    "internal-description": fromVendor("offer_internal_description", "internal_description") ?? "",
    // Price: vendor price → live price → blank (seller fills). Never a wrong guess.
    offer_price: p.price ?? fromVendor("price", "retail_price", "map", "msrp", "list_price") ?? "",
    "offer-price": p.price ?? fromVendor("price", "retail_price", "map", "msrp") ?? "",
    offer_price_additional_info: fromVendor("offer_price_additional_info", "price_additional_info") ?? "",
    "price-additional-info": fromVendor("offer_price_additional_info", "price_additional_info") ?? "",
    offer_quantity: fromVendor("offer_quantity", "quantity", "qty", "stock", "inventory", "available_quantity") ?? "1",
    minimum_quantity_alert: fromVendor("minimum_quantity_alert", "min_quantity_alert", "min_alert") ?? "",
    "min-quantity-alert": fromVendor("minimum_quantity_alert", "min_quantity_alert") ?? "",
    // Offer state: Mirakl condition code — "11" = New (the standard new-condition value).
    offer_state: fromVendor("offer_state", "condition", "state", "item_condition") ?? "11",
    logistic_class: fromVendor("logistic_class", "logistic-class", "shipping_class") ?? "",
    "logistic-class": fromVendor("logistic_class", "shipping_class") ?? "",
    lead_time_to_ship: fromVendor("lead_time_to_ship", "lead_time", "leadtime", "ship_days", "handling_time") ?? "",
    update_delete_flag: fromVendor("update_delete", "update-delete", "action") ?? "new",

    // ── Mathis RUG attribute columns ────────────────────────────────────────
    // Catalog enrichment stored size/color/etc. in vendorData under these labels; the
    // rest fall back to sensible rug defaults so the mandatory attribute cells aren't
    // blank (a rug IS rectangular, machine-woven, indoor unless stated otherwise).
    rug_size: fromVendor("rug_size", "size", "dimensions") ?? "",
    rug_shape: fromVendor("rug_shape", "shape") ?? "Rectangular",
    rug_material: fromVendor("rug_material", "material", "fabric", "composition") ?? "",
    rug_style: fromVendor("rug_style", "style") ?? "",
    rug_design: fromVendor("rug_design", "design", "pattern") ?? "",
    rug_type: fromVendor("rug_type", "type") ?? "",
    rug_origin: fromVendor("rug_origin", "origin", "country_of_origin", "made_in") ?? "",
    casing_finish_color: fromVendor("finish_color", "casing_finish_color") ?? "",
  };

  // Build normalized lookup (coreMap keys use underscores; column labels may not)
  // e.g. "shipping_weight" → "shippingweight" so "ShippingWeight" column finds it.
  // Cached per product: coreMap is identical for every column of the same product.
  const coreNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(coreMap)) coreNorm.set(normalizeKey(k), v);
  _coreNormCache.set(p, coreNorm);
  if (coreNorm.has(nk)) return coreNorm.get(nk);
  // Unit-suffix fallback: "lengthin" → try "length", "widthcm" → try "width", etc.
  if (bareNk && coreNorm.has(bareNk)) return coreNorm.get(bareNk);

  return lookupVendorAndLive(nk, bareNk, key, vd, vdNorm, ld);
}

/**
 * vendorData + liveData fallback lookup, shared by the cached and uncached paths of
 * getProductField. Runs only when the coreMap didn't already resolve the column.
 */
function lookupVendorAndLive(
  nk: string,
  bareNk: string | null,
  key: string,
  vd: Record<string, unknown> | null,
  vdNorm: Map<string, unknown> | null,
  ld: Record<string, unknown> | null,
): unknown {
  if (vd && vdNorm) {
    // Exact key match
    if (key in vd) { const v = vd[key]; if (v !== "" && v != null) return v; }
    // O(1) normalized key match via cache
    const normV = vdNorm.get(nk);
    if (normV !== undefined) return normV;
    // Unit-suffix fallback for vendorData too: vendor key "length" matches column "Length - in"
    if (bareNk) { const v = vdNorm.get(bareNk); if (v !== undefined) return v; }

    // Numbered image/photo field: collect ALL image-URL-like keys from vendorData sorted,
    // then return the nth one. e.g. "product_image_3_url" → n=3 → 3rd image key.
    if (nk.includes("image") || nk.includes("photo") || nk.includes("img")) {
      const imgNum = nk.match(/(\d+)/)?.[1];
      if (imgNum) {
        const n = parseInt(imgNum, 10);
        const imgKeys = Object.keys(vd)
          .filter((k) => { const nv = normalizeKey(k); return nv.includes("image") || nv.includes("photo") || nv.includes("img"); })
          .sort();
        const pick = imgKeys[n - 1];
        if (pick) { const v = vd[pick]; if (v !== "" && v != null) return v; }
      }
    }

    // Word-overlap fuzzy match — score ≥ 3 avoids false positives.
    // +2 for each template word found in vendorData key, +1 for the reverse direction.
    const nkWords = nk.split("_").filter((w) => w.length > 2);
    if (nkWords.length >= 2) {
      let fuzzyKey: string | undefined;
      let bestScore = 0;
      for (const vdKey of Object.keys(vd)) {
        const vdWords = normalizeKey(vdKey).split("_").filter((w) => w.length > 2);
        let score = 0;
        for (const w of nkWords) if (vdWords.includes(w)) score += 2;
        for (const w of vdWords) if (nkWords.includes(w)) score += 1;
        if (score > bestScore) { bestScore = score; fuzzyKey = vdKey; }
      }
      if (fuzzyKey && bestScore >= 3) { const v = vd[fuzzyKey]; if (v !== "" && v != null) return v; }
    }
  }

  // Last resort: normalized key match against liveData
  if (ld) {
    const ldHit = Object.keys(ld).find((k) => normalizeKey(k) === nk);
    if (ldHit) { const v = ld[ldHit]; if (v !== "" && v != null) return v; }
  }

  return "";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detect whether a barcode string is UPC-A (12 digits), EAN-8/13, GTIN-14, or ASIN.
 * Returns the correct identifier type string for use in marketplace templates.
 */
function detectUpcType(raw: string): "UPC" | "EAN" | "GTIN" | "ASIN" | "" {
  if (!raw) return "";
  const s = String(raw).trim();
  if (/^B[0-9A-Z]{9}$/i.test(s)) return "ASIN";
  const digits = s.replace(/\D/g, "");
  if (digits.length === 8)  return "EAN";
  if (digits.length === 12) return "UPC";
  if (digits.length === 13) return "EAN";
  if (digits.length === 14) return "GTIN";
  return "UPC";
}

/**
 * Pick the best matching value from an Excel dropdown option list.
 * Preference order:
 *   1. exact (case-insensitive, punctuation-insensitive)
 *   2. whole-WORD overlap — the raw value contains the option as a distinct word
 *      (or vice-versa). This is word-boundary aware, so "used - like new" matches
 *      "Used" (a whole word) and does NOT falsely match "New" via the trailing
 *      "...new". Ties are broken by longer option, then earlier word position.
 *   3. collapsed substring — last-resort loose containment
 * Falls back to the original value (Excel flags it invalid) when nothing matches.
 */
/**
 * Deterministically map a value onto one of a dropdown's allowed options.
 * Returns null when no option is a defensible match, so the caller can hand the
 * value to the AI matcher instead of writing a value the marketplace will reject.
 */
function pickDropdownValue(raw: string, options: string[]): string | null {
  if (!raw || !options.length) return raw;
  const collapse = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  const collapsedRaw = collapse(raw);
  // 1. Exact (punctuation-insensitive)
  const exact = options.find((o) => collapse(o) === collapsedRaw);
  if (exact) return exact;

  // 2. Whole-word overlap, scored
  const rawWords = words(raw);
  const rawWordSet = new Set(rawWords);
  let best: string | null = null;
  let bestScore = -1;
  for (const o of options) {
    const optWords = words(o);
    if (!optWords.length) continue;
    // How many of the option's words appear as whole words in the raw value…
    const optInRaw = optWords.filter((w) => rawWordSet.has(w)).length;
    // …and vice-versa (raw words appearing in the option)
    const optWordSet = new Set(optWords);
    const rawInOpt = rawWords.filter((w) => optWordSet.has(w)).length;
    const overlap = optInRaw + rawInOpt;
    if (overlap === 0) continue;
    // Earliest matching word position in the raw string (lower = better)
    const pos = optWords.reduce((min, w) => {
      const i = rawWords.indexOf(w);
      return i >= 0 && i < min ? i : min;
    }, Number.MAX_SAFE_INTEGER);
    // Score: overlap dominates, then earlier position, then longer option
    const score = overlap * 1000 - pos * 10 + collapse(o).length;
    if (score > bestScore) { bestScore = score; best = o; }
  }
  if (best) return best;

  // 3. Collapsed substring (loose) — either direction
  const sub = options.find((o) => {
    const c = collapse(o);
    return c && (c.includes(collapsedRaw) || collapsedRaw.includes(c));
  });
  if (sub) return sub;

  // No defensible match. Returning the raw value here would write a value that is not
  // in the list, which the marketplace rejects — signal failure so the AI matcher runs.
  return null;
}

// Collapse an INDIRECT() formula that concatenates string literals into the
// single string it evaluates to, so it can be looked up as a defined name.
//   INDIRECT("PRODUCT"&"country_of_origin1.value") → PRODUCTcountry_of_origin1.value
// Only pure string-literal concatenation is evaluated (Amazon's pattern); any
// formula containing cell/name references is left untouched for the caller to
// resolve (or fail) as before. Non-INDIRECT formulas pass straight through.
function evalIndirectConcat(formula: string): string {
  const inner = formula.match(/^INDIRECT\s*\(([\s\S]*)\)$/i)?.[1];
  if (inner == null) return formula;
  const parts = inner.split("&").map((s) => s.trim());
  // Every part must be a quoted string literal, else we can't evaluate it safely.
  if (!parts.every((p) => /^"[^"]*"$/.test(p))) return formula;
  return parts.map((p) => p.slice(1, -1)).join("");
}

function normalizeKey(s: string): string {
  return s.toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, "")    // strip parenthetical annotations: (in), (Y/N), (lbs), etc.
    .replace(/#/g, "")                   // strip "#" — "Style #" → "style", "Item #" → "item"
    .replace(/[^a-z0-9]+/g, "");        // strip ALL non-alphanumeric — makes "product_id_1" == "ProductId1" == "product id 1"
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_");
}

function x(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── Single-file unwrapping ───────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};

export type ExportPayload = {
  buffer: Buffer;
  extension: string;
  contentType: string;
  /** Original entry name when the ZIP was unwrapped; null when kept as a ZIP. */
  innerName: string | null;
};

/**
 * Serve a one-file export as that file, not as a ZIP containing it.
 *
 * Marketplaces that produce a single sheet (Walmart always does — one template,
 * one output) previously delivered a ZIP the user had to unpack to reach the
 * one spreadsheet inside. When the archive holds exactly one entry, hand back
 * that entry directly; multi-file exports are returned untouched.
 */
export async function unwrapSingleFileZip(zipBuffer: Buffer): Promise<ExportPayload> {
  const asZip: ExportPayload = {
    buffer: zipBuffer,
    extension: "zip",
    contentType: "application/zip",
    innerName: null,
  };
  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = Object.values(zip.files).filter((f) => !f.dir);
    if (entries.length !== 1) return asZip;

    const only = entries[0];
    const ext = (only.name.split(".").pop() ?? "").toLowerCase();
    // Only unwrap formats we can label correctly — an unknown extension is
    // safer left inside the ZIP than served with a wrong content type.
    if (!MIME_BY_EXT[ext]) return asZip;

    return {
      buffer: await only.async("nodebuffer"),
      extension: ext,
      contentType: MIME_BY_EXT[ext],
      innerName: only.name,
    };
  } catch {
    // Unreadable archive — pass the original through rather than failing the export.
    return asZip;
  }
}
