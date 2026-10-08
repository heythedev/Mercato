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
 * The four:
 *
 *   1. The category goes in TWO columns, as an id and as a path. CT
 *      ("Category") takes eBay's numeric id; DC ("Store Category Name 1")
 *      takes the human path. An id alone is unreadable to the person checking
 *      the file; a path alone is not what eBay keys on. Both, or neither is
 *      much use.
 *
 *   2. No inverted commas in any cell. A 72" garland ships as `72`, not
 *      `72"`. This is a house rule rather than an eBay one, and it is applied
 *      at the point every cell is written rather than per column, because a
 *      per-column rule is one that gets forgotten on column 150.
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
/** DC — the same category as a readable path. */
export const EBAY_CATEGORY_PATH_COLUMN = "Store Category Name 1";

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
 * Nothing vendor-specific is here. The reference file also had `Warehouse
 * Location ID` = VICK and a cost price in TBP; those belong to one vendor and
 * one commercial arrangement, and writing them onto every product of every
 * vendor would be wrong in a way nothing downstream would catch.
 */
export const EBAY_FORMAT_CONSTANTS: Record<string, string> = {
  "Localized For": "en_US",
  "Condition": "NEW",
  "Measurement System": "ENGLISH",
  "Channel ID": "EBAY_US",
  "Active": "1",
  "Minimum Advertised Price": "0",
  // The four variation axes eBay expects named, even on a product that has no
  // variations: the NAME column is the axis, the VALUE column beside it is
  // the product's own answer and is filled per product.
  "Variation Specific Name 1": "Color",
  "Variation Specific Name 2": "Size",
  "Variation Specific Name 3": "Material",
  "Variation Specific Name 4": "Style",
};

/** Constants that follow the seller's account setup rather than the format. */
export const EBAY_ACCOUNT_CONSTANTS: Record<string, string> = {
  "Shipping Policy": "2",
  "Payment Policy": "PayPal:Immediate pay",
  "Return Policy": "Returns Accepted 30 days",
  // A carrier service, in a column eBay's own schema calls a cost. That is
  // how the accepted file had it; it is not a typo here.
  "Domestic Shipping P1 Cost": "FEDEX_HOME",
};

export const EBAY_CONSTANTS: Record<string, string> = {
  ...EBAY_FORMAT_CONSTANTS,
  ...EBAY_ACCOUNT_CONSTANTS,
};

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
};

export type EbayCellResult = {
  value: string;
  /** Restricted terms removed from this cell, for the review file. */
  removed: string[];
};

/**
 * One cell of an eBay listing file.
 *
 * Order matters and is deliberate: a constant wins over whatever was
 * resolved, because the constant IS the answer for that column; the category
 * columns are answered from the assigned path; the description is cleaned
 * before anything looks for keywords in it, or the scrub reads attribute
 * values as prose; and the quote strip runs last so nothing written above can
 * reintroduce one.
 */
export function ebayCellValue(ctx: EbayCellContext): EbayCellResult {
  const column = String(ctx.column ?? "").trim();
  const words = ctx.restricted ?? RESTRICTED_SEED;
  const path = String(ctx.categoryPath ?? "").trim();

  let raw: string;
  if (column === EBAY_CATEGORY_ID_COLUMN) {
    // No category, or one the file has no id for: empty, never a guess and
    // never the 0 the reference file carried. A 0 here is a real eBay
    // category to somebody.
    raw = path ? (ebayCategoryIdForPath(path) ?? "") : "";
  } else if (column === EBAY_CATEGORY_PATH_COLUMN) {
    raw = path;
  } else if (column in EBAY_CONSTANTS) {
    raw = EBAY_CONSTANTS[column]!;
  } else {
    raw = String(ctx.value ?? "");
  }

  let removed: string[] = [];
  if (column === "Product Description") {
    raw = cleanDescriptionHtml(raw);
  }
  if (column === "Title" || column === "Product Description" || column === "Brand") {
    const scrubbed = scrubRestricted(raw, words);
    raw = scrubbed.text;
    removed = scrubbed.removed;
  }

  return { value: stripInvertedCommas(raw), removed };
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
