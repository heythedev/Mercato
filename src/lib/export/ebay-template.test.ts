import { describe, expect, it } from "vitest";
import {
  EBAY_CATEGORY_ID_COLUMN,
  EBAY_CONSTANTS,
  EBAY_ITEM_SPECIFICS,
  cleanDescriptionHtml,
  ebayCellValue,
  flaggedKeywordsFromError,
  restrictedHitsIn,
  restrictedWordsForRun,
  scrubRestricted,
  lightColorOf,
  productTypeSlug,
  rewordRestricted,
  stripInvertedCommas,
  warehouseLocationId,
  wholePounds,
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

describe("the category", () => {
  const ctx = { value: "", categoryPath: "Antiques > Architectural & Garden > Beams" };

  it("puts eBay's numeric id in Category", () => {
    expect(ebayCellValue({ ...ctx, column: EBAY_CATEGORY_ID_COLUMN }).value).toBe("162927");
  });

  it("leaves Store Category Name 1 empty, as the seller's file does", () => {
    // A store category on the seller's eBay shop, not a label for the eBay
    // category.
    expect(ebayCellValue({ ...ctx, column: "Store Category Name 1", value: "Beams" }).value).toBe("");
  });

  it("keeps a category whose own name contains a comma", () => {
    const path = "Antiques > Architectural & Garden > Chandeliers, Sconces & Lighting Fixtures";
    expect(ebayCellValue({ column: EBAY_CATEGORY_ID_COLUMN, value: "", categoryPath: path }).value).toBe("63516");
  });

  it("leaves the id empty rather than writing a 0", () => {
    // 0 is a real eBay category to somebody. An uncategorised product gets a
    // blank cell, which reads as a question; a 0 reads as an answer.
    expect(ebayCellValue({ column: EBAY_CATEGORY_ID_COLUMN, value: "0", categoryPath: null }).value).toBe("");
  });

  it("leaves the id empty for a path eBay does not have", () => {
    const made_up = "Furniture > Invented > Nonsense";
    expect(ebayCellValue({ column: EBAY_CATEGORY_ID_COLUMN, value: "", categoryPath: made_up }).value).toBe("");
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

  it("writes the seller's own policy names and per-row constants", () => {
    expect(ebayCellValue({ column: "Shipping Policy", value: "2" }).value).toBe("2 business days GS");
    expect(ebayCellValue({ column: "Payment Policy", value: "" }).value).toBe("eBay managed Payment");
    expect(ebayCellValue({ column: "Total Ship To Home Quantity", value: "" }).value).toBe("1");
    expect(ebayCellValue({ column: "CANA Price", value: "" }).value).toBe("0");
  });

  it("leaves the variation and extra columns empty", () => {
    // A filled variation pair makes a product one variation of a listing.
    for (const column of [
      "Variation Specific Name 1", "Variation Specific Value 1", "Variation Specific Value 3",
      "Additional Info", "Weight Minor", "Minimum Advertised Price", "Error",
    ]) {
      expect(ebayCellValue({ column, value: "Green" }).value, column).toBe("");
    }
  });

  it("carries nothing vendor-specific", () => {
    // VICK is derived from each SKU, never written onto every vendor.
    expect(EBAY_CONSTANTS["Warehouse Location ID"]).toBeUndefined();
    expect(EBAY_CONSTANTS["TBP"]).toBeUndefined();
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
    expect(ebayCellValue({ column: "Subtitle", value: "Apple Red" }).removed).toEqual([]);
    expect(ebayCellValue({ column: "Subtitle", value: "Apple Red" }).value).toBe("Apple Red");
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

describe("rewording rather than deleting", () => {
  it("swaps garland and ensure for words that keep the sentence whole", () => {
    // Deleting left "This durable is maintenance free" 154 times in one file.
    const { text, removed } = rewordRestricted(
      "This durable garland is maintenance free. Garlands and wreaths ensure a full look.",
      ["garland", "ensure"],
    );
    expect(text).toBe("This durable trim is maintenance free. Trims and wreaths make sure a full look.");
    expect(removed.sort()).toEqual(["ensure", "garland"]);
  });

  it("still removes a term that has no safe stand-in", () => {
    expect(rewordRestricted("A red apple finish", ["apple"]).text).toBe("A red finish");
  });

  it("leaves a word alone when it is not restricted for this run", () => {
    expect(rewordRestricted("A garland", ["apple"]).text).toBe("A garland");
  });
});

describe("the description, laid out as the seller's file lays it", () => {
  const out = ebayCellValue({
    column: "Product Description",
    value: "Vickerman 9' Camdon Fir Artificial Christmas Garland with 240 PVC Tips.",
    brand: "Vickerman",
    cell: (c) => (c === "Title" ? "Vickerman 9' x 12 Camdon Fir 240 Tips - A861105" : ""),
    vendorValue: (f) => (f === "features" ? "<li>1020 PVC tips</li><li>Light_Color: Warm White</li>" : undefined),
  });

  it("opens with the row's title as the heading", () => {
    expect(out.value.startsWith(
      `<h1 class="product-name" data-bind="text: product().displayName()">Vickerman 9' x 12 Camdon Fir 240 Tips - A861105</h1>`,
    )).toBe(true);
  });

  it("then the copy, reworded, then the bullets, then the return policy", () => {
    expect(out.value).toContain(
      "<p>Vickerman 9' Camdon Fir Artificial Christmas Trim with 240 PVC Tips.</p>"
      + "<li>LightColor Warm White</li><li>Brand Vickerman</li><p>Return Policy</p>",
    );
    expect(out.value).toContain("<li>For Damaged/defective items received- contact us within 48 hrs");
    expect(out.removed).toEqual(["garland"]);
  });

  it("says Unlit when the vendor names no light colour", () => {
    expect(lightColorOf(undefined, "<li>1020 PVC tips</li>")).toBe("Unlit");
    expect(lightColorOf("Multi", "")).toBe("Multi");
  });
});

describe("the item specifics", () => {
  const row: Record<string, string> = {
    Brand: "Vickerman", UPC: "734205209141", MPN: "A801000", Length: "17", Width: "17", Height: "",
  };
  const value = (n: number, vendor: Record<string, string> = {}) =>
    ebayCellValue({
      column: `Attribute Value ${n}`,
      value: "",
      categoryPath: "Home & Garden > Holiday & Seasonal Décor > Christmas Trees",
      cell: (c) => row[c] ?? "",
      vendorValue: (f) => vendor[f],
    }).value;

  it("names all fourteen in the seller's order", () => {
    expect(EBAY_ITEM_SPECIFICS.map((s) => s.name)).toEqual([
      "Brand", "UPC", "MPN", "Model No.", "Color", "Size", "Item Length", "Item Width",
      "Item Height", "Type", "Material", "Model", "Installation No", "Product",
    ]);
    expect(ebayCellValue({ column: "Attribute Name 7", value: "" }).value).toBe("Item Length");
    expect(ebayCellValue({ column: "Attribute Name 15", value: "x" }).value).toBe("");
  });

  it("repeats the row's own identifiers and dimensions", () => {
    expect(value(2)).toBe("734205209141");
    expect(value(4)).toBe("A801000");
    expect(value(7)).toBe("17");
  });

  it("answers an unknown the way the seller's blank row does", () => {
    expect(value(5)).toBe("As shown");
    expect(value(6)).toBe("As described");
    expect(value(9)).toBe("As described");
    // A vendor 0 is not a material.
    expect(value(11, { Material: "0" })).toBe("As described");
    expect(value(13)).toBe("");
  });

  it("takes the type from the vendor, else from the category", () => {
    expect(value(10, { product_type: "christmas-garlands" })).toBe("christmas-garlands");
    expect(value(14)).toBe("christmas-trees");
    expect(productTypeSlug("0", "A > Wreaths, Garlands & Plants")).toBe("wreaths-garlands-plants");
  });
});

describe("the columns derived per product", () => {
  it("takes the warehouse from the SKU prefix", () => {
    expect(warehouseLocationId("VICK-A801000")).toBe("VICK");
    expect(warehouseLocationId("A801000")).toBe("");
    expect(ebayCellValue({ column: "Warehouse Location ID", value: "", sku: "VICK-A1" }).value).toBe("VICK");
  });

  it("falls back to the SKU without its prefix for MPN", () => {
    expect(ebayCellValue({ column: "MPN", value: "", sku: "VICK-A801000" }).value).toBe("A801000");
    expect(ebayCellValue({
      column: "MPN", value: "", sku: "VICK-A1", vendorValue: (f) => (f === "model" ? "M-9" : undefined),
    }).value).toBe("M-9");
  });

  it("leaves a 0 dimension empty, and takes Length from Depth", () => {
    expect(ebayCellValue({ column: "Height", value: "0" }).value).toBe("");
    expect(ebayCellValue({ column: "Width", value: "12" }).value).toBe("12");
    expect(ebayCellValue({
      column: "Length", value: "", resolve: (f) => (f === "Depth" ? "108" : ""),
    }).value).toBe("108");
  });

  it("writes whole pounds, rounded up", () => {
    expect(wholePounds("2", "9", "")).toBe("3");
    expect(wholePounds("", "", "0.84 lbs")).toBe("1");
    expect(wholePounds("", "", "")).toBe("");
  });

  it("puts only web addresses in the picture columns", () => {
    const vendor: Record<string, string> = { ImageUrl1: "https://x/2.jpg", ImageUrl2: "0" };
    const pic = (n: number) => ebayCellValue({
      column: `Picture URL ${n}`, value: "0", imageUrl: "https://x/1.jpg", vendorValue: (f) => vendor[f],
    }).value;
    expect(pic(1)).toBe("https://x/1.jpg");
    expect(pic(2)).toBe("https://x/2.jpg");
    expect(pic(3)).toBe("");
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
