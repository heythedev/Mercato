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
// 6 s per candidate — 3 candidates × 6 s = 18 s worst-case, well within limits.
const FETCH_TIMEOUT_MS = 6_000;
// image/jpg is non-standard but Walmart's CDN uses it; allow it alongside jpeg.
const SUPPORTED_MIME = /^image\/(jpeg|jpg|png|gif|webp)$/i;

/**
 * Deliberately omits image/avif from Accept.
 *
 * Walmart's CDN content-negotiates the image format based on Accept.  When the
 * client sends "image/avif,...", the CDN serves AVIF — even for URLs that look
 * like .jpg.  By NOT advertising avif support the CDN falls back to WebP or
 * JPEG, which Moonshot's vision model can process.  Moonshot is OpenAI-
 * compatible and OpenAI's vision API does not support AVIF.
 */
const IMAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "image/jpeg,image/webp,image/png,image/*;q=0.5,*/*;q=0.3",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.walmart.com/",
};

type FetchedImage = { data: Uint8Array; mimeType: string };

/**
 * Build candidate fetch URLs for a given image URL.
 * When the URL explicitly contains .avif, prepend JPEG/WebP alternatives.
 * Walmart stores assets at the same path in all three formats so the swap
 * reliably returns a format the AI model can actually process.
 */
function imageCandidates(url: string): string[] {
  const hasAvifExt = /\.avif(\?|$)/i.test(url);
  const bases = hasAvifExt
    ? [
        url.replace(/\.avif(\?|$)/i, ".jpeg$1"),
        url.replace(/\.avif(\?|$)/i, ".webp$1"),
        url, // original last (will be rejected by SUPPORTED_MIME check)
      ]
    : [url];
  return bases.flatMap(u => [
    u,
    `https://corsproxy.io/?${encodeURIComponent(u)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ]);
}

async function fetchImage(url: string): Promise<FetchedImage | null> {
  if (!url?.startsWith("http")) return null;

  for (const candidate of imageCandidates(url)) {
    try {
      const res = await fetch(candidate, {
        signal:   AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers:  IMAGE_HEADERS,
        redirect: "follow",
      });
      if (!res.ok) continue;
      const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      // Normalise image/jpg → image/jpeg so the AI SDK always sees a known type.
      const normMime = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
      // Skip avif (AI can't process it) and HTML error pages from proxies.
      if (!SUPPORTED_MIME.test(normMime)) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 512 || buf.length > MAX_IMAGE_BYTES) continue;
      return { data: buf, mimeType: normMime };
    } catch {
      // timeout, network error — try next candidate
    }
  }
  return null;
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

// Cap how many downloads stay pinned at once. The reuse this cache exists for
// — one vendor image vs several marketplace angles, and CDN URLs recurring
// between neighbouring products — always happens close together in time, so a
// small window keeps those hits. Without the cap, a full-project run pins the
// bytes of EVERY image it ever downloaded until the run ends (easily 100+ MB
// on a 50-product project), which is enough to OOM a 512 MB instance and take
// the whole server down mid-run.
const IMAGE_CACHE_MAX = 24;

function fetchImageCached(url: string): Promise<FetchedImage | null> {
  const cache = cacheStore.getStore();
  if (!cache) return fetchImage(url);
  // Cache the promise, not the result, so concurrent callers requesting the
  // same URL share one in-flight download instead of racing to start their own.
  let hit = cache.get(url);
  if (!hit) {
    hit = fetchImage(url);
    cache.set(url, hit);
    // FIFO eviction (Map preserves insertion order): drop the oldest entries.
    for (const key of cache.keys()) {
      if (cache.size <= IMAGE_CACHE_MAX) break;
      cache.delete(key);
    }
  }
  return hit;
}

/** Run `fn` with a fresh image-download cache that is discarded on completion. */
export function withImageCache<T>(fn: () => Promise<T>): Promise<T> {
  return cacheStore.run(new Map(), fn);
}

// ── Image content builder ──────────────────────────────────────────────────────
// When a binary download succeeded, pass the raw bytes (most reliable).
// When the server download was blocked (CDN IP-block, 403, timeout) fall back
// to a URL object — the AI SDK translates this to an `image_url` in the API
// call, so Moonshot's own servers fetch the image rather than ours, bypassing
// CDN restrictions on Render's IP range.
type ImageContent =
  | { type: "image"; image: Uint8Array; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }
  | { type: "image"; image: URL };

function imageContent(downloaded: FetchedImage | null, url: string): ImageContent {
  if (downloaded) {
    return {
      type: "image",
      image: downloaded.data,
      mediaType: downloaded.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
    };
  }
  // URL fallback — model fetches directly (no server-side download needed).
  return { type: "image", image: new URL(url) };
}

/**
 * Vision comparison prompt shared by both the single-pair and multi-image paths.
 *
 * Design intent: confirm the SAME product is listed, NOT pixel-perfect equality.
 *
 * Deliberately lenient about:
 *   - Decorative surface patterns within the same product type (mosaic designs,
 *     grain patterns, print variants) — these are styling choices, not different
 *     products.
 *   - Photography differences: angle, lighting, background, watermarks, staging.
 *   - Minor hue/shade differences caused by different camera white-balance.
 *
 * Only strict about:
 *   - Completely different product category (chair vs table, lamp vs fan).
 *   - Major structural color / finish difference (black vs white, metal vs wood)
 *     that indicates a genuinely different variant was matched.
 */
const VISION_PROMPT =
  `Decide whether the marketplace listing is selling the SAME product as the catalog item.\n\n` +
  `MATCH when:\n` +
  `- Same product TYPE, category, and general form (shape, style, construction).\n` +
  `- Minor photography differences: angle, background, lighting, watermarks, staging.\n` +
  `- Slight shade or hue differences that look like different photography lighting.\n` +
  `- Surface pattern / decorative design variations within the same product family\n` +
  `  (e.g. different mosaic motif, different wood grain, different print) — these\n` +
  `  are style variants of the same item, not different products.\n` +
  `- Lifestyle / room-setting photo vs isolated product shot.\n\n` +
  `MISMATCH when:\n` +
  `- Clearly a DIFFERENT product (different furniture category, completely different\n` +
  `  design, obviously a different item — e.g. a rocking chair vs a side table).\n` +
  `- Clearly a DIFFERENT structural color or finish that makes it a different variant\n` +
  `  (e.g. black frame vs white frame, chrome vs matte black, natural wood vs painted).\n\n` +
  `UNSURE when the image quality is too poor or the product is not clearly visible.\n\n` +
  `Answer on the first line with exactly one word: MATCH, MISMATCH, or UNSURE.\n` +
  `Second line: one-sentence reason (be specific about what matches or differs).`;

function parseVisionResponse(text: string): ImageCompareResult {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const first = (lines[0] ?? "").toUpperCase();
  const reason = lines.slice(1).join(" ") || "No reason given";
  if (first.startsWith("MATCH")) return { verdict: "match", reason };
  if (first.startsWith("MISMATCH")) return { verdict: "mismatch", reason };
  return { verdict: "unsure", reason };
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
                `Image 1 is from our product catalog. ` +
                `Image 2 is the primary photo from the marketplace listing for this product.\n\n` +
                VISION_PROMPT,
            },
            imageContent(vendorImg, vendorImageUrl),
            imageContent(liveImg, liveImageUrl),
          ],
        },
      ],
      maxOutputTokens: 150,
    });
    return parseVisionResponse(text);
  } catch {
    return { verdict: "unsure", reason: "Image comparison failed" };
  }
}

/**
 * Compare the vendor/catalog image against the PRIMARY marketplace image.
 *
 * Previously used up to 3 marketplace gallery images. That caused systematic
 * false-mismatches on multi-variant listings (e.g. "Mosaic Art Collection" where
 * the gallery shows sunflower, leaf, and geometric pattern variants of the same
 * table). The AI saw variants as "different designs" and reported MISMATCH even
 * though the primary listing image matched the catalog exactly.
 *
 * Now uses only the FIRST / primary marketplace image. This is the canonical
 * "this is what you're buying" photo and is the correct comparison target.
 * The UNSURE retry path in the caller handles cases where the primary image
 * is a lifestyle shot or otherwise unclear.
 */
export async function compareVendorAgainstAllImages(
  vendorImageUrl: string,
  liveImageUrls: string[],
  productName: string,
  // Only compare the primary marketplace image — gallery images introduce
  // multi-variant confusion and degrade accuracy more than they help.
  maxAngles = 1,
): Promise<ImageCompareResult> {
  const urls = liveImageUrls.filter((u) => u && u.startsWith("http")).slice(0, maxAngles);
  if (!urls.length) return { verdict: "unsure", reason: "No marketplace images available" };
  if (!moonshotConfigured()) {
    return { verdict: "unsure", reason: "MOONSHOT_KEY not configured" };
  }

  const [vendorImg, liveImg] = await Promise.all([
    fetchImageCached(vendorImageUrl),
    fetchImageCached(urls[0]),
  ]);

  const vendorContent = imageContent(vendorImg, vendorImageUrl);
  const liveContent   = imageContent(liveImg,   urls[0]);

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
                `Image 1 is from our product catalog. ` +
                `Image 2 is the primary photo from the marketplace listing for this product.\n\n` +
                VISION_PROMPT,
            },
            vendorContent,
            liveContent,
          ],
        },
      ],
      maxOutputTokens: 150,
    });
    return parseVisionResponse(text);
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
