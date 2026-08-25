import { describe, it, expect } from "vitest";
import { extractPackInfo, extractPackQty, filterPackCompatible, livePackQty, stripPackPhrases } from "./verify";

describe("extractPackInfo", () => {
  it("treats explicit packaging terms as strong signals", () => {
    expect(extractPackInfo("Kitchen Towels Pack of 6")).toEqual({ qty: 6, strong: true, explicit: true });
    expect(extractPackInfo("Coasters Set of 4")).toEqual({ qty: 4, strong: true, explicit: true });
    expect(extractPackInfo("Trivets 12 ct")).toEqual({ qty: 12, strong: true, explicit: true });
    expect(extractPackInfo("Wholesale CASE of 10 Pot Holders")).toEqual({ qty: 10, strong: true, explicit: true });
    // Live Amazon listings use "Carton of N" the way others use "Case of N" —
    // it was invisible, letting a 10-carton pass as a single unit.
    expect(extractPackInfo("Air Vent Automatic Foundation Vents (Carton of 10) (Black)"))
      .toEqual({ qty: 10, strong: true, explicit: true });
  });

  it("treats counting words as weak signals", () => {
    // "3-Piece Sectional Sofa" is one sofa in three modules, not a 3-pack —
    // this was the client's main pack false-positive.
    expect(extractPackInfo("3-Piece Sectional Sofa")).toEqual({ qty: 3, strong: false, explicit: true });
    expect(extractPackInfo("Widget 6 units")).toEqual({ qty: 6, strong: false, explicit: true });
  });

  it("no longer reads a product-type word 'case' as a quantity", () => {
    // "iPhone 15 Case" used to extract qty 15.
    expect(extractPackInfo("iPhone 15 Case")).toEqual({ qty: 1, strong: false, explicit: false });
  });

  it("lets a strong description signal beat a weak title signal", () => {
    expect(extractPackInfo("3-Piece Towel Bundle", "Sold as a pack of 2 bundles"))
      .toEqual({ qty: 2, strong: true, explicit: true });
  });

  it("defaults to a single unit when nothing is stated", () => {
    expect(extractPackInfo("Ceramic Mug")).toEqual({ qty: 1, strong: false, explicit: false });
  });

  it("lets a real count beat a '(Pack of 1)' ship-pack suffix", () => {
    // Vendor feeds append "(Pack of N)" ship quantity to every row; with N=1
    // it must not mask the product's intrinsic count — this vetoed correct
    // UPC matches and reported live Amazon products as Not Found.
    expect(extractPackInfo("PENCIL DEEP REACH 5CT (Pack of 1)"))
      .toEqual({ qty: 5, strong: true, explicit: true });
    expect(extractPackInfo("STAPLE ARROW T50 15PK(Pack of 1)"))
      .toEqual({ qty: 15, strong: true, explicit: true });
  });

  it("keeps a '(Pack of N)' suffix authoritative when N > 1", () => {
    expect(extractPackInfo("AUST TMBR AMBRWD WF QT (Pack of 4)"))
      .toEqual({ qty: 4, strong: true, explicit: true });
  });

  it("still reads a bare '(Pack of 1)' as a single unit", () => {
    expect(extractPackInfo("BATTRY ALKLN DURA 9V CD2 (Pack of 1)"))
      .toEqual({ qty: 1, strong: true, explicit: true });
  });

  it("reads 'Pkg of N' / 'Package of N' like 'Pack of N'", () => {
    expect(extractPackInfo("Design Imports Kitchen Towel, Pkg of 5"))
      .toEqual({ qty: 5, strong: true, explicit: true });
    expect(extractPackInfo("Wall Hooks Package of 2"))
      .toEqual({ qty: 2, strong: true, explicit: true });
  });

  it("reads 'Quantity N' as a strong signal", () => {
    expect(extractPackInfo("Air Freshener Refill, Linen Scent, Quantity 10"))
      .toEqual({ qty: 10, strong: true, explicit: true });
  });

  it("reads slash-form pack counts from live titles", () => {
    // Real stored EMRY liveData rows the parser used to read as singles.
    expect(extractPackInfo("24/Pack 3M Scotch-Blue 2090-48A 1.88IN X 60YD Painters Tape BL"))
      .toEqual({ qty: 24, strong: true, explicit: true });
    expect(extractPackInfo("Scotch 209048EVP Painter's Tape, 1.88-Inch x 60yds, 3-Inch Core, Blue, 3/Pack"))
      .toEqual({ qty: 3, strong: true, explicit: true });
    expect(extractPackInfo('Hillman Split Lock Washer 5/16 " Hot Dip Galvanized 100/Box'))
      .toEqual({ qty: 100, strong: true, explicit: true });
    expect(extractPackInfo("3M Scotch Sure Start Shipping Packaging Tape (00051141914558) (12/Each)"))
      .toEqual({ qty: 12, strong: true, explicit: true });
  });

  it("keeps fractional sizes out of the slash-form patterns", () => {
    expect(extractPackInfo('Hillman Hex Cap Screw 1/4 " - 20 X 1 " Zinc Dichromate Grade 8'))
      .toEqual({ qty: 1, strong: false, explicit: false });
  });

  it("reads 'N per box' and distributor 'NBx' shorthand", () => {
    expect(extractPackInfo("Split Lock Washer, 100 per box"))
      .toEqual({ qty: 100, strong: true, explicit: true });
    expect(extractPackInfo('King Safety Products 70112 Staple Insul 9/16" 100Bx'))
      .toEqual({ qty: 100, strong: true, explicit: true });
  });

  it("lets a slash-form count beat the '(Pack of 1)' ship-pack suffix", () => {
    expect(extractPackInfo("MASKNG TAPE 24/Pack (Pack of 1)"))
      .toEqual({ qty: 24, strong: true, explicit: true });
  });

  it("reads a bare trailing '(N)' as a weak count", () => {
    // Some Amazon multipack listings end with just "(5)" and no pack word.
    expect(extractPackInfo("Farmhouse Coir Doormat, Natural (5)"))
      .toEqual({ qty: 5, strong: false, explicit: true });
    // Weak so that a mismatch needs the other side to be explicit too;
    // a 3-digit trailing number (LED counts, model numbers) never matches.
    expect(extractPackInfo("String Lights Warm White (120)"))
      .toEqual({ qty: 1, strong: false, explicit: false });
    // Mid-title parentheses are not a trailing count.
    expect(extractPackInfo("Widget (5) Deluxe Edition"))
      .toEqual({ qty: 1, strong: false, explicit: false });
  });
});

describe("livePackQty", () => {
  it("trusts the structured packageQuantity when the title says nothing", () => {
    // The client's real failure: UPC shared across pack sizes, multipack
    // listing with a pack-wordless title, packageQuantity 5 stored but ignored.
    expect(livePackQty({ title: "Empire Level Magnetic Torpedo Level", packageQuantity: 5 })).toBe(5);
  });

  it("lets the title win when it claims more than the structured field", () => {
    // packageQuantity 1 but the title's "(5)" is the truth.
    expect(livePackQty({ title: "Coir Doormat, Natural (5)", packageQuantity: 1 })).toBe(5);
  });

  it("falls back to title text when no structured field exists", () => {
    expect(livePackQty({ title: "Kitchen Towels Pack of 6" })).toBe(6);
    expect(livePackQty({ title: "Ceramic Mug" })).toBe(1);
  });
});

describe("filterPackCompatible", () => {
  it("rejects a multipack candidate by structured qty even when its title has no pack wording", () => {
    const single = { title: "Torpedo Level 9 in", packageQuantity: 1 };
    const fivePack = { title: "Torpedo Level 9 in", packageQuantity: 5 };
    expect(filterPackCompatible("TORPEDO LEVEL 9IN (Pack of 1)", [fivePack, single]))
      .toEqual([single]);
  });
});

describe("extractPackQty", () => {
  it("keeps the plain-number contract for candidate filtering", () => {
    expect(extractPackQty("Kitchen Towels Pack of 6")).toBe(6);
    expect(extractPackQty("3-Piece Sectional Sofa")).toBe(3);
    expect(extractPackQty("Ceramic Mug")).toBe(1);
  });
});

describe("stripPackPhrases", () => {
  it("removes the pack phrasings seen on live Amazon multipack titles", () => {
    expect(stripPackPhrases("Air Vent RAGR Automatic Foundation Vent, Bi-Metal Coil - Quantity 10"))
      .toBe("Air Vent RAGR Automatic Foundation Vent, Bi-Metal Coil");
    expect(stripPackPhrases("Howard RF4016 Restor-A-Finish, Pint, Dark Oak (Pkg of 5)"))
      .toBe("Howard RF4016 Restor-A-Finish, Pint, Dark Oak");
    expect(stripPackPhrases("Kitchen Towels (Pack of 6)")).toBe("Kitchen Towels");
    expect(stripPackPhrases("Welcome Doormat (5)")).toBe("Welcome Doormat");
  });

  it("removes slash-form and per-box pack phrasings", () => {
    expect(stripPackPhrases("24/Pack 3M Scotch-Blue 2090-48A Painters Tape"))
      .toBe("3M Scotch-Blue 2090-48A Painters Tape");
    expect(stripPackPhrases("Hillman Split Lock Washer 100/Box"))
      .toBe("Hillman Split Lock Washer");
    expect(stripPackPhrases("Machine Screw Nut, 100 per box"))
      .toBe("Machine Screw Nut");
    expect(stripPackPhrases('Staple Insul 9/16" 100Bx')).toBe('Staple Insul 9/16"');
  });

  it("leaves titles without pack phrasing untouched", () => {
    expect(stripPackPhrases("3-Piece Sectional Sofa")).toBe("3-Piece Sectional Sofa");
    expect(stripPackPhrases("Ceramic Mug")).toBe("Ceramic Mug");
  });
});
