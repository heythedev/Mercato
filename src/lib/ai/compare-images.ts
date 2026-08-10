import { AsyncLocalStorage } from "async_hooks";
import { generateText } from "ai";
import { moonshot, moonshotConfigured, MOONSHOT_VISION_MODEL } from "@/lib/ai/moonshot";

export type ImageCompareVerdict = "match" | "mismatch" | "unsure";

export type ImageCompareResult = {
  verdict: ImageCompareVerdict;
  reason: string;
};

// ── Image download ────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_MIME = /^image\/(jpeg|png|gif|webp)$/i;

type FetchedImage = { data: Uint8Array; mimeType: string };

async function fetchImage(url: string): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; product-verify/1.0)" },
    });
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!SUPPORTED_MIME.test(mimeType)) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return { data: buf, mimeType };
  } catch {
    return null;
  }
}

/**
 * Per-run download cache. The same vendor image is compared against several
 * marketplace angles, and the same marketplace CDN URL often recurs across
 * products, so downloading once per URL rather than once per comparison
 * removes the bulk of the image-fetch I/O on large batches.
 *
 * Scoped to a single verification run via `withImageCache` — a module-level
 * cache that outlived the request would pin megabytes of image bytes in memory
 * for the life of the server process.
 */
type ImageCache = Map<string, Promise<FetchedImage | null>>;

const cacheStore = new AsyncLocalStorage<ImageCache>();

function fetchImageCached(url: string): Promise<FetchedImage | null> {
  const cache = cacheStore.getStore();
  if (!cache) return fetchImage(url);
  // Cache the promise, not the result, so concurrent callers requesting the
  // same URL share one in-flight download instead of racing to start their own.
  let hit = cache.get(url);
  if (!hit) {
    hit = fetchImage(url);
    cache.set(url, hit);
  }
  return hit;
}

/** Run `fn` with a fresh image-download cache that is discarded on completion. */
export function withImageCache<T>(fn: () => Promise<T>): Promise<T> {
  return cacheStore.run(new Map(), fn);
}

// ── Single pair comparison ─────────────────────────────────────────────────────

export async function compareProductImages(
  vendorImageUrl: string,
  liveImageUrl: string,
  productName: string,
): Promise<ImageCompareResult> {
  if (!moonshotConfigured()) {
    return { verdict: "unsure", reason: "MOONSHOT_KEY not configured" };
  }

  const [vendorImg, liveImg] = await Promise.all([
    fetchImageCached(vendorImageUrl),
    fetchImageCached(liveImageUrl),
  ]);
  if (!vendorImg) return { verdict: "unsure", reason: "Could not download catalog image" };
  if (!liveImg) return { verdict: "unsure", reason: "Could not download marketplace image" };

  try {
    const { text } = await generateText({
      model: moonshot(MOONSHOT_VISION_MODEL),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Product: "${productName}"\n\n` +
                `Image 1 is from our product catalog. Image 2 is from a marketplace listing ` +
                `we matched to this product. Decide whether both images show the SAME product.\n\n` +
                `Rules:\n` +
                `- Ignore differences in background, angle, lighting, watermarks, cropping, ` +
                `lifestyle staging, and image quality.\n` +
                `- SAME product, SAME color/finish → MATCH.\n` +
                `- Clearly different color or finish (e.g. natural/beige vs black, red vs blue, ` +
                `chrome vs matte black) → MISMATCH. Color variants are separate marketplace ` +
                `listings with different item IDs; a color difference means wrong product matched.\n` +
                `- Minor shade differences that look like photography/lighting variation (same ` +
                `hue, slightly different exposure) are acceptable — treat as MATCH.\n` +
                `- A clearly different item, design, pattern, or pack quantity (e.g. one item vs ` +
                `a multi-pack shot) is a MISMATCH.\n` +
                `- If either image is too unclear to judge, answer UNSURE.\n\n` +
                `Answer on the first line with exactly one word: MATCH, MISMATCH, or UNSURE. ` +
                `On the second line give a one-sentence reason.`,
            },
            { type: "image", image: vendorImg.data, mediaType: vendorImg.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" },
            { type: "image", image: liveImg.data, mediaType: liveImg.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" },
          ],
        },
      ],
      maxOutputTokens: 150,
    });

    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const first = (lines[0] ?? "").toUpperCase();
    const reason = lines.slice(1).join(" ") || "No reason given";
    if (first.startsWith("MATCH")) return { verdict: "match", reason };
    if (first.startsWith("MISMATCH")) return { verdict: "mismatch", reason };
    return { verdict: "unsure", reason };
  } catch {
    return { verdict: "unsure", reason: "Image comparison failed" };
  }
}

/**
 * Compare the vendor image against ALL available marketplace angles (up to
 * maxAngles) in a SINGLE vision call — the model sees every angle at once and
 * decides whether any of them shows the vendor's product.
 *
 * This replaces an earlier loop that issued one call per angle and stopped at
 * the first match. That shape cost 1 call for matching products but 3 for every
 * mismatch/unsure — exactly the products a verification run turns up — and it
 * dominated the runtime of large batches. Judging all angles together is a flat
 * 1 call per product and is also more accurate: the model can compare candidate
 * angles side by side instead of ruling on each in isolation.
 */
export async function compareVendorAgainstAllImages(
  vendorImageUrl: string,
  liveImageUrls: string[],
  productName: string,
  // All angles go into one request now, so extra angles cost image tokens rather
  // than whole round-trips. 3 stays well inside the model's per-request image
  // budget while covering the primary shot plus alternates.
  maxAngles = 3,
): Promise<ImageCompareResult> {
  const urls = liveImageUrls.filter((u) => u && u.startsWith("http")).slice(0, maxAngles);
  if (!urls.length) return { verdict: "unsure", reason: "No marketplace images available" };
  if (!moonshotConfigured()) {
    return { verdict: "unsure", reason: "MOONSHOT_KEY not configured" };
  }

  const [vendorImg, ...liveImgs] = await Promise.all([
    fetchImageCached(vendorImageUrl),
    ...urls.map((u) => fetchImageCached(u)),
  ]);
  if (!vendorImg) return { verdict: "unsure", reason: "Could not download catalog image" };
  const usableLive = liveImgs.filter((i): i is FetchedImage => !!i);
  if (!usableLive.length) return { verdict: "unsure", reason: "Could not download marketplace image" };

  const listingLabel = usableLive.length === 1
    ? `Image 2 is from a marketplace listing`
    : `Images 2-${usableLive.length + 1} are different photos from a single marketplace listing`;

  try {
    const { text } = await generateText({
      model: moonshot(MOONSHOT_VISION_MODEL),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Product: "${productName}"\n\n` +
                `Image 1 is from our product catalog. ${listingLabel} ` +
                `we matched to this product. Decide whether the listing shows the SAME product ` +
                `as the catalog image.\n\n` +
                `Rules:\n` +
                `- The listing photos may show different angles, or accessories and alternate ` +
                `views of the same item. If ANY of them clearly shows the catalog product ` +
                `(same design AND same color/finish), answer MATCH.\n` +
                `- Ignore differences in background, angle, lighting, watermarks, cropping, ` +
                `lifestyle staging, and image quality.\n` +
                `- SAME product, SAME color/finish → MATCH.\n` +
                `- Clearly different color or finish (e.g. natural/beige vs black, red vs blue, ` +
                `chrome vs matte black) → MISMATCH. Color variants are separate marketplace ` +
                `listings; a color difference means the wrong product was matched.\n` +
                `- Minor shade differences that look like photography/lighting variation (same ` +
                `hue, slightly different exposure) are acceptable — treat as MATCH.\n` +
                `- A clearly different item, design, pattern, or pack quantity (e.g. one item vs ` +
                `a multi-pack shot) is a MISMATCH.\n` +
                `- If the images are too unclear to judge, answer UNSURE.\n\n` +
                `Answer on the first line with exactly one word: MATCH, MISMATCH, or UNSURE. ` +
                `On the second line give a one-sentence reason.`,
            },
            {
              type: "image" as const,
              image: vendorImg.data,
              mediaType: vendorImg.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            },
            ...usableLive.map((img) => ({
              type: "image" as const,
              image: img.data,
              mediaType: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            })),
          ],
        },
      ],
      maxOutputTokens: 150,
    });

    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const first = (lines[0] ?? "").toUpperCase();
    const reason = lines.slice(1).join(" ") || "No reason given";
    if (first.startsWith("MATCH")) return { verdict: "match", reason };
    if (first.startsWith("MISMATCH")) return { verdict: "mismatch", reason };
    return { verdict: "unsure", reason };
  } catch {
    return { verdict: "unsure", reason: "Image comparison failed" };
  }
}

/**
 * Run compareProductImages over many pairs with bounded concurrency.
 * Items resolve in input order; individual failures resolve to "unsure".
 */
export async function compareProductImagesBatch(
  items: Array<{ vendorImageUrl: string; liveImageUrl: string; productName: string }>,
  concurrency = 4,
): Promise<ImageCompareResult[]> {
  const results: ImageCompareResult[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map((it) => compareProductImages(it.vendorImageUrl, it.liveImageUrl, it.productName)),
    );
    settled.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}

/**
 * Batch version of compareVendorAgainstAllImages.
 */
export async function compareVendorAgainstAllImagesBatch(
  items: Array<{ vendorImageUrl: string; liveImageUrls: string[]; productName: string }>,
  // Each item is now exactly one vision call (previously up to 3 sequential
  // ones), so a slot frees up ~3x sooner and the effective in-flight request
  // count at a given concurrency is correspondingly lower. 12 restores roughly
  // the old peak request rate; the previous value of 8 was tuned against the
  // multi-call shape and now under-uses the available throughput.
  concurrency = 12,
): Promise<ImageCompareResult[]> {
  const results: ImageCompareResult[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map((it) => compareVendorAgainstAllImages(it.vendorImageUrl, it.liveImageUrls, it.productName)),
    );
    settled.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}
