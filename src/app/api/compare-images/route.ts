/**
 * POST /api/compare-images
 *
 * Hybrid image comparison endpoint designed to bypass Walmart's CDN blocking:
 *
 * - Vendor/catalog image: fetched SERVER-SIDE (our server can reach vendor CDNs
 *   like Elegant Lighting, vendor.com, etc. — only Walmart CDN blocks us).
 *   Supply as `vendorUrl` and the server downloads it here.
 *
 * - Marketplace/live images: fetched BROWSER-SIDE (user's residential IP bypasses
 *   Walmart CDN restrictions that block data-centre ranges).
 *   Supply as `liveB64[]` + `liveMime[]` — raw bytes the browser already fetched.
 *
 * Body (JSON):
 *   vendorUrl:   string   — URL of the catalog image (server downloads this)
 *   liveB64:     string[] — base64 of the marketplace image(s) (browser-fetched)
 *   liveMime:    string[] — corresponding MIME types
 *   productName: string   — used in the AI prompt
 *
 * Response:
 *   { verdict: "match"|"mismatch"|"unsure", reason: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { moonshot, moonshotConfigured, MOONSHOT_VISION_MODEL } from "@/lib/ai/moonshot";

const ALLOWED_MIME = /^image\/(jpeg|jpg|png|gif|webp)$/i;
const MAX_B64_LEN = 8 * 1024 * 1024; // ~6 MB decoded per image
const MAX_TIMEOUT_MS = 20_000;

type ImgBlock = {
  type: "image";
  image: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.walmart.com/",
};

async function fetchImageAsBlock(url: string): Promise<ImgBlock | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(MAX_TIMEOUT_MS),
      headers: BROWSER_HEADERS,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim().toLowerCase();
    const normMime = mime === "image/jpg" ? "image/jpeg" : mime;
    if (!ALLOWED_MIME.test(mime)) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return null;
    return { type: "image", image: buf, mediaType: normMime as ImgBlock["mediaType"] };
  } catch {
    return null;
  }
}

function b64ToBlock(b64: string, mime: string): ImgBlock | null {
  try {
    const normMime = mime === "image/jpg" ? "image/jpeg" : mime;
    if (!ALLOWED_MIME.test(normMime)) return null;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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
    vendorUrl?: string;
    liveB64?: string[];
    liveMime?: string[];
    productName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { vendorUrl, liveB64, liveMime, productName } = body;

  if (!vendorUrl) {
    return NextResponse.json({ error: "vendorUrl is required" }, { status: 400 });
  }
  if (!liveB64?.length || !liveMime?.length) {
    return NextResponse.json({ error: "liveB64 and liveMime are required" }, { status: 400 });
  }
  if (liveB64.some(b => b.length > MAX_B64_LEN)) {
    return NextResponse.json({ error: "Live image too large" }, { status: 413 });
  }

  // Fetch the vendor/catalog image server-side.
  // Our server can reach vendor CDNs (elc.com, vendor CDNs, etc.) without issue.
  // Only Walmart's own CDN (i5.walmartimages.com) blocks data-centre IPs.
  // Decode the live images the browser already fetched.
  const liveBlocks: ImgBlock[] = liveB64
    .slice(0, 3)
    .map((b64, i) => b64ToBlock(b64, liveMime[i] ?? "image/jpeg"))
    .filter((b): b is ImgBlock => b !== null);

  if (!liveBlocks.length) {
    return NextResponse.json({ verdict: "unsure", reason: "No usable marketplace images provided." });
  }

  // Fetch the vendor/catalog image server-side.
  // Our server can reach vendor CDNs (elc.com, vendor CDNs, etc.) without issue.
  // Only Walmart's own CDN (i5.walmartimages.com) blocks data-centre IPs.
  const vendorBlock = await fetchImageAsBlock(vendorUrl);
  if (!vendorBlock) {
    console.error(`[compare-images] Could not fetch vendor image server-side: ${vendorUrl}`);
    return NextResponse.json({ verdict: "unsure", reason: "Could not load catalog image from vendor server — try re-verifying." });
  }
  console.log(`[compare-images] vendor OK (${vendorBlock.image.length} bytes), live: ${liveBlocks.length} images`);

  const liveCount = liveBlocks.length;
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

    const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
    const first = (lines[0] ?? "").toUpperCase();
    const reason = lines.slice(1).join(" ") || "No reason given";
    const verdict =
      first.startsWith("MATCH") ? "match" :
      first.startsWith("MISMATCH") ? "mismatch" :
      "unsure";
    return NextResponse.json({ verdict, reason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[compare-images] Moonshot call failed:", msg);
    return NextResponse.json({ verdict: "unsure", reason: "AI comparison failed — try re-verifying later." });
  }
}
