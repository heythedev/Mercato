import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

// Walmart categorization has three category layers:
//
//   1. The RAW taxonomy (walmart_taxonomy_raw.json) — Walmart's official item
//      taxonomy (the GET /v3/items/taxonomy response saved to disk):
//      Category > Product Type Group > Product Type, with departments. This is
//      the preferred source: it drives BOTH rich categorization paths
//      ("Category > Product Type Group") and the valid Spec Product Type list.
//
//   2. The RICH CSV (walmart_categories.csv) — legacy optional multi-level
//      paths. Used only when the raw JSON is absent.
//
//   3. The TEMPLATE list (walmart_template_categories.csv) — the 75 flat values
//      the "MP Item Setup by Match" template's Product Category dropdown
//      actually accepts. This is the authoritative EXPORT target: any value not
//      in this list is rejected on import, so a rich category is always mapped
//      down to one of these before it reaches the sheet.
//
// Modelled on temu-taxonomy.ts (mtime-cached, disk-reload) so a data-file swap
// needs no server restart.

const DATA_DIR = "src/lib/ai/data";
const RAW_JSON = "walmart_taxonomy_raw.json";
const RICH_CSV = "walmart_categories.csv";
const TEMPLATE_CSV = "walmart_template_categories.csv";
const APPROVED_CSV = "walmart_approved_categories.csv";

function dataPath(file: string): string {
  return join(process.cwd(), DATA_DIR, file);
}

/** Proper quoted-CSV line parser — handles fields that contain commas
 *  ("Baby Diapering, Care, & Other"). */
function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { cols.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cols.push(current.trim());
  return cols;
}

// ── Template category list (the export target) ────────────────────────────────

let cachedTemplate: string[] | null = null;
let cachedTemplateMtime = 0;

/** The 75 category values the Walmart template's dropdown accepts. Always present. */
export function loadWalmartTemplateCategories(): string[] {
  const path = dataPath(TEMPLATE_CSV);
  const mtime = statSync(path).mtimeMs;
  if (cachedTemplate && mtime === cachedTemplateMtime) return cachedTemplate;
  cachedTemplateMtime = mtime;

  const raw = readFileSync(path, "utf8");
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.toLowerCase() === "category") continue;
    // This file is ONE category per line by definition. Several values contain
    // commas ("Home Decor, Kitchen, & Other"), so it must NOT be comma-split —
    // read each line verbatim, only stripping an accidental wrapping quote.
    out.push(t.replace(/^"(.*)"$/, "$1"));
  }
  if (!out.length) throw new Error(`${TEMPLATE_CSV} is empty or could not be parsed`);
  cachedTemplate = out;
  return out;
}

// ── Raw taxonomy JSON (Walmart's official item taxonomy) ─────────────────────

type RawProductType = { productTypeName?: string; description?: string };
type RawGroup = {
  productTypeGroupName?: string;
  description?: string;
  productType?: RawProductType[];
  department?: { departmentName?: string; departmentNumber?: string }[];
};
type RawCategory = { category?: string; description?: string; productTypeGroup?: RawGroup[] };

export type WalmartTaxonomyGroup = { name: string; types: string[] };
export type WalmartTaxonomyCategory = { category: string; groups: WalmartTaxonomyGroup[] };

let cachedRaw: WalmartTaxonomyCategory[] | null = null;
let cachedRawMtime = 0;

/**
 * Parse walmart_taxonomy_raw.json (the saved GET /v3/items/taxonomy response:
 * { itemTaxonomy: [{ category, productTypeGroup: [{ productTypeGroupName,
 * productType: [{ productTypeName }] }] }] }) into a lean structure. Returns
 * null when the file is absent or unparseable — callers fall back to the CSVs.
 */
export function loadWalmartRawTaxonomy(): WalmartTaxonomyCategory[] | null {
  const path = dataPath(RAW_JSON);
  if (!existsSync(path)) return null;
  const mtime = statSync(path).mtimeMs;
  if (cachedRaw && mtime === cachedRawMtime) return cachedRaw;

  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as { itemTaxonomy?: RawCategory[] };
    const cats: WalmartTaxonomyCategory[] = [];
    for (const c of json.itemTaxonomy ?? []) {
      const category = (c.category ?? "").trim();
      if (!category) continue;
      const groups: WalmartTaxonomyGroup[] = [];
      for (const g of c.productTypeGroup ?? []) {
        const name = (g.productTypeGroupName ?? "").trim();
        if (!name) continue;
        const types = (g.productType ?? [])
          .map((t) => (t.productTypeName ?? "").trim())
          .filter(Boolean);
        groups.push({ name, types });
      }
      if (groups.length) cats.push({ category, groups });
    }
    if (!cats.length) return null;
    cachedRaw = cats;
    cachedRawMtime = mtime;
    return cachedRaw;
  } catch (e) {
    console.error(`[walmart-taxonomy] failed to parse ${RAW_JSON}:`, e);
    return null;
  }
}

/**
 * Every valid "Spec Product Type" value from the raw taxonomy (deduped), or
 * null when the raw JSON is not on disk. This is the same list the Seller API
 * taxonomy endpoint returns — kept local so spec-type assignment works without
 * live API credentials.
 */
export function loadWalmartProductTypes(): string[] | null {
  const raw = loadWalmartRawTaxonomy();
  if (!raw) return null;
  const seen = new Set<string>();
  for (const c of raw) for (const g of c.groups) for (const t of g.types) seen.add(t);
  return seen.size ? [...seen] : null;
}

/**
 * The product types under an assigned category path ("Category > Product Type
 * Group", or just "Category"). Used to scope the spec-type AI prompt to the
 * relevant slice of the ~7K-entry list. Null when the path doesn't resolve.
 */
export function productTypesForCategoryPath(assigned: string): string[] | null {
  const raw = loadWalmartRawTaxonomy();
  if (!raw || !assigned) return null;
  const [catSeg, groupSeg] = assigned.split(">").map((s) => s.trim());
  const cat = raw.find((c) => c.category.toLowerCase() === (catSeg ?? "").toLowerCase());
  if (!cat) return null;
  if (groupSeg) {
    const group = cat.groups.find((g) => g.name.toLowerCase() === groupSeg.toLowerCase());
    if (group?.types.length) return group.types;
  }
  // Group missing or unresolved — the whole category is still a useful scope.
  const all = cat.groups.flatMap((g) => g.types);
  return all.length ? all : null;
}

// ── Rich taxonomy (optional) ──────────────────────────────────────────────────

let cachedRich: string[] | null = null;
let cachedRichMtime = 0;

/** True when a rich taxonomy source (raw JSON or legacy CSV) exists on disk. */
export function hasWalmartRichTaxonomy(): boolean {
  return existsSync(dataPath(RAW_JSON)) || existsSync(dataPath(RICH_CSV));
}

/**
 * The rich taxonomy paths, or null when no source file is present.
 *
 * Preferred source: the raw taxonomy JSON, yielding 2-level paths
 * "Category > Product Type Group" (491 paths) — real Walmart taxonomy entries
 * at a size the categorization prompt can carry whole.
 *
 * Legacy CSV fallback accepts either a single "path" column already formatted
 * as "A > B > C", or up to three separate columns joined with " > ".
 */
export function loadWalmartRichTaxonomy(): string[] | null {
  const rawTax = loadWalmartRawTaxonomy();
  if (rawTax) {
    return rawTax.flatMap((c) => c.groups.map((g) => `${c.category} > ${g.name}`));
  }

  const path = dataPath(RICH_CSV);
  if (!existsSync(path)) return null;
  const mtime = statSync(path).mtimeMs;
  if (cachedRich && mtime === cachedRichMtime) return cachedRich;
  cachedRichMtime = mtime;

  const raw = readFileSync(path, "utf8");
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const cols = parseCsvLine(t);
    if (cols[0]?.toLowerCase() === "category" || cols[0]?.toLowerCase() === "path") continue;
    // Already-joined path, or separate level columns.
    const segments = cols.length === 1
      ? cols[0].split(">").map((s) => s.trim())
      : cols.map((c) => c.trim());
    const usable = segments.filter(Boolean);
    if (usable.length) out.push(usable.join(" > "));
  }
  cachedRich = out.length ? out : null;
  return cachedRich;
}

/**
 * The category list the AI categorizes into.
 *
 * Rich taxonomy when supplied (detailed paths), otherwise the 75 template
 * values so categorization is fully functional with no external file. Either
 * way the result is mapped down to a template value at export time via
 * mapToTemplateCategory.
 */
export function loadWalmartCategoryPaths(): string[] {
  return loadWalmartRichTaxonomy() ?? loadWalmartTemplateCategories();
}

/** Format the category list for the Claude prompt, grouped by top-level. */
export function formatWalmartTaxonomyForPrompt(): string {
  const paths = loadWalmartCategoryPaths();
  // Flat list (template mode) — one bullet per value.
  if (paths.every((p) => !p.includes(" > "))) {
    return paths.map((c) => `  - ${c}`).join("\n");
  }
  // Path mode — group by top-level department.
  const byTop = new Map<string, string[]>();
  for (const path of paths) {
    const top = path.split(" > ")[0] ?? path;
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top)!.push(path);
  }
  const lines: string[] = [];
  for (const [top, leaves] of byTop) {
    lines.push(`${top}:`);
    lines.push(leaves.map((l) => `  - ${l}`).join("\n"));
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── Approved category structure (client-supplied, upload-authoritative) ───────
// Walmart validates uploads against its REAL category structure: 25-ish
// top-level Product Categories ("Home & Garden", "Electronics", …), each
// official Product Type belonging to exactly ONE of them. The client supplied
// the full 5.2k-row mapping (Walmart_Category&Product type sheet, converted to
// walmart_approved_categories.csv). The legacy 75-value template list has ZERO
// overlap with this structure — every value it produced was off-list, which is
// exactly the "categories are not matching Walmart's category structure"
// rejection. When this file is present it is the ONLY export target.

export type WalmartApprovedMap = {
  /** lowercased product type → its approved category (verbatim). */
  byType: Map<string, string>;
  /** Distinct approved categories, most-populated first. */
  categories: string[];
};

let cachedApproved: WalmartApprovedMap | null = null;
let cachedApprovedMtime = 0;

/** The client-approved ProductType→Category mapping; null when the file is absent. */
export function loadWalmartApprovedMap(): WalmartApprovedMap | null {
  const path = dataPath(APPROVED_CSV);
  if (!existsSync(path)) return null;
  const mtime = statSync(path).mtimeMs;
  if (cachedApproved && mtime === cachedApprovedMtime) return cachedApproved;

  const byType = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [pt, cat] = parseCsvLine(t);
    if (!pt || !cat || pt.toLowerCase() === "product_type") continue;
    byType.set(pt.toLowerCase(), cat);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  if (!byType.size) return null;
  cachedApproved = {
    byType,
    categories: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c),
  };
  cachedApprovedMtime = mtime;
  return cachedApproved;
}

/** The approved category a Spec Product Type belongs to — the 1:1 authoritative mapping. */
export function approvedCategoryForType(productType: string | null | undefined): string | null {
  if (!productType?.trim()) return null;
  return loadWalmartApprovedMap()?.byType.get(productType.trim().toLowerCase()) ?? null;
}

// Deterministic hints onto the approved structure for paths whose wording
// doesn't lexically overlap the category name. First match wins.
const APPROVED_ALIASES: Array<[RegExp, string]> = [
  [/\b(sofa|couch|table|chair|dresser|bed|desk|bookcase|furniture|nightstand|ottoman|rug|carpet|decor|vase|candle|mirror|pillow|curtain|cookware|bakeware|kitchen|dinnerware|garden|patio|planter|bedding|sheet|comforter|duvet|quilt|lamp|lighting)\b/, "Home & Garden"],
  [/\b(tv|television|monitor|display|phone|tablet|laptop|computer|headphone|speaker|audio|video game|console)\b/, "Electronics"],
  [/\b(toy|toys|play ?set|doll|action figure|game|puzzle)\b/, "Toys & Games"],
  [/\b(shirt|pants|dress|apparel|clothing|jacket|shoe|footwear|sneaker|boot|sandal|hat|sock)\b/, "Clothing, Shoes & Accessories"],
  [/\b(tool|drill|wrench|hammer|hardware|saw|fastener|plumbing|electrical)\b/, "Tools & Hardware"],
  [/\b(sport|outdoor|camping|fishing|bike|bicycle|fitness|exercise|hunting)\b/, "Sports & Outdoors"],
  [/\b(pet|dog|cat|bird|aquarium|animal)\b/, "Pet Supplies"],
  [/\b(baby|infant|toddler|nursery|diaper|stroller|car seat)\b/, "Baby"],
  [/\b(office|stationery|paper|pen|pencil|binder|desk accessory)\b/, "Office & Stationery"],
  [/\b(craft|sewing|knitting|scrapbook|bead)\b/, "Crafts"],
  [/\b(vehicle|automotive|car|truck|motorcycle|tire|engine)\b/, "Vehicles, Parts & Accessories"],
  [/\b(food|beverage|snack|grocery|drink|coffee|tea)\b/, "Food & Beverages"],
  [/\b(health|beauty|personal care|hygiene|makeup|cosmetic|vitamin|medicine)\b/, "Health & Beauty"],
  [/\b(camera|lens|photography|binocular|telescope|optic)\b/, "Cameras, Photography & Optics"],
  [/\b(jewelry|jewellery|watch|gem|ring|necklace|bracelet)\b/, "Jewelry, Gems & Watches"],
  [/\b(book|magazine|music|movie|dvd|vinyl)\b/, "Books, Music & Movies"],
  [/\b(luggage|suitcase|travel|backpack|duffel)\b/, "Travel, Luggage & Accessories"],
  [/\b(guitar|piano|drum|instrument|microphone|dj|pro audio)\b/, "Musical Instruments & Pro Audio"],
  [/\b(industrial|commercial|restaurant|janitorial|safety equipment)\b/, "Business & Industrial"],
];

/**
 * Map a product onto the APPROVED category structure — the value the Walmart
 * output sheet must carry:
 *   1. Spec Product Type → its approved category (authoritative 1:1)
 *   2. deterministic aliases, then word-overlap, against the approved list
 * Falls back to the legacy template mapping when the approved file is absent.
 * Returns null when nothing matches confidently (blank beats off-list).
 */
export function mapToApprovedCategory(
  specProductType: string | null | undefined,
  assigned: string | null | undefined,
): string | null {
  const approved = loadWalmartApprovedMap();
  if (!approved) return assigned ? mapToTemplateCategory(assigned) : null;

  const byType = approvedCategoryForType(specProductType);
  if (byType) return byType;
  if (!assigned?.trim()) return null;

  // Already an approved category (verbatim or normalized)?
  const exact = approved.categories.find((c) => norm(c) === norm(assigned));
  if (exact) return exact;

  const segments = assigned.split(">").map((s) => s.trim()).filter(Boolean);
  const haystacks = [...segments.reverse(), assigned].map(norm);

  for (const h of haystacks) {
    for (const [re, target] of APPROVED_ALIASES) {
      if (re.test(h)) return approved.categories.find((c) => c === target) ?? null;
    }
  }

  let best: string | null = null;
  let bestScore = 0;
  for (const c of approved.categories) {
    const cWords = norm(c).split(" ").filter((w) => w.length > 2);
    for (const h of haystacks) {
      const hWords = new Set(h.split(" ").filter((w) => w.length > 2));
      let score = 0;
      for (const w of cWords) if (hWords.has(w)) score += 1;
      if (score > bestScore) { bestScore = score; best = c; }
    }
  }
  return bestScore >= 1 ? best : null;
}

// ── Rich path → template value mapping ────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

// Deterministic hints for template values whose name doesn't lexically overlap
// the words a rich path would use. Kept small and obvious; the word-overlap
// scorer handles the rest.
const TEMPLATE_ALIASES: Array<[RegExp, string]> = [
  [/\b(sofa|couch|table|chair|dresser|bed|desk|bookcase|furniture|nightstand|ottoman)\b/, "Furniture"],
  [/\b(rug|carpet|decor|vase|candle|mirror|wall art|pillow|throw|curtain)\b/, "Home Decor, Kitchen, & Other"],
  [/\b(cookware|bakeware|kitchen|dinnerware|utensil|flatware)\b/, "Home Decor, Kitchen, & Other"],
  [/\b(sheet|comforter|duvet|quilt|bedding|pillowcase)\b/, "Bedding"],
  [/\b(tv|television|monitor|display)\b/, "TVs & Video Displays"],
  [/\b(phone|tablet|laptop|computer)\b/, "Computers"],
  [/\b(toy|toys|play ?set|doll|action figure)\b/, "Toys"],
  [/\b(shirt|pants|dress|apparel|clothing|jacket)\b/, "Clothing"],
  [/\b(shoe|footwear|sneaker|boot|sandal)\b/, "Footwear"],
  [/\b(tool|drill|wrench|hammer|hardware)\b/, "Tools"],
  [/\b(patio|garden|outdoor|planter)\b/, "Garden & Patio"],
];

/**
 * Map an assigned category (rich path OR already a template value) to one of the
 * 75 template dropdown values. Returns null when nothing matches confidently, so
 * the caller can leave the cell blank rather than write an invalid value.
 */
export function mapToTemplateCategory(assigned: string): string | null {
  if (!assigned) return null;
  const templates = loadWalmartTemplateCategories();

  // Exact match (already a template value, e.g. template-mode categorization).
  const exact = templates.find((t) => norm(t) === norm(assigned));
  if (exact) return exact;

  // Compare against the most specific segment of a rich path first, then the
  // whole thing, so "Home > Furniture > Sofas" keys off "Sofas"/"Furniture".
  const segments = assigned.split(">").map((s) => s.trim()).filter(Boolean);
  const haystacks = [...segments.reverse(), assigned].map(norm);

  // Deterministic aliases.
  for (const h of haystacks) {
    for (const [re, target] of TEMPLATE_ALIASES) {
      if (re.test(h)) return templates.find((t) => t === target) ?? null;
    }
  }

  // Word-overlap scoring against each template value.
  let best: string | null = null;
  let bestScore = 0;
  for (const t of templates) {
    const tWords = norm(t).split(" ").filter((w) => w.length > 2);
    for (const h of haystacks) {
      const hWords = new Set(h.split(" ").filter((w) => w.length > 2));
      let score = 0;
      for (const w of tWords) if (hWords.has(w)) score += 1;
      if (score > bestScore) { bestScore = score; best = t; }
    }
  }
  // Require at least one shared meaningful word; otherwise leave it to the
  // export's own dropdown matcher / blank rule.
  return bestScore >= 1 ? best : null;
}
