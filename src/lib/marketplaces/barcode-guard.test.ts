import { describe, expect, it } from "vitest";
import { codeDigitsKey, contradictsVendorBarcode } from "./verify";

// The keyword cascade can only guess by wording, so a candidate that exposes
// barcodes NOT including the vendor's UPC is a different physical product.
// Real case: vendor "MOSQUITO REPEL GRANUL 4K (Pack of 3)" UPC 037321056126
// keyword-matched "Repel 100 ... 3 Pack" (UPC 011423342103) — same purpose,
// matching pack count, wrong product. The guard must reject it.

const keys = (...codes: string[]) => new Set(codes.map(codeDigitsKey));
const none = new Set<string>();

describe("codeDigitsKey", () => {
  it("equates UPC-12 / EAN-13 / GTIN-14 zero-padding variants", () => {
    expect(codeDigitsKey("037321056126")).toBe(codeDigitsKey("0037321056126"));
    expect(codeDigitsKey("037321056126")).toBe(codeDigitsKey("00037321056126"));
  });
  it("strips non-digits", () => {
    expect(codeDigitsKey(" 0-37321-05612-6 ")).toBe("37321056126");
  });
});

describe("contradictsVendorBarcode", () => {
  it("rejects a candidate whose barcodes are known and all differ (the Repel case)", () => {
    expect(contradictsVendorBarcode(
      { barcodes: ["011423342103"], brand: "Repel" },
      keys("037321056126"),
      none,
    )).toBe(true);
  });

  it("accepts a candidate that carries the vendor barcode in any padding variant", () => {
    expect(contradictsVendorBarcode(
      { barcodes: ["0037321056126"], brand: "Spectracide" },
      keys("037321056126"),
      none,
    )).toBe(false);
  });

  it("accepts a candidate among several barcodes when one matches", () => {
    expect(contradictsVendorBarcode(
      { barcodes: ["011423342103", "037321056126"], brand: "X" },
      keys("037321056126"),
      none,
    )).toBe(false);
  });

  it("never contradicts when the candidate exposes no barcode data", () => {
    expect(contradictsVendorBarcode({ barcodes: [], brand: "X" }, keys("037321056126"), none)).toBe(false);
    expect(contradictsVendorBarcode({ brand: "X" }, keys("037321056126"), none)).toBe(false);
  });

  it("never contradicts when the vendor has no barcode", () => {
    expect(contradictsVendorBarcode(
      { barcodes: ["011423342103"], brand: "X" },
      none,
      none,
    )).toBe(false);
  });

  it("lets pack siblings of a UPC-confirmed match through by brand", () => {
    // DAP 3-pack listing has its own barcode; the set-aside 5-pack confirmed
    // the DAP identity via the vendor UPC, so brand DAP passes.
    expect(contradictsVendorBarcode(
      { barcodes: ["070798214019"], brand: "DAP" },
      keys("070798214002"),
      new Set(["dap"]),
    )).toBe(false);
    // A different brand with a different barcode still contradicts.
    expect(contradictsVendorBarcode(
      { barcodes: ["070798214019"], brand: "Minwax" },
      keys("070798214002"),
      new Set(["dap"]),
    )).toBe(true);
  });

  it("brand allowance is case-insensitive", () => {
    expect(contradictsVendorBarcode(
      { barcodes: ["070798214019"], brand: "  Dap " },
      keys("070798214002"),
      new Set(["dap"]),
    )).toBe(false);
  });
});
