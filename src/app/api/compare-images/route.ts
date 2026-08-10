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

const ALLOWED_MIME = /^image\/(jpeg|jpg|png|gif|webp)$/i;
const MAX_B64_LEN  = 8 * 1024 * 1024; // ~6 MB decoded per image
const FETCH_TIMEOUT_MS = 20_000;

type ImgBlock = {
  type: "image";
  image: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

const BROWSER_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://www.walmart.com/",
};

/**
 * Download one image URL, trying multiple strategies in order:
 *  1. Direct fetch (fast; works for vendor CDNs and sometimes Walmart)
 *  2. corsproxy.io  — Cloudflare-hosted; bypasses Walmart CDN IP blocks
 *  3. allorigins.win — independent CORS proxy fallback
 *
 * Returns null only if every candidate fails.
 */
async function fetchImageAsBlock(url: string): Promise<ImgBlock | null> {
  if (!url?.startsWith("http")) return null;

  const candidates = [
    url,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];

  for (const fetchUrl of candidates) {
    try {
      const res = await fetch(fetchUrl, {
        signal:   AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers:  BROWSER_HEADERS,
        redirect: "follow",
      });
      if (!res.ok) continue;

      const rawMime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const normMime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;

      // Skip HTML error pages that proxies sometimes return
      if (!ALLOWED_MIME.test(normMime)) continue;

      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 512) continue; // suspiciously small — probably an error body

      console.log(`[compare-images] fetched ${buf.length}b via ${fetchUrl.startsWith("https://cors") || fetchUrl.startsWith("https://api.all") ? "proxy" : "direct"}`);
      return { type: "image", image: buf, mediaType: normMime as ImgBlock["mediaType"] };
    } catch {
      // timeout, network error, etc. — try next candidate
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
  const liveCount    = liveBlocks.length;
  const listingLabel = liveCount === 1
    ? "Image 2 is from a marketplace listing"
    : `Images 2–${liveCount + 1} are different photos from a single marketplace listing`;

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
              `Image 1 is from our product catalog. ${listingLabel} ` +
              `we matched to this product. Decide whether the listing shows the SAME product ` +
              `as the catalog image.\n\n` +
              `Rules:\n` +
              `- If ANY listing photo clearly shows the catalog product (same design AND ` +
              `same color/finish), answer MATCH.\n` +
              `- Ignore background, angle, lighting, watermarks, cropping, staging.\n` +
              `- SAME product, SAME color/finish → MATCH.\n` +
              `- Clearly different color or finish (natural/beige vs black, red vs blue, ` +
              `chrome vs matte black) → MISMATCH. Color variants are separate listings.\n` +
              `- Minor shade variation that looks like lighting/photography → MATCH.\n` +
              `- Clearly different item, design, or pack quantity → MISMATCH.\n` +
              `- Too unclear to judge → UNSURE.\n\n` +
              `Answer on the first line with exactly one word: MATCH, MISMATCH, or UNSURE.\n` +
              `Second line: one-sentence reason.`,
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
