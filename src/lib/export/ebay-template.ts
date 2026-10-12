import { ebayCategoryIdForPath } from "@/lib/ai/ebay-taxonomy";

/**
 * eBay's listing file, and the four rules that make one upload cleanly.
 *
 * eBay is unlike every other marketplace here. There is no workbook with a
 * "Columns" sheet saying what each category requires, no dropdowns to match
 * against, no requirement matrix — just a flat 149-column CSV. So the column
 * rules cannot be read out of the template; they have to be stated, and this
 * is where they are stated.
 *
 * The shape of a row is the seller's own filled file (vidhi_3.xlsx, October
 * 2026): one sheet for the whole catalogue, item specifics in Attribute
 * Name/Value 1–14, the description as heading + paragraph + bullets + the
 * return policy, and the variation, EAN and store-category columns left
 * empty. Where this file and that one disagree, that one is right.
 *
 * The four:
 *
 *   1. The category is eBay's numeric id, in "Category". The seller's file
 *      leaves "Store Category Name 1" empty, so the readable path no longer
 *      goes there — it is a store category to eBay, not a label.
 *
 *   2. No inverted commas in any cell. A 72" garland ships as `72`, not
 *      `72"`. This is a house rule rather than an eBay one, and it is applied
 *      at the point every cell is written rather than per column, because a
 *      per-column rule is one that gets forgotten on column 150. The one
 *      exception is the description's own markup — see ebayDescriptionHtml.
 *
 *   3. Some columns are the same on every row forever. They are declared
 *      below rather than asked of a model — a constant is not a question, and
 *      spending an AI call on "what goes in Channel ID" is both slower and
 *      less reliable than writing EBAY_US.
 *
 *   4. Restricted keywords. The channel manager refuses a listing whose
 *      title, description or brand contains a trademarked term, and reports
 *      which term in its own Error column. That column is the only
 *      authoritative source there is — see RESTRICTED_SEED.
 */

// ── 1. The category, in two columns ──────────────────────────────────────────

/** CT — eBay's numeric category id. */
export const EBAY_CATEGORY_ID_COLUMN = "Category";

// ── 2. No inverted commas ────────────────────────────────────────────────────

/**
 * A cell value with its quote marks removed.
 *
 * Double quotes only. The inch mark is a double quote (`72"`), and so are the
 * curly forms a vendor's copy-paste brings in. A lone apostrophe is left
 * alone: it is a letter in "don't" far more often than it is a foot mark, and
 * stripping it would quietly damage every description that contains one.
 *
 * Doubled apostrophes ('') ARE stripped — nobody writes those on purpose;
 * they are an inch mark typed on a keyboard that had no double quote handy.
 */
export function stripInvertedCommas(value: string): string {
  return String(value ?? "")
    .replace(/''/g, "")
    .replace(/["“”″«»]/g, "")
    // 72" becomes 72, and `4 x 10yd` should not become `4  x 10yd`.
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ── 3. The constants ─────────────────────────────────────────────────────────

/**
 * Columns whose value is the same on every row.
 *
 * Taken from a filled file that this seller's channel manager accepted, and
 * split deliberately: ACCOUNT_CONSTANTS are the ones that would change if the
 * account's shipping or payment setup changed, and are the first place to
 * look when a file is rejected for a reason that has nothing to do with the
 * product.
 *
 * Nothing vendor-specific is here. `Warehouse Location ID` is VICK in the
 * reference file because VICK is that vendor's SKU prefix, so it is derived
 * from each product's own SKU (warehouseLocationId) rather than written as a
 * constant onto every vendor's products.
 */
export const EBAY_FORMAT_CONSTANTS: Record<string, string> = {
  "Localized For": "en_US",
  "Condition": "NEW",
  "Measurement System": "ENGLISH",
  "Channel ID": "EBAY_US",
  "Active": "1",
  "Total Ship To Home Quantity": "1",
  "CANA Price": "0",
};

/** Constants that follow the seller's account setup rather than the format. */
export const EBAY_ACCOUNT_CONSTANTS: Record<string, string> = {
  // The policy NAMES as they exist on the seller's eBay account. A name eBay
  // cannot find is a rejected row, so these follow the account, not a guess.
  "Shipping Policy": "2 business days GS",
  "Payment Policy": "eBay managed Payment",
  "Return Policy": "Returns Accepted 30 days",
  // A carrier service, in a column eBay's own schema calls a cost. That is
  // how the accepted file had it; it is not a typo here.
  "Domestic Shipping P1 Cost": "FEDEX_HOME",
};

export const EBAY_CONSTANTS: Record<string, string> = {
  ...EBAY_FORMAT_CONSTANTS,
  ...EBAY_ACCOUNT_CONSTANTS,
};

/**
 * Columns the seller's file leaves empty, written empty whatever the shared
 * field map would have put there.
 *
 *   Variation columns — a filled Variation Specific pair, or a Variation Group
 *     ID, tells eBay the row is one variation of a multi-variation listing.
 *     Every product here is its own listing; Colour and Size go in the item
 *     specifics instead.
 *   Store Category Name 1 — a store category on the seller's eBay shop, not a
 *     label for the eBay category.
 *   Additional Info — its bullets now live inside the description.
 *   Weight Minor — the seller's file states weight in whole pounds.
 *   Minimum Advertised Price — 0 is a price.
 *   Error — the channel manager's column, filled by it on the way back.
 */
export const EBAY_BLANK_COLUMNS: ReadonlySet<string> = new Set([
  ...[1, 2, 3, 4, 5].flatMap((n) => [`Variation Specific Name ${n}`, `Variation Specific Value ${n}`]),
  "Store Category Name 1",
  "Additional Info",
  "Weight Minor",
  "Minimum Advertised Price",
  "Error",
]);

/**
 * The return policy every description ends with, as the seller's file has it.
 * An account-level text, like the policy names above.
 */
export const EBAY_RETURN_POLICY_HTML =
  "<p>Return Policy</p>"
  + "<li>Remorse Returns- Return Shipping Buyer Pays + 20% Restocking Fees</li>"
  + "<li>For Damaged/defective items received- contact us within 48 hrs of the receipt of the item</li>"
  + "<li>Non-availability/ incorrect address we charge restocking fees of 20% + return shipping charges</li>";

// ── 4. Restricted keywords ───────────────────────────────────────────────────

/**
 * A SEED list, and the word is doing work.
 *
 * eBay's VeRO programme publishes a page only for those rights owners who
 * chose to publish one, so the public list is a reference and not a
 * blocklist — there is no complete list to fetch, and any code that pretends
 * otherwise will let a listing through and look like it checked.
 *
 * What is here is the dangerous subset: terms that are BOTH a live trademark
 * and an ordinary English word a product description reaches for without
 * meaning the brand at all. Those are the ones that trip a filter nobody
 * expected to be tripped — a garland described as a garland, a ribbon said to
 * "ensure" a shape holds.
 *
 * The real list for a given seller lives in their channel manager, and that
 * channel manager already tells us: every refusal names the term it caught,
 * in the file's own Error column. flaggedKeywordsFromError reads those out,
 * so the list grows from refusals actually received rather than from
 * guesswork. Both of the terms this seller has hit so far — Garland, Ensure —
 * are in here because their file reported them.
 */
export const RESTRICTED_SEED: readonly string[] = [
  // Reported by this seller's own channel manager.
  "garland",
  "ensure",
  // Trademarks that are also ordinary words. Each of these is a registered
  // brand AND a word a product description uses innocently.
  "apple", "boss", "champion", "coach", "columbia", "converse", "dove",
  "element", "elements", "fossil", "gap", "guess", "hoover", "jaguar",
  "monster", "next", "oakley", "patagonia", "polo", "puma", "shell",
  "vans", "caterpillar", "diesel", "north face", "brita", "dyson",
  "otterbox", "yeti", "stanley", "weber", "traeger", "lego", "disney",
  "pyrex", "crockpot", "crock pot", "keurig", "roomba", "velcro",
  "jacuzzi", "dumpster", "onesie", "chapstick", "band-aid", "bandaid",
  "thermos", "frisbee", "popsicle", "styrofoam", "kleenex", "rollerblade",
] as const;

/**
 * The terms a channel manager's own error text named.
 *
 * Its wording is:
 *   SKU - Restrictrted Keyword found in Title-'' OR Description -'Garland' OR Brand -''.
 *
 * Quoted, one field at a time, empty quotes where that field was clean, and
 * comma-separated where one field tripped twice ('ensure,ensure'). The
 * misspelling of "Restricted" is theirs and is matched loosely so a fix on
 * their side does not silently stop this working.
 */
export function flaggedKeywordsFromError(errorText: string): string[] {
  const raw = String(errorText ?? "");
  if (!/restric\w*\s+keyword/i.test(raw)) return [];
  const out: string[] = [];
  for (const m of raw.matchAll(/'([^']*)'/g)) {
    for (const part of String(m[1] ?? "").split(",")) {
      const word = part.trim().toLowerCase();
      // Empty quotes mean that field was clean — the common case, and not a
      // keyword called "".
      if (word) out.push(word);
    }
  }
  return [...new Set(out)];
}

/** The restricted terms that appear in a piece of text, lowercased. */
export function restrictedHitsIn(text: string, words: readonly string[]): string[] {
  const haystack = String(text ?? "").toLowerCase();
  if (!haystack) return [];
  const hits: string[] = [];
  for (const w of words) {
    // Whole words only. Without the boundary, "gap" matches "gaps" and
    // "apple" matches "pineapple", and a filter that fires on pineapple is a
    // filter somebody switches off.
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)`, "i");
    if (re.test(haystack)) hits.push(w);
  }
  return hits;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Text with the restricted terms removed, and what was taken out.
 *
 * Removed rather than substituted. A synonym would have to be chosen per term
 * and per product to read correctly — "wreath" for a garland is wrong — and a
 * wrong word in a live listing is worse than a missing one.
 *
 * This is not free. "Garland" was flagged in the description of a product
 * that genuinely IS a garland, so the listing that passes is the one that
 * describes itself less well. Every removal is reported so that trade is
 * visible to a person rather than made silently on their behalf.
 */
export function scrubRestricted(
  text: string,
  words: readonly string[],
): { text: string; removed: string[] } {
  const original = String(text ?? "");
  if (!original) return { text: original, removed: [] };
  const removed: string[] = [];
  let out = original;
  for (const w of restrictedHitsIn(original, words)) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(w)}([^A-Za-z0-9]|$)`, "gi");
    let touched = false;
    out = out.replace(re, (_m, before: string, after: string) => {
      touched = true;
      // Keep whatever bounded the word so punctuation and tags survive;
      // dropping both would weld the neighbours together.
      return `${before}${after}`;
    });
    if (touched) removed.push(w);
  }
  return {
    text: out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim(),
    removed,
  };
}

/**
 * Plain-English stand-ins for the terms this seller's channel manager has
 * refused, for use in descriptions.
 *
 * Removal was the rule and it read badly at scale: Vickerman's copy says
 * "garland" in nearly every sentence about a garland, and deleting it left
 * "This durable is maintenance free" and "shape the to fit" in 154 places in
 * one 159-product file. These two terms have a word that is right in every
 * sentence they appear in, so they are swapped rather than deleted. Every
 * other restricted term is still removed — no single stand-in is right for
 * "apple" or "shell".
 */
export const EBAY_RESTRICTED_REPLACEMENTS: Readonly<Record<string, string>> = {
  garland: "trim",
  garlands: "trims",
  ensure: "make sure",
  ensures: "makes sure",
  ensured: "made sure",
};

/**
 * Text with the replaceable restricted terms swapped for their stand-ins, and
 * any other restricted term removed. Reports every term it touched.
 */
export function rewordRestricted(
  text: string,
  words: readonly string[],
): { text: string; removed: string[] } {
  let out = String(text ?? "");
  const touched: string[] = [];
  const restricted = new Set(words.map((w) => w.toLowerCase()));
  for (const [term, stand] of Object.entries(EBAY_RESTRICTED_REPLACEMENTS)) {
    // "garlands" is replaceable because "garland" is restricted.
    const root = term.replace(/(s|d)$/, "");
    if (!restricted.has(term) && !restricted.has(root)) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(term)})(?=[^A-Za-z0-9]|$)`, "gi");
    out = out.replace(re, (_m, before: string, found: string) => {
      touched.push(restricted.has(term) ? term : root);
      const cased = found[0] === found[0]!.toUpperCase()
        ? stand[0]!.toUpperCase() + stand.slice(1)
        : stand;
      return `${before}${cased}`;
    });
  }
  const rest = scrubRestricted(out, words);
  return { text: rest.text, removed: [...new Set([...touched, ...rest.removed])] };
}

// ── The description, as prose rather than as a page ──────────────────────────

const KEEP_TAGS = new Set(["p", "br", "ul", "ol", "li", "strong", "em", "b", "i"]);

/**
 * A product description reduced to the tags that describe the product.
 *
 * Mercato has been writing the scraped PAGE into this column — the real
 * output carried `<h1 class="product-name" data-bind="text: product().name">`,
 * which is a fragment of the vendor site's own Knockout template. It renders
 * as an empty heading in an eBay listing, and the binding attribute means the
 * text was never even in the HTML.
 *
 * So: script and style blocks go entirely, every tag loses its attributes,
 * and any tag outside KEEP_TAGS is unwrapped rather than deleted — its text
 * is the description and only its markup is the problem.
 */
export function cleanDescriptionHtml(html: string): string {
  let s = String(html ?? "");
  if (!s) return "";
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_m, tag: string) => {
    const name = String(tag).toLowerCase();
    if (!KEEP_TAGS.has(name)) return " ";
    const closing = _m.startsWith("</");
    return closing ? `</${name}>` : `<${name}>`;
  });
  return s
    .replace(/(\s*<br>\s*)+/gi, "<br>")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/**
 * A plain-text description given the paragraph wrapper eBay's accepted file
 * uses. Already-marked-up text is left alone, and so is an empty cell — an
 * empty `<p></p>` is markup claiming there is a description.
 */
export function wrapDescriptionParagraph(text: string): string {
  const s = String(text ?? "").trim();
  if (!s) return "";
  if (/<[a-zA-Z][^>]*>/.test(s)) return s;
  return `<p>${s}</p>`;
}

/**
 * The whole Product Description cell, laid out as the seller's file lays it:
 *
 *   <h1 class="product-name" data-bind="…">Title</h1>
 *   <p>the product copy</p>
 *   <li>LightColor …</li><li>Brand …</li>
 *   the return policy
 *
 * The heading is copied attribute for attribute, binding included. It looks
 * like a stray page fragment (cleanDescriptionHtml strips exactly that from a
 * vendor's own copy), but it is what the seller's channel manager is fed, and
 * with the title inside it renders as a heading.
 *
 * Its quote marks are the reason the no-inverted-commas rule is applied to
 * the PARTS here — title, copy, bullet values — and not to the finished cell:
 * stripped, `class="product-name"` becomes an attribute no browser parses.
 */
export function ebayDescriptionHtml(parts: {
  title: string;
  body: string;
  lightColor: string;
  brand: string;
}): string {
  const title = stripInvertedCommas(parts.title);
  const body = wrapDescriptionParagraph(stripInvertedCommas(parts.body));
  const bullets = [
    parts.lightColor ? `<li>LightColor ${stripInvertedCommas(parts.lightColor)}</li>` : "",
    parts.brand ? `<li>Brand ${stripInvertedCommas(parts.brand)}</li>` : "",
  ].join("");
  return (
    `<h1 class="product-name" data-bind="text: product().displayName()">${title}</h1>`
    + body
    + bullets
    + EBAY_RETURN_POLICY_HTML
  );
}

type ItemSpecificSource = { column: string } | { field: string } | { typeSlug: true } | null;

/**
 * The item specifics, in the order the seller's file writes them into
 * Attribute Name/Value 1–14. `from` names the source: another column of the
 * same row, a product field, the product type, or nothing (Installation No is
 * named and left empty, as the seller's file has it).
 *
 * `unknown` is what the seller's own blank row writes when the product has no
 * answer — eBay treats an empty specific as missing, and these read as an
 * answer to a shopper filtering by it.
 */
export const EBAY_ITEM_SPECIFICS: readonly { name: string; from: ItemSpecificSource; unknown?: string }[] = [
  { name: "Brand", from: { column: "Brand" } },
  { name: "UPC", from: { column: "UPC" } },
  { name: "MPN", from: { column: "MPN" } },
  { name: "Model No.", from: { column: "MPN" } },
  { name: "Color", from: { field: "Color" }, unknown: "As shown" },
  { name: "Size", from: { field: "Size" }, unknown: "As described" },
  { name: "Item Length", from: { column: "Length" }, unknown: "As described" },
  { name: "Item Width", from: { column: "Width" }, unknown: "As described" },
  { name: "Item Height", from: { column: "Height" }, unknown: "As described" },
  { name: "Type", from: { typeSlug: true } },
  { name: "Material", from: { field: "Material" }, unknown: "As described" },
  { name: "Model", from: { column: "MPN" } },
  { name: "Installation No", from: null },
  { name: "Product", from: { typeSlug: true } },
];

/** `"Attribute Value 7"` → `{ kind: "Value", index: 6 }`; null for any other column. */
export function itemSpecificSlot(column: string): { kind: "Name" | "Value"; index: number } | null {
  const m = /^Attribute (Name|Value) (\d+)$/.exec(String(column ?? "").trim());
  if (!m) return null;
  return { kind: m[1] as "Name" | "Value", index: Number(m[2]) - 1 };
}

/**
 * A vendor value that means "nothing". Vendor exports write 0 into an empty
 * text column often enough (material, product_type) that a 0 in Colour or
 * Material is never a colour or a material.
 */
function meaningful(v: unknown): string {
  const s = String(v ?? "").trim();
  return s === "0" || /^n\/?a$/i.test(s) || /^null$/i.test(s) ? "" : s;
}

/** "Wreaths, Garlands & Plants" → "wreaths-garlands-plants". */
export function slugify(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The Type / Product specific: the vendor's own product type when it has one
 * (Vickerman's `christmas-garlands`, `fabric-ribbons`), otherwise the eBay
 * category's leaf as a slug.
 */
export function productTypeSlug(vendorType: unknown, categoryPath: string | null | undefined): string {
  const own = meaningful(vendorType);
  if (own) return slugify(own);
  const leaf = String(categoryPath ?? "").split(">").pop()?.trim() ?? "";
  return slugify(leaf);
}

/**
 * The warehouse a product ships from, as the seller's file names it: the
 * vendor prefix of the SKU (`VICK-A801000` → `VICK`). A SKU with no prefix
 * gives nothing rather than a guess.
 */
export function warehouseLocationId(sku: string | null | undefined): string {
  const m = /^([A-Za-z]{2,10})-./.exec(String(sku ?? "").trim());
  return m ? m[1]!.toUpperCase() : "";
}

/**
 * The light colour bullet. The vendor's own column when it has one; otherwise
 * the `Light_Color: …` line Vickerman writes into its feature bullets;
 * otherwise Unlit, which is what the seller's file says for every product
 * that has no lights.
 */
export function lightColorOf(direct: unknown, features: unknown): string {
  const own = meaningful(direct);
  if (own) return own;
  const m = /Light[_ ]?Colou?r\s*:\s*([^<\n]+)/i.exec(String(features ?? ""));
  return m ? m[1]!.trim() : "Unlit";
}

/**
 * Weight Major, in whole pounds rounded UP — what the seller's file writes,
 * and the safe direction for a shipping weight. Reads a value already split
 * into pounds and ounces as well as a plain weight.
 */
export function wholePounds(major: unknown, minor: unknown, plain: unknown): string {
  const num = (v: unknown) => {
    const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  let lbs = num(major) + num(minor) / 16;
  if (lbs <= 0) lbs = num(plain);
  if (lbs <= 0) return "";
  return String(Math.max(1, Math.ceil(lbs - 1e-9)));
}

/** A cell value only when it is a web address — never a stray flag or count. */
function urlOnly(v: unknown): string {
  const s = String(v ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

// ── Putting it together ──────────────────────────────────────────────────────

export type EbayCellContext = {
  /** The template column's own label, as the header spells it. */
  column: string;
  /** Whatever the normal field resolution produced for this cell. */
  value: unknown;
  /** The product's assigned category path, if it has one. */
  categoryPath?: string | null;
  /** Restricted terms in force for this run: the seed plus anything the
   *  uploaded file's own Error column reported. */
  restricted?: readonly string[];
  /**
   * The exporter's own field resolution, for columns that need a field other
   * than the one their header names (an item specific's value, the light
   * colour inside the description).
   */
  resolve?: (field: string) => unknown;
  /**
   * The vendor sheet alone, with none of the exporter's derivation.
   *
   * Needed because several columns must be filled ONLY from what the vendor
   * actually supplied, and the normal resolution cannot tell you that — it
   * answers with a value either way. See EBAY_VENDOR_ONLY_COLUMNS.
   */
  vendorValue?: (field: string) => unknown;
  /**
   * The FINISHED value of another column on the same row. The item specifics
   * repeat the row's UPC, MPN and dimensions, and the description's heading
   * is the row's title; reading the finished cell keeps each pair identical
   * rather than two resolutions that can drift apart.
   */
  cell?: (column: string) => string;
  /** The product's own brand. */
  brand?: string | null;
  /** The product's SKU, for the warehouse prefix and the MPN fallback. */
  sku?: string | null;
  /** The product's main image, for Picture URL 1. */
  imageUrl?: string | null;
};

/**
 * Columns eBay must take from the vendor sheet or leave empty.
 *
 * The exporter's field map is shared by every marketplace and fills these
 * from whatever identifier is to hand. That is right for the marketplace it
 * was written for and wrong here:
 *
 *   Variation Group ID — mapped as `upcNorm ?? vendorSku ?? anyVendorId` for
 *     Sears, where it groups variants. eBay reads it as "these rows are
 *     variations of one another", so a per-product UPC declares every product
 *     to be its own group of one. The accepted file leaves it empty.
 *
 *   EAN, ISBN — both fall back to the UPC. A 12-digit UPC is not an EAN and
 *     is certainly not an ISBN; the accepted file fills UPC and leaves these
 *     two blank. Writing a barcode into the wrong identifier field is how a
 *     listing gets matched to somebody else's catalogue product.
 *
 * Each is still filled when the vendor sheet genuinely carries that column —
 * a real EAN belongs in the EAN field. What is refused is the back-fill.
 */
export const EBAY_VENDOR_ONLY_COLUMNS: readonly string[] = [
  "Variation Group ID",
  "EAN",
  "ISBN",
] as const;

export type EbayCellResult = {
  value: string;
  /** Restricted terms removed or reworded in this cell, for the review file. */
  removed: string[];
};

/**
 * One cell of an eBay listing file.
 *
 * Order matters and is deliberate: a constant wins over whatever was
 * resolved, because the constant IS the answer for that column; the
 * vendor-only identifiers are checked before the blank columns so a real
 * Variation Group ID survives; the description is cleaned before anything
 * looks for keywords in it, or the scrub reads attribute values as prose; and
 * every value is quote-stripped on its way out.
 */
export function ebayCellValue(ctx: EbayCellContext): EbayCellResult {
  const column = String(ctx.column ?? "").trim();
  const words = ctx.restricted ?? RESTRICTED_SEED;
  const path = String(ctx.categoryPath ?? "").trim();
  const field = (name: string) => meaningful(ctx.vendorValue?.(name) ?? ctx.resolve?.(name));

  if (column === EBAY_CATEGORY_ID_COLUMN) {
    // No category, or one the file has no id for: empty, never a guess. A 0
    // here is a real eBay category to somebody.
    return { value: path ? (ebayCategoryIdForPath(path) ?? "") : "", removed: [] };
  }
  if (column in EBAY_CONSTANTS) return { value: EBAY_CONSTANTS[column]!, removed: [] };
  if (EBAY_VENDOR_ONLY_COLUMNS.includes(column)) {
    // The vendor sheet or nothing. Checked BEFORE the normal resolution,
    // because that resolution is exactly what would hand back a UPC here.
    return { value: stripInvertedCommas(String(ctx.vendorValue?.(column) ?? "")), removed: [] };
  }
  if (EBAY_BLANK_COLUMNS.has(column)) return { value: "", removed: [] };

  const slot = itemSpecificSlot(column);
  if (slot) {
    const spec = EBAY_ITEM_SPECIFICS[slot.index];
    if (!spec) return { value: "", removed: [] };
    if (slot.kind === "Name") return { value: spec.name, removed: [] };
    const from = spec.from;
    let v = "";
    if (from && "column" in from) v = ctx.cell?.(from.column) ?? "";
    else if (from && "field" in from) v = field(from.field);
    else if (from && "typeSlug" in from) v = productTypeSlug(field("product_type"), path);
    return { value: stripInvertedCommas(v || spec.unknown || ""), removed: [] };
  }

  const pic = /^Picture URL (\d+)$/.exec(column);
  if (pic) {
    // The main image first, then the vendor's numbered extras (ImageUrl1 is
    // the SECOND picture). Web addresses only: the shared lookup's numbered
    // image match will otherwise return a flag column such as isMatchImage.
    const n = Number(pic[1]);
    const v = n === 1
      ? urlOnly(ctx.imageUrl) || urlOnly(ctx.vendorValue?.("ImageUrl")) || urlOnly(ctx.value)
      : urlOnly(ctx.vendorValue?.(`ImageUrl${n - 1}`));
    return { value: v, removed: [] };
  }

  if (column === "MPN") {
    // The vendor's model number, or the SKU without its vendor prefix — which
    // is what the vendor's own catalogue calls the item.
    const sku = String(ctx.sku ?? "");
    const v = meaningful(ctx.value) || field("model")
      || (warehouseLocationId(sku) ? sku.slice(sku.indexOf("-") + 1) : "");
    return { value: stripInvertedCommas(v), removed: [] };
  }
  if (column === "Warehouse Location ID") {
    const own = meaningful(ctx.value);
    return { value: own ? stripInvertedCommas(own) : warehouseLocationId(ctx.sku), removed: [] };
  }
  if (column === "Weight Major") {
    return {
      value: wholePounds(
        ctx.value,
        ctx.resolve?.("Weight Minor"),
        // The catalogue lookup writes its answer as Product Weight.
        meaningful(ctx.resolve?.("Product Weight")) || ctx.resolve?.("weight"),
      ),
      removed: [],
    };
  }
  if (column === "Length" || column === "Width" || column === "Height") {
    // A vendor sheet's column of zeros is not a measurement, and a 0 here
    // would be repeated into the item specifics as one. Length falls back to
    // Depth, which is what the catalogue lookup calls it.
    const dim = (v: unknown) => {
      const n = parseFloat(String(v ?? ""));
      return Number.isFinite(n) && n > 0 ? stripInvertedCommas(String(v).trim()) : "";
    };
    const v = dim(ctx.value) || (column === "Length" ? dim(ctx.resolve?.("Depth")) : "");
    return { value: v, removed: [] };
  }

  if (column === "Title" || column === "Brand") {
    const scrubbed = scrubRestricted(String(ctx.value ?? ""), words);
    return { value: stripInvertedCommas(scrubbed.text), removed: scrubbed.removed };
  }

  if (column === "Product Description") {
    const reworded = rewordRestricted(cleanDescriptionHtml(String(ctx.value ?? "")), words);
    // The heading is the row's own finished title, so the two never differ.
    const title = ctx.cell?.("Title") ?? String(ctx.resolve?.("Title") ?? "");
    const html = ebayDescriptionHtml({
      title,
      body: reworded.text,
      lightColor: lightColorOf(
        ctx.vendorValue?.("LightColor") ?? ctx.vendorValue?.("Light Color"),
        ctx.vendorValue?.("features") ?? ctx.resolve?.("features"),
      ),
      brand: String(ctx.brand || field("Brand")),
    });
    return { value: html, removed: reworded.removed };
  }

  return { value: stripInvertedCommas(String(ctx.value ?? "")), removed: [] };
}

/**
 * The restricted terms in force for a run: the seed, plus every term the
 * uploaded file's own Error column reported.
 *
 * The file's errors are worth more than the seed — they are this channel
 * manager refusing this seller's listings, not a guess about what it might
 * refuse — so they are never dropped, only added to.
 */
export function restrictedWordsForRun(errorTexts: Iterable<string>): string[] {
  const words = new Set(RESTRICTED_SEED.map((w) => w.toLowerCase()));
  for (const text of errorTexts) {
    for (const w of flaggedKeywordsFromError(text)) words.add(w);
  }
  return [...words];
}
