import { describe, expect, it } from "vitest";
import {
  EBAY_CATEGORY_ID_COLUMN,
  EBAY_CATEGORY_PATH_COLUMN,
  EBAY_CONSTANTS,
  cleanDescriptionHtml,
  ebayCellValue,
  flaggedKeywordsFromError,
  restrictedHitsIn,
  restrictedWordsForRun,
  scrubRestricted,
  stripInvertedCommas,
  variationAxisFor,
  wrapDescriptionParagraph,
} from "./ebay-template";

// The product these cases are built from is real: a Vickerman 72" garland
// whose listing this seller's channel manager refused, with the refusal text
// quoted verbatim below. Every rule here comes from comparing the file that
// was accepted against the one Mercato produced.

describe("no inverted commas in any cell", () => {
  it("drops the inch mark without welding words together", () => {
    expect(stripInvertedCommas('72" Red Deluxe Mixed Berry')).toBe("72 Red Deluxe Mixed Berry");
    expect(stripInvertedCommas('4"x10yd Blue Velvet')).toBe("4x10yd Blue Velvet");
  });

  it("takes the curly forms a copy-paste brings in", () => {
    expect(stripInvertedCommas("“9.5” Pine")).toBe("9.5 Pine");
    expect(stripInvertedCommas("2″ Ribbon")).toBe("2 Ribbon");
  });

  it("takes a doubled apostrophe, which is only ever an inch mark", () => {
    expect(stripInvertedCommas("9.5'' tree")).toBe("9.5 tree");
  });

  it("leaves a lone apostrophe alone", () => {
    // It is a letter in "don't" far more often than it is a foot mark, and
    // stripping it damages every description containing one.
    expect(stripInvertedCommas("Don't bend the wire")).toBe("Don't bend the wire");
  });
});

describe("the category, written twice", () => {
  const ctx = { value: "", categoryPath: "Antiques > Architectural & Garden > Beams" };

  it("puts eBay's numeric id in CT", () => {
    expect(ebayCellValue({ ...ctx, column: EBAY_CATEGORY_ID_COLUMN }).value).toBe("162927");
  });

  it("puts the readable path in DC", () => {
    expect(ebayCellValue({ ...ctx, column: EBAY_CATEGORY_PATH_COLUMN }).value).toBe(
      "Antiques > Architectural & Garden > Beams",
    );
  });

  it("keeps a category whose own name contains a comma", () => {
    const path = "Antiques > Architectural & Garden > Chandeliers, Sconces & Lighting Fixtures";
    expect(ebayCellValue({ column: EBAY_CATEGORY_ID_COLUMN, value: "", categoryPath: path }).value).toBe("63516");
    expect(ebayCellValue({ column: EBAY_CATEGORY_PATH_COLUMN, value: "", categoryPath: path }).value).toBe(path);
  });

  it("leaves both empty rather than writing the 0 the reference file carried", () => {
    // 0 is a real eBay category to somebody. An uncategorised product gets a
    // blank cell, which reads as a question; a 0 reads as an answer.
    for (const column of [EBAY_CATEGORY_ID_COLUMN, EBAY_CATEGORY_PATH_COLUMN]) {
      expect(ebayCellValue({ column, value: "0", categoryPath: null }).value).toBe("");
    }
  });

  it("leaves the id empty for a path eBay does not have", () => {
    const made_up = "Furniture > Invented > Nonsense";
    expect(ebayCellValue({ column: EBAY_CATEGORY_ID_COLUMN, value: "", categoryPath: made_up }).value).toBe("");
    // The path still goes in, so the mismatch is visible in the file rather
    // than looking like an uncategorised row.
    expect(ebayCellValue({ column: EBAY_CATEGORY_PATH_COLUMN, value: "", categoryPath: made_up }).value).toBe(made_up);
  });
});

describe("the columns that are the same on every row", () => {
  it("writes the constant over whatever was resolved", () => {
    // A constant IS the answer for its column, so a stale value from the
    // vendor sheet must not win.
    expect(ebayCellValue({ column: "Channel ID", value: "EBAY_UK" }).value).toBe("EBAY_US");
    expect(ebayCellValue({ column: "Condition", value: "" }).value).toBe("NEW");
    expect(ebayCellValue({ column: "Measurement System", value: "METRIC" }).value).toBe("ENGLISH");
  });

  it("names the four variation axes but fills their values per product", () => {
    expect(ebayCellValue({ column: "Variation Specific Name 1", value: "" }).value).toBe("Color");
    // The value column beside it is the product's own answer.
    expect(ebayCellValue({ column: "Variation Specific Value 1", value: "Royal Blue" }).value).toBe("Royal Blue");
  });

  it("carries nothing vendor-specific", () => {
    // The reference file had Warehouse Location ID = VICK and a cost price in
    // TBP. Those belong to one vendor and one commercial arrangement; writing
    // them onto every product would be wrong and nothing downstream checks.
    expect(EBAY_CONSTANTS["Warehouse Location ID"]).toBeUndefined();
    expect(EBAY_CONSTANTS["TBP"]).toBeUndefined();
    expect(EBAY_CONSTANTS["CANA Price"]).toBeUndefined();
  });
});

describe("reading the channel manager's own refusals", () => {
  // Verbatim from the uploaded file, misspelling included.
  const one = "VICK-P240772 - Restrictrted Keyword found in Title-'' OR Description -'Garland' OR Brand -''.";
  const two = "VICK-QK242550 - Restrictrted Keyword found in Title-'' OR Description -'ensure,ensure' OR Brand -''.";

  it("pulls the term out of one refusal", () => {
    expect(flaggedKeywordsFromError(one)).toEqual(["garland"]);
  });

  it("does not report a keyword called empty-string for the clean fields", () => {
    // Title-'' and Brand-'' are the common case: that field was fine.
    expect(flaggedKeywordsFromError(one)).not.toContain("");
  });

  it("splits a field that tripped twice, and de-duplicates", () => {
    expect(flaggedKeywordsFromError(two)).toEqual(["ensure"]);
  });

  it("ignores an error about something else entirely", () => {
    expect(flaggedKeywordsFromError("VICK-X1 - Image URL 1 is not reachable")).toEqual([]);
  });

  it("survives them fixing their own spelling", () => {
    expect(
      flaggedKeywordsFromError("VICK-X1 - Restricted Keyword found in Title-'Yeti' OR Description -''."),
    ).toEqual(["yeti"]);
  });

  it("adds what the file reported to the seed, never replacing it", () => {
    const words = restrictedWordsForRun([one, "VICK-X1 - Restricted Keyword found in Title-'Foobrand' OR x -''."]);
    expect(words).toContain("foobrand");
    // The seed survives.
    expect(words).toContain("garland");
    expect(words).toContain("apple");
  });
});

describe("matching a restricted term", () => {
  const words = ["gap", "apple", "north face"];

  it("matches a whole word only", () => {
    expect(restrictedHitsIn("Leave a gap between loops", words)).toEqual(["gap"]);
    // A filter that fires on "gaps" or "pineapple" is a filter somebody
    // switches off, and then it catches nothing.
    expect(restrictedHitsIn("Close the gaps evenly", words)).toEqual([]);
    expect(restrictedHitsIn("Pineapple scented", words)).toEqual([]);
  });

  it("matches a term that is two words", () => {
    expect(restrictedHitsIn("Styled after the north face of the ridge", words)).toEqual(["north face"]);
  });

  it("ignores case", () => {
    expect(restrictedHitsIn("APPLE red finish", words)).toEqual(["apple"]);
  });
});

describe("correcting a refused listing", () => {
  it("removes the term and reports it", () => {
    const { text, removed } = scrubRestricted(
      "<p>Vickerman 72 Red Deluxe Mixed Berry Garland. Rated for indoor use.</p>",
      ["garland"],
    );
    expect(removed).toEqual(["garland"]);
    expect(text.toLowerCase()).not.toContain("garland");
    // The sentence still reads, and the markup around it survives.
    expect(text).toContain("Vickerman 72 Red Deluxe Mixed Berry");
    expect(text).toContain("Rated for indoor use.");
    expect(text).toContain("<p>");
  });

  it("does not weld the neighbours together", () => {
    const { text } = scrubRestricted("A garland for the door", ["garland"]);
    expect(text).not.toContain("Afor");
    expect(text).toBe("A for the door");
  });

  it("leaves a clean description untouched, and reports nothing", () => {
    const input = "<p>Vickerman 4 Blue Jacquard Ribbon.</p>";
    const { text, removed } = scrubRestricted(input, ["garland", "ensure"]);
    expect(text).toBe(input);
    expect(removed).toEqual([]);
  });

  it("reports what it removed through ebayCellValue, for the review file", () => {
    const out = ebayCellValue({
      column: "Product Description",
      value: "<p>A Garland that will ensure the shape holds.</p>",
    });
    // Both terms this seller has actually been refused for.
    expect(out.removed.sort()).toEqual(["ensure", "garland"]);
    expect(out.value.toLowerCase()).not.toMatch(/garland|ensure/);
  });

  it("checks the three fields the channel manager checks, and no others", () => {
    // Its error text names Title, Description and Brand. A term in a colour
    // or a size is not what gets a listing refused, and scrubbing those
    // would damage data for no gain.
    expect(ebayCellValue({ column: "Title", value: "Garland 72 Red" }).removed).toEqual(["garland"]);
    expect(ebayCellValue({ column: "Brand", value: "Apple" }).removed).toEqual(["apple"]);
    expect(ebayCellValue({ column: "Variation Specific Value 1", value: "Apple Red" }).removed).toEqual([]);
    expect(ebayCellValue({ column: "Variation Specific Value 1", value: "Apple Red" }).value).toBe("Apple Red");
  });
});

describe("the description, as prose rather than as a page", () => {
  it("unwraps the vendor site's own template fragment", () => {
    // This is verbatim what Mercato was writing: a Knockout binding, which
    // renders as an empty heading and whose text was never in the HTML.
    const scraped = '<h1 class="product-name" data-bind="text: product().name">72 Red Deluxe</h1>';
    const out = cleanDescriptionHtml(scraped);
    expect(out).not.toContain("data-bind");
    expect(out).not.toContain("<h1");
    expect(out).not.toContain("class=");
    // The text inside was the description; only the markup was the problem.
    expect(out).toContain("72 Red Deluxe");
  });

  it("keeps the tags a description legitimately uses, without their attributes", () => {
    const out = cleanDescriptionHtml('<p class="desc">Garland <strong id="x">72</strong></p>');
    expect(out).toBe("<p>Garland <strong>72</strong></p>");
  });

  it("keeps a bullet list, which is how this vendor writes features", () => {
    const out = cleanDescriptionHtml("<ul><li>LightColor Unlit</li><li>Brand Vickerman</li></ul>");
    expect(out).toBe("<ul><li>LightColor Unlit</li><li>Brand Vickerman</li></ul>");
  });

  it("throws away script and style entirely, contents and all", () => {
    const out = cleanDescriptionHtml('<p>Red</p><script>var x="Garland";</script><style>p{color:red}</style>');
    expect(out).toBe("<p>Red</p>");
  });

  it("is cleaned before anything looks for keywords in it", () => {
    // Otherwise a term inside an attribute value counts as prose, and the
    // scrub reports a removal from text no buyer would ever have seen.
    const out = ebayCellValue({
      column: "Product Description",
      value: '<div data-track="garland-page"><p>Red Deluxe Mixed Berry</p></div>',
    });
    expect(out.removed).toEqual([]);
    expect(out.value).toContain("Red Deluxe Mixed Berry");
  });
});

describe("the variation value columns", () => {
  it("take the field their own name column declares", () => {
    // Nothing has a field called "variationspecificvalue1", so resolving the
    // header text got nothing and nothing errored — four empty value columns
    // beside four correctly-filled name columns, in the finished file.
    expect(variationAxisFor("Variation Specific Value 1")).toBe("Color");
    expect(variationAxisFor("Variation Specific Value 3")).toBe("Material");
    expect(variationAxisFor("Variation Specific Name 1")).toBeNull();
    expect(variationAxisFor("Title")).toBeNull();
  });

  it("resolves through the axis, not the header", () => {
    const out = ebayCellValue({
      column: "Variation Specific Value 1",
      value: "",
      resolve: (field) => (field === "Color" ? "Royal Blue" : ""),
    });
    expect(out.value).toBe("Royal Blue");
  });

  it("falls back to whatever was resolved when the product has no such axis", () => {
    // Size, Material and Style are empty on most of this vendor's products.
    const out = ebayCellValue({ column: "Variation Specific Value 3", value: "", resolve: () => "" });
    expect(out.value).toBe("");
  });
});

describe("the description wrapper", () => {
  it("wraps plain text, because the exporter has already stripped the markup", () => {
    expect(wrapDescriptionParagraph("Royal Blue Velvet.")).toBe("<p>Royal Blue Velvet.</p>");
  });

  it("leaves text that still has markup alone", () => {
    expect(wrapDescriptionParagraph("<p>Already wrapped.</p>")).toBe("<p>Already wrapped.</p>");
  });

  it("leaves an empty cell empty", () => {
    // An empty <p></p> is markup claiming there is a description.
    expect(wrapDescriptionParagraph("")).toBe("");
    expect(wrapDescriptionParagraph("   ")).toBe("");
  });
});
