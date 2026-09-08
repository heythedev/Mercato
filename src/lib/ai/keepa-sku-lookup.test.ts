import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/keepa", () => ({
  finder: vi.fn(async () => ({ asinList: [], total: 0, tokens: null })),
  getProducts: vi.fn(async () => []),
  KeepaError: class KeepaError extends Error {},
}));

import { finder, getProducts } from "@/lib/keepa";
import { resolveSkusViaKeepa, skuItemNumber, skuVendorPrefix } from "./keepa-sku-lookup";

const product = (over: Record<string, unknown> = {}) => ({
  asin: "B0BS3FSWT9",
  partNumber: "134804",
  brand: "vidaXL",
  title: 'vidaXL 37"x63" Velvet Blackout Curtains with Rings 2 pcs in Black',
  images: [{ l: "41IqE5x1GPL.jpg", m: "31rtuZbHeqL.jpg" }],
  eanList: ["8720286040072"],
  categoryTree: [{ name: "Home & Kitchen" }, { name: "Window Treatments" }],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("skuVendorPrefix / skuItemNumber", () => {
  it("splits a prefixed sheet code into vendor and item number", () => {
    expect(skuVendorPrefix("VIDA-134804")).toBe("VIDA");
    expect(skuItemNumber("VIDA-134804")).toBe("134804");
  });

  it("has no vendor prefix when the code carries none", () => {
    expect(skuVendorPrefix("134804")).toBeNull();
    expect(skuItemNumber("134804")).toBe("134804");
  });
});

describe("resolveSkusViaKeepa", () => {
  it("returns the match keyed by item number, with barcode, image and category hint", async () => {
    vi.mocked(finder).mockResolvedValueOnce({ asinList: ["B0BS3FSWT9"], total: 1, tokens: null });
    vi.mocked(getProducts).mockResolvedValueOnce([product()] as never);

    const out = await resolveSkusViaKeepa(["134804"], "vidaXL");

    expect(out.get("134804")).toMatchObject({
      name: 'vidaXL 37"x63" Velvet Blackout Curtains with Rings 2 pcs in Black',
      brand: "vidaXL",
      upc: "8720286040072",
      imageUrl: "https://m.media-amazon.com/images/I/41IqE5x1GPL.jpg",
      categoryHint: "Home & Kitchen > Window Treatments",
    });
    // The brand MUST be pinned — an unbranded part-number search matches
    // unrelated products from other manufacturers.
    expect(vi.mocked(finder).mock.calls[0]![1]).toMatchObject({ brand: ["vidaxl"], partNumber: ["134804"] });
  });

  it("refuses to search at all without a brand", async () => {
    const out = await resolveSkusViaKeepa(["134804"], "   ");
    expect(out.size).toBe(0);
    expect(vi.mocked(finder)).not.toHaveBeenCalled();
  });

  it("drops a product whose partNumber is not the code we asked for", async () => {
    vi.mocked(finder).mockResolvedValueOnce({ asinList: ["B000OTHER"], total: 1, tokens: null });
    vi.mocked(getProducts).mockResolvedValueOnce([product({ partNumber: "999999", asin: "B000OTHER" })] as never);
    const out = await resolveSkusViaKeepa(["134804"], "vidaXL");
    expect(out.size).toBe(0);
  });

  it("keeps the first listing when several share one partNumber", async () => {
    vi.mocked(finder).mockResolvedValueOnce({ asinList: ["A1", "A2"], total: 2, tokens: null });
    vi.mocked(getProducts).mockResolvedValueOnce([
      product({ asin: "A1", title: "First listing" }),
      product({ asin: "A2", title: "Second listing" }),
    ] as never);
    const out = await resolveSkusViaKeepa(["134804"], "vidaXL");
    expect(out.get("134804")?.asin).toBe("A1");
  });

  it("never throws when Keepa fails — it just resolves nothing", async () => {
    vi.mocked(finder).mockRejectedValueOnce(new Error("out of tokens"));
    const out = await resolveSkusViaKeepa(["134804"], "vidaXL");
    expect(out.size).toBe(0);
  });
});
