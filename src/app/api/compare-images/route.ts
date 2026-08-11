/**
 * POST /api/compare-images
 *
 * Hybrid image comparison endpoint designed to bypass Walmart's CDN blocking:
 *
 * - Vendor/catalog image: fetched SERVER-SIDE directly (vendor CDNs are accessible
 *   from Render without restrictions).
 *
 * - Marketplace/live images: fetched SERVER-SIDE via a tiered proxy strategy:
 *   1. Direct fetch with browser-like headers (works when not IP-blocked)
 *   2. corsproxy.io  — Cloudflare-hosted; Walmart runs on Cloudflare so
 *      Cloudflare IPs are never blocked by Walmart CDN.
 *   3. allorigins.win — independent fallback proxy.
 *   Supply as `liveUrls` (preferred) or as pre-fetched `liveB64`/`liveMime`
 *   (legacy / browser-supplied).
 *
 * Body (JSON):
 *   vendorUrl:   string   — URL of the catalog image
 *   liveUrls:    string[] — marketplace image URLs (server fetches via proxy)
 *   productName: string   — used in the AI prompt
 *   liveB64?:    string[] — LEGACY: base64 bytes pre-fetched by the browser
 *   liveMime?:   string[] — LEGACY: corresponding MIME types
 *
 * Response:
 *   { verdict: "match"|"mismatch"|"unsure", reason: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { moonshot, moonshotConfigured, MOONSHOT_VISION_MODEL } from "@/lib/ai/moonshot";

// Moonshot (OpenAI-compatible) supports jpeg, png, gif, webp — NOT avif.
const ALLOWED_MIME = /^image\/(jpeg|jpg|png|gif|webp)$/i;
const MAX_B64_LEN  = 8 * 1024 * 1024; // ~6 MB decoded per image
const FETCH_TIMEOUT_MS = 20_000;

type ImgBlock = {
  type: "image";
  image: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

/**
 * Deliberately omits image/avif from Accept.
 *
 * Walmart's CDN content-negotiates the image format based on the Accept header.
 * When a client sends "image/avif,...", the CDN serves AVIF — even for URLs that
 * look like .jpg.  By NOT advertising avif support, the CDN falls back to WebP
 * or JPEG, which Moonshot's vision model can actually process.
 */
const IMAGE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "image/jpeg,image/webp,image/png,image/*;q=0.5,*/*;q=0.3",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://www.walmart.com/",
};

/**
 * Build the list of candidate URLs to try for one image.
 *
 * When the URL explicitly contains .avif (Walmart sometimes embeds the format
 * in the path), the CDN ignores Accept and always returns AVIF.  For those,
 * prepend JPEG and WebP variants — Walmart stores each asset in all three
 * formats at the same base path, so this reliably gets a usable format.
 */
function candidateUrls(url: string): string[] {
  const hasAvifExt = /\.avif(\?|$)/i.test(url);
  const bases = hasAvifExt
    ? [
        url.replace(/\.avif(\?|$)/i, ".jpeg$1"),  // JPEG first (widest AI support)
        url.replace(/\.avif(\?|$)/i, ".webp$1"),  // WebP second
        url,                                        // original .avif last (will be rejected by mime check)
      ]
    : [url];
  // For each base URL, try direct then two CORS proxies.
  return bases.flatMap(u => [
    u,
    `https://corsproxy.io/?${encodeURIComponent(u)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ]);
}

/**
 * Download one image URL, trying multiple URL variants and proxy strategies.
 * Returns null only if every candidate fails or yields an unsupported format.
 */
async function fetchImageAsBlock(url: string): Promise<ImgBlock | null> {
  if (!url?.startsWith("http")) return null;

  for (const fetchUrl of candidateUrls(url)) {
    try {
      const res = await fetch(fetchUrl, {
        signal:   AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers:  IMAGE_HEADERS,
        redirect: "follow",
      });
      if (!res.ok) continue;

      const rawMime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const normMime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;

      // Skip avif (AI can't process), HTML error pages, or unknown types.
      if (!ALLOWED_MIME.test(normMime)) continue;

      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 512) continue; // probably an error body

      const via = fetchUrl === url ? "direct" : fetchUrl.includes("corsproxy") ? "corsproxy" : "allorigins";
      console.log(`[compare-images] fetched ${buf.length}b as ${normMime} via ${via}`);
      return { type: "image", image: buf, mediaType: normMime as ImgBlock["mediaType"] };
    } catch {
      // timeout / network error — try next candidate
    }
  }

  return null;
}

function b64ToBlock(b64: string, mime: string): ImgBlock | null {
  try {
    const normMime = mime === "image/jpg" ? "image/jpeg" : mime;
    if (!ALLOWED_MIME.test(normMime)) return null;
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length < 512) return null;
    return { type: "image", image: bytes, mediaType: normMime as ImgBlock["mediaType"] };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!moonshotConfigured()) {
    return NextResponse.json({ verdict: "unsure", reason: "Vision AI not configured" });
  }

  let body: {
    vendorUrl?:  string;
    liveUrls?:   string[];
    productName?: string;
    // Legacy fields: browser sent pre-fetched bytes
    liveB64?:    string[];
    liveMime?:   string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { vendorUrl, liveUrls, liveB64, liveMime, productName } = body;

  if (!vendorUrl) {
    return NextResponse.json({ error: "vendorUrl is required" }, { status: 400 });
  }
  if (!liveUrls?.length && !liveB64?.length) {
    return NextResponse.json({ error: "liveUrls or liveB64 is required" }, { status: 400 });
  }

  // ── Build live image blocks ───────────────────────────────────────────────
  let liveBlocks: ImgBlock[];

  if (liveUrls?.length) {
    // Preferred path: server fetches via proxy chain (no CORS restrictions server-side)
    console.log(`[compare-images] fetching ${liveUrls.length} live URL(s) server-side`);
    const settled = await Promise.all(liveUrls.slice(0, 3).map(u => fetchImageAsBlock(u)));
    liveBlocks = settled.filter((b): b is ImgBlock => b !== null);
  } else {
    // Legacy path: browser already fetched and sent base64 bytes
    if (liveB64!.some(b => b.length > MAX_B64_LEN)) {
      return NextResponse.json({ error: "Live image too large" }, { status: 413 });
    }
    liveBlocks = liveB64!
      .slice(0, 3)
      .map((b64, i) => b64ToBlock(b64, liveMime?.[i] ?? "image/jpeg"))
      .filter((b): b is ImgBlock => b !== null);
  }

  if (!liveBlocks.length) {
    console.error(`[compare-images] Could not fetch any live images for: ${liveUrls?.join(", ") ?? "(b64 decode failed)"}`);
    return NextResponse.json({
      verdict: "unsure",
      reason:  "Could not download marketplace image(s) — will retry automatically.",
    });
  }

  // ── Fetch vendor/catalog image ────────────────────────────────────────────
  const vendorBlock = await fetchImageAsBlock(vendorUrl);
  if (!vendorBlock) {
    console.error(`[compare-images] Could not fetch vendor image: ${vendorUrl}`);
    return NextResponse.json({
      verdict: "unsure",
      reason:  "Could not load catalog image — will retry automatically.",
    });
  }

  console.log(`[compare-images] vendor OK (${vendorBlock.image.length}b), live: ${liveBlocks.length} image(s)`);

  // ── AI comparison ─────────────────────────────────────────────────────────
  try {
    const { text } = await generateText({
      model: moonshot(MOONSHOT_VISION_MODEL),
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Product: "${productName ?? ""}"\n\n` +
              `Image 1 is from our product catalog. ` +
              `Image 2 is the primary photo from the marketplace listing for this product.\n\n` +
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
              `- Clearly a DIFFERENT structural color or finish (e.g. black frame vs white frame,\n` +
              `  chrome vs matte black, natural wood vs painted).\n\n` +
              `UNSURE when the image quality is too poor or the product is not clearly visible.\n\n` +
              `Answer on the first line with exactly one word: MATCH, MISMATCH, or UNSURE.\n` +
              `Second line: one-sentence reason (be specific about what matches or differs).`,
          },
          vendorBlock,
          ...liveBlocks,
        ],
      }],
      maxOutputTokens: 150,
    });

    const lines   = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
    const first   = (lines[0] ?? "").toUpperCase();
    const reason  = lines.slice(1).join(" ") || "No reason given";
    const verdict =
      first.startsWith("MATCH")    ? "match" :
      first.startsWith("MISMATCH") ? "mismatch" :
                                     "unsure";

    console.log(`[compare-images] verdict=${verdict} reason="${reason}"`);
    return NextResponse.json({ verdict, reason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[compare-images] Moonshot call failed:", msg);
    return NextResponse.json({
      verdict: "unsure",
      reason:  "AI vision call failed — will retry automatically.",
    });
  }
}
