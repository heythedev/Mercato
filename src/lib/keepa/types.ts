export interface KeepaCategoryTreeEntry {
  catId: number;
  name: string;
}

export interface KeepaImage {
  l?: string; // large filename
  m?: string; // medium filename
  hiRes?: string;
  lH?: number;
  lW?: number;
  mH?: number;
  mW?: number;
}

export interface KeepaStats {
  current?: number[];
  avg?: number[];
  avg30?: number[];
  avg90?: number[];
  outOfStockPercentage90?: number[]; // per offer-type OOS % over 90 days
  [k: string]: unknown;
}

/** A single dimension/value pair on a variation child (e.g. {dimension:"Color", value:"Red"}). */
export interface KeepaVariationAttribute {
  dimension: string;
  value: string;
}

/** One child ASIN in a variation family, with its dimension values. */
export interface KeepaVariation {
  asin: string;
  attributes?: KeepaVariationAttribute[];
}

/** Subset of the raw Keepa product object we actually read. */
export interface KeepaProduct {
  asin: string;
  domainId?: number;
  title?: string;
  brand?: string;
  manufacturer?: string;
  parentAsin?: string;
  /** Full child list of the variation family (present on parent and, usually, each child). */
  variations?: KeepaVariation[];
  /** Comma-separated child ASINs of the variation family. */
  variationCSV?: string;
  /** Dimension names that define the variation theme, e.g. ["Color","Size"]. */
  frozenAttributes?: string[];
  imagesCSV?: string;
  images?: KeepaImage[];
  categoryTree?: KeepaCategoryTreeEntry[];
  csv?: (number[] | null)[];
  stats?: KeepaStats;
  description?: string;
  features?: string[];
  salesRanks?: Record<string, number[]>;
  salesRankReference?: number;
  eanList?: string[];
  upcList?: string[];
  [k: string]: unknown;
}

export interface KeepaTokenInfo {
  tokensLeft: number;
  refillIn: number; // ms until next refill
  refillRate: number; // tokens per minute
  tokensConsumed?: number;
  timestamp: number;
}

/** An AI-generated, de-branded product image produced by image enhancement. */
export interface EnhancedImage {
  url: string; // served path under /generated/<user>/…
  // "constructive" = white-bg studio hero · "lifestyle" = in-use · "informative" = infographic
  style: "lifestyle" | "constructive" | "informative";
  index: number; // position within the generated set (0-based)
  grounded: boolean; // true when the real product photo grounded the result
  layout?: string; // amazify slot layout (attraction_hub, multi_feature_grid, …)
  score?: number; // vision-audit score 1–5 (when the audit loop ran)
}

/** Per-image branding/quality check produced by the enhancement worker. */
export interface ImageFlag {
  index: number; // position in the images[] array
  url: string;
  hasBrand: boolean; // true if a brand name / logo / on-image text is visible
  brandText: string | null; // the text/brand seen, if any
  quality: "good" | "ok" | "poor";
  keep: boolean; // recommended for the de-branded listing
  notes: string | null;
}

/** Clean, display-ready product shape. ALL UI data comes from here. */
export interface NormalizedProduct {
  asin: string;
  title: string;
  brand: string | null;
  image: string | null; // primary large image (preview)
  thumb: string | null; // medium image (card grid)
  images: string[]; // all large images
  price: number | null; // smallest currency unit (cents)
  currency: string;
  rating: number | null; // 0–50 (stars × 10)
  reviewCount: number | null;
  salesRank: number | null;
  category: string | null;
  description: string | null;
  features: string[];
  amazonUrl: string;
  domain: number;
  parentAsin: string | null; // variation parent (used to collapse variants)
  /** Variation theme — dimension names that vary across the family, e.g. "Color, Size". null when standalone. */
  variationTheme?: string | null;
  /** This item's own variation values keyed by dimension, e.g. { Color: "Red", Size: "M" }. */
  variationAttributes?: Record<string, string> | null;
  /** Number of children in the variation family (0/null when standalone). */
  variationCount?: number | null;
  /** Optional one-line rationale added by the AI agent. */
  reason?: string;
  /** Supplier/factory SKU carried from an uploaded sourcing file (vendor↔product mapping). */
  vendorSku?: string | null;

  // ── Sourcing details (Keepa product attributes) ──
  weightG?: number | null; // package weight, grams
  lengthMm?: number | null; // package dimensions, millimetres
  widthMm?: number | null;
  heightMm?: number | null;
  color?: string | null;
  size?: string | null;
  model?: string | null;
  partNumber?: string | null; // manufacturer part number (MPN)
  upc?: string | null; // barcode Keepa carries (upcList[0] ?? eanList[0]); often absent

  packageQuantity?: number | null; // units per package
  offerCount?: number | null; // # of current New offers (availability / qty signal)

  /** 90-day out-of-stock % (0–100); null = unknown. Drives dropshipping viability. */
  oosPercent?: number | null;

  /** Live on the storefront (orderable). false = hidden from the store. Undefined (e.g. search results) = treated as live. */
  active?: boolean;

  // ── Admin family-collapse (list page shows one card per variation family) ──
  /** All sibling ASINs in this product's family (incl. the rep). Card actions fan out to these. */
  familyAsins?: string[];
  /** How many of the family's priced siblings are active (orderable). */
  familyActiveCount?: number;
  /** True when every priced sibling is enhanced. */
  familyEnhanced?: boolean;
  /** True when ≥1 priced sibling is not yet enhanced. */
  familyPending?: boolean;

  // ── Enhancement layer (present once a listing has been worked) ──
  status?: string; // "pending" | "in_progress" | "enhanced"
  enhancedTitle?: string | null;
  enhancedDescription?: string | null;
  enhancedBullets?: string[];
  enhancedKeywords?: string[];
  imageAnalysis?: ImageFlag[];
  enhancedImages?: EnhancedImage[];
  enhancementNotes?: string | null;
  enhancedAt?: string | null;
  /** Raw ItemSelection JSON (active images / field choices) — parse with lib/listing/selection. */
  selection?: string | null;

  /** Vendor file data captured at match time, used for vendor-vs-Amazon verification. */
  _vendor?: {
    title?: string;
    brand?: string;
    description?: string;
    dimensions?: string;
  } | null;
}
