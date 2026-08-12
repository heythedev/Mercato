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
 *   2. wsrv.nl — image proxy/resizer; fetches from ITS servers (bypasses CDN
 *      IP blocks), converts AVIF→JPEG, and resizes to 1280px so the download
 *      stays small no matter how large the original is.
 *   3. corsproxy.io  — Cloudflare-hosted; Walmart runs on Cloudflare so
 *      Cloudflare IPs are never blocked by Walmart CDN.
 *   4. allorigins.win — independent fallback proxy.
 *   Supply as `liveUrls` (preferred) or as pre-fetched `liveB64`/`liveMime`
 *   (legacy / browser-supplied).
 *
 *   Every image MUST reach the model as bytes: Moonshot's vision API rejects
 *   remote image URLs outright (400 "unsupported image url" — verified), so
 *   there is no URL pass-through. A failed download returns a retryable
 *   "unsure" instead.
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
import { readBodyCapped } from "@/lib/ai/compare-images";

// Moonshot (OpenAI-compatible) supports jpeg, png, gif, webp — NOT avif.
const ALLOWED_MIME = /^image\/(jpeg|jpg|png|gif|webp)$/i;
const MAX_B64_LEN  = 8 * 1024 * 1024; // ~6 MB decoded per image

// Hard ceiling per downloaded image. Every downloaded image is held ~4x over
// during a comparison (raw bytes -> base64 string -> JSON request body ->
// outbound request bytes), so one uncapped 30 MB hi-res vendor original is a
// ~150 MB transient spike — enough to OOM-kill the 512 MB instance, which is
// what the recurring 502s on this endpoint were. Oversized images are NOT
// dropped: the wsrv.nl candidate re-serves the same asset resized to 1280px,
// well under the cap — same image analyzed, tiny download.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Per-candidate fetch timeout: 4 s per URL attempt. An .avif URL expands to
// 9 candidates (3 format variants × 3 proxies), so without a per-image budget
// one image could take 36 s. The budget cuts the candidate walk off early and
// lets the URL-reference fallback take over.
const FETCH_TIMEOUT_MS = 4_000;
const IMAGE_BUDGET_MS  = 10_000;

// At most this many comparisons run at once; extra requests get an instant
// "unsure" so the client's retry/backoff takes over. Each comparison downloads
// several MB of images and holds them through a vision call — letting them
// stack unbounded is what starves the hosting instance into real 502s.
const MAX_CONCURRENT = 2;

// Hard ceiling for the entire handler. Render's load balancer times out HTTP
// responses at ~30 s and returns 502. We return a clean JSON "unsure" at 20 s
// so the UI retry logic takes over — leaving Render a clear 10 s margin so the
// deadline always fires before Render kills the connection.
const HANDLER_DEADLINE_MS = 20_000;

// Binary bytes ONLY. There used to be a URL-reference variant here (`image:
// URL`) on the theory that Moonshot's servers would fetch the image themselves
// — they don't: Moonshot's vision API returns 400 "unsupported image url" for
// any remote URL, which poisoned the ENTIRE vision call whenever one image
// fell back to it. Bytes are the only currency this model accepts.
type ImgBlock =
  { type: "image"; image: Uint8Array; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" };

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
  // For each base URL: direct first (fastest when the CDN allows our IP), then
  // wsrv.nl — an image proxy that fetches from ITS servers, converts AVIF to
  // JPEG, and resizes to 1280px (small download regardless of original size) —
  // then two plain CORS proxies as last resorts.
  return bases.flatMap(u => [
    u,
    `https://wsrv.nl/?url=${encodeURIComponent(u)}&w=1280&output=jpg`,
    `https://corsproxy.io/?${encodeURIComponent(u)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ]);
}

/**
 * Download one image URL, trying multiple URL variants and proxy strategies.
 *
 * Returns a binary block on success, null on failure — the caller decides
 * whether the failure is permanent (dead link, non-http URL) or transient
 * (every candidate timed out / was blocked; the client should retry).
 */
/** A signal that aborts when `outer` aborts OR after `ms` — whichever is first. */
function timeoutOr(outer: AbortSignal, ms: number): AbortSignal {
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (outer.aborted) abort();
  else outer.addEventListener("abort", abort, { once: true });
  setTimeout(abort, ms);
  return ac.signal;
}

// dead=true means the ORIGINAL URL answered 404/410 — the image is gone, no
// fetcher (browser, proxy, or Moonshot) will ever get it, so retrying the whole
// comparison is pointless. block=null + dead=false means "couldn't download
// here but the link may still work elsewhere".
type FetchResult = { block: ImgBlock | null; dead: boolean };

async function fetchImageAsBlock(url: string, signal: AbortSignal): Promise<FetchResult> {
  if (!url?.startsWith("http")) return { block: null, dead: false };

  let dead = false;
  const started = Date.now();
  for (const fetchUrl of candidateUrls(url)) {
    // Stop walking candidates once the per-image budget (or the whole handler)
    // is spent — the URL-reference fallback below still gives the AI a shot.
    if (signal.aborted || Date.now() - started > IMAGE_BUDGET_MS) break;
    try {
      const res = await fetch(fetchUrl, {
        signal:   timeoutOr(signal, FETCH_TIMEOUT_MS),
        headers:  IMAGE_HEADERS,
        redirect: "follow",
      });
      if (!res.ok) {
        // Only the original URL is authoritative — a 404 on a proxy or a
        // .jpeg/.webp format variant proves nothing about the real link.
        if (fetchUrl === url && (res.status === 404 || res.status === 410)) dead = true;
        continue;
      }

      const rawMime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const normMime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;

      // Skip avif (AI can't process), HTML error pages, or unknown types.
      if (!ALLOWED_MIME.test(normMime)) continue;

      const buf = await readBodyCapped(res, MAX_IMAGE_BYTES);
      // Too big to hold in this process — move on: the wsrv.nl candidate
      // re-serves the same asset resized to well under the cap.
      if (buf === null) continue;
      if (buf.length < 512) continue; // probably an error body

      const via = fetchUrl === url ? "direct" : fetchUrl.includes("corsproxy") ? "corsproxy" : "allorigins";
      console.log(`[compare-images] fetched ${buf.length}b as ${normMime} via ${via}`);
      return {
        block: { type: "image", image: buf, mediaType: normMime as "image/jpeg" | "image/png" | "image/gif" | "image/webp" },
        dead: false,
      };
    } catch {
      // timeout / network error — try next candidate
    }
  }

  if (dead) {
    console.log(`[compare-images] dead link (404/410) for ${url.slice(0, 80)}`);
    return { block: null, dead: true };
  }

  // Every candidate (direct, wsrv resize, both CORS proxies) failed — likely a
  // transient proxy/CDN hiccup. Report failure and let the client retry; do
  // NOT hand Moonshot the URL instead, its vision API rejects remote URLs
  // (400 "unsupported image url") and that poisons the whole comparison.
  console.log(`[compare-images] all download attempts failed for ${url.slice(0, 80)}`);
  return { block: null, dead: false };
}

function b64ToBlock(b64: string, mime: string): ImgBlock | null {
  try {
    const normMime = mime === "image/jpg" ? "image/jpeg" : mime;
    if (!ALLOWED_MIME.test(normMime)) return null;
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length < 512) return null;
    return { type: "image", image: bytes, mediaType: normMime as "image/jpeg" | "image/png" | "image/gif" | "image/webp" };
  } catch {
    return null;
  }
}

async function handlePost(req: NextRequest, signal: AbortSignal): Promise<NextResponse> {
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

  // ── Build image blocks (vendor + live fetched in PARALLEL) ───────────────
  // Sequential fetching could spend two full per-image budgets before the AI
  // call even started, so the deadline would fire and the attempt was wasted.
  const vendorPromise = fetchImageAsBlock(vendorUrl, signal);

  let liveBlocks: ImgBlock[];
  let liveDead = false;

  if (liveUrls?.length) {
    // Preferred path: server fetches via proxy chain (no CORS restrictions server-side)
    console.log(`[compare-images] fetching ${liveUrls.length} live URL(s) server-side`);
    const settled = await Promise.all(liveUrls.slice(0, 3).map(u => fetchImageAsBlock(u, signal)));
    liveBlocks = settled.map(r => r.block).filter((b): b is ImgBlock => b !== null);
    liveDead   = liveBlocks.length === 0 && settled.some(r => r.dead);
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
    // Permanent failures (dead links, non-http URLs, bad b64) tell the client
    // to stop; transient download failures (proxy/CDN hiccup) tell it to
    // retry — with the URL pass-through gone, those land here too.
    const anyFetchable = (liveUrls ?? []).some(u => u?.startsWith("http"));
    const permanent = liveDead || !anyFetchable;
    console.error(`[compare-images] No usable live image blocks for: ${liveUrls?.join(", ") ?? "(b64)"}`);
    return NextResponse.json({
      verdict:   "unsure",
      retryable: !permanent,
      reason:    liveDead
        ? "Marketplace image link is broken (404) — needs manual review."
        : !permanent
        ? "Could not download marketplace image — will retry automatically."
        : "No usable marketplace image URL — needs manual review.",
    });
  }

  const vendor = await vendorPromise;
  if (!vendor.block) {
    const permanent = vendor.dead || !vendorUrl.startsWith("http");
    return NextResponse.json({
      verdict:   "unsure",
      retryable: !permanent,
      reason:    vendor.dead
        ? "Catalog image link is broken (404) — the image no longer exists at that URL. Needs manual review."
        : !permanent
        ? "Could not download catalog image — will retry automatically."
        : "Invalid catalog image URL — needs manual review.",
    });
  }
  const vendorBlock = vendor.block;

  console.log(`[compare-images] vendor OK (binary ${vendorBlock.image.length}b), live: ${liveBlocks.length} block(s)`);

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
      abortSignal: signal,
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

// Live count of in-flight comparisons (per server instance).
let activeComparisons = 0;

/**
 * Public handler — races handlePost() against the hard 20 s deadline.
 *
 * The hosting proxy times out slow responses and returns 502 Bad Gateway. By
 * resolving with a clean JSON "unsure" before that window we keep the retry
 * loop in the UI instead of surfacing a cryptic 502 page. Crucially, when the
 * deadline fires it also ABORTS the in-flight downloads and AI call: racing
 * alone leaves the work running in the background, and with the client
 * retrying on top, those zombies stack up until the instance is so starved
 * that the proxy 502s everything — the exact failure this endpoint had.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Shed load instead of queueing — the client treats "unsure" as retryable.
  if (activeComparisons >= MAX_CONCURRENT) {
    return NextResponse.json({
      verdict: "unsure",
      reason:  "Server busy with other image checks — will retry automatically.",
    });
  }
  activeComparisons++;

  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<NextResponse>(resolve => {
    timer = setTimeout(() => {
      ac.abort();
      resolve(NextResponse.json({
        verdict: "unsure",
        reason:  "Image check timed out — will retry automatically.",
      }));
    }, HANDLER_DEADLINE_MS);
  });

  const work = handlePost(req, ac.signal);
  // The deadline may win the race — don't let the loser reject unhandled.
  work.catch(() => {});

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    activeComparisons--;
  }
}
