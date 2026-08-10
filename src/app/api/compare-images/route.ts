/**
 * POST /api/compare-images
 *
 * Client-side image comparison endpoint. The browser fetches both images
 * (vendor catalog + marketplace) using the user's residential IP — which
 * bypasses CDN restrictions that block server/data-center IPs — converts
 * them to base64, and sends the bytes here. This endpoint passes the raw
 * binary directly to Moonshot without any server-side URL fetching, so
 * Walmart's CDN blocking is completely avoided.
 *
 * Body (JSON):
 *   vendorB64:   string   — base64 of the vendor/catalog image
 *   vendorMime:  string   — MIME type (image/jpeg, image/png, …)
 *   liveB64:     string[] — base64 of the marketplace image(s)
 *   liveMime:    string[] — corresponding MIME types
 *   productName: string   — used in the prompt
 *
 * Response:
 *   { verdict: "match"|"mismatch"|"unsure", reason: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { moonshot, moonshotConfigured, MOONSHOT_VISION_MODEL } from "@/lib/ai/moonshot";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_B64_LEN = 7 * 1024 * 1024; // ~5 MB decoded — generous ceiling

export async function POST(req: NextRequest) {
  if (!moonshotConfigured()) {
    return NextResponse.json({ error: "Vision AI not configured" }, { status: 503 });
  }

  let body: {
    vendorB64: string;
    vendorMime: string;
    liveB64: string[];
    liveMime: string[];
    productName: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { vendorB64, vendorMime, liveB64, liveMime, productName } = body;

  if (!vendorB64 || !vendorMime || !liveB64?.length || !liveMime?.length) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(vendorMime)) {
    return NextResponse.json({ error: "Unsupported vendorMime" }, { status: 400 });
  }
  if (vendorB64.length > MAX_B64_LEN) {
    return NextResponse.json({ error: "Vendor image too large" }, { status: 413 });
  }

  // Build image content blocks from the base64 strings the browser sent.
  // These are raw bytes — no server-side URL fetch, no CDN interaction.
  type ImgBlock = {
    type: "image";
    image: Uint8Array;
    mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  };

  const b64ToBytes = (b64: string): Uint8Array => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const vendorBlock: ImgBlock = {
    type: "image",
    image: b64ToBytes(vendorB64),
    mediaType: vendorMime as ImgBlock["mediaType"],
  };

  const liveBlocks: ImgBlock[] = liveB64
    .slice(0, 3) // cap at 3 angles
    .map((b64, i) => {
      const mime = (liveMime[i] ?? "image/jpeg") as ImgBlock["mediaType"];
      return { type: "image", image: b64ToBytes(b64), mediaType: ALLOWED_MIME.has(mime) ? mime : "image/jpeg" };
    });

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
    return NextResponse.json({ verdict: "unsure", reason: "Image comparison failed" }, { status: 200 });
  }
}
