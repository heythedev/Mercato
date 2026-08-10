"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ShieldCheck, Loader2, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, XCircle, HelpCircle, Download, ThumbsUp, Ban, Sparkles, RefreshCw,
} from "lucide-react";
import { cn, formatDuration } from "@/lib/utils";
import { LottieLoader } from "@/components/ui/lottie-loader";
import { toast } from "sonner";
import { buildDownloadName } from "@/lib/export/filename";

type FieldResult = {
  field: string;
  label: string;
  stored: string;
  live: string;
  match: boolean;
  severity: "ok" | "warning" | "mismatch";
  note?: string;
  liveImage?: string; // marketplace image URL (images field)
  liveUrl?: string;   // marketplace product page URL (images field)
};

type Product = {
  id: string;
  name: string;
  vendorSku: string | null;
  upc: string | null;
  asin: string | null;
  verifyStatus: string | null;
  verifyFields: Record<string, unknown>[] | null;
  verifiedAt: Date | null;
};

const STATUS_CONFIG = {
  ok:           { label: "Match",        color: "bg-green-100 text-green-700",   icon: CheckCircle2 },
  warning:      { label: "Warning",      color: "bg-yellow-100 text-yellow-700", icon: AlertTriangle },
  mismatch:     { label: "Mismatch",     color: "bg-red-100 text-red-700",       icon: XCircle },
  not_found:    { label: "Not found",    color: "bg-gray-100 text-gray-600",     icon: HelpCircle },
  discontinued: { label: "Discontinued", color: "bg-purple-100 text-purple-700", icon: Ban },
};

const AI_NOTE_STYLE = {
  ok:       { wrap: "bg-green-50/70 dark:bg-green-950/20", badge: "bg-green-500", pill: "bg-green-100 text-green-700", text: "text-green-900" },
  warning:  { wrap: "bg-yellow-50/70 dark:bg-yellow-950/20", badge: "bg-yellow-500", pill: "bg-yellow-100 text-yellow-700", text: "text-yellow-900" },
  mismatch: { wrap: "bg-red-50/70 dark:bg-red-950/20", badge: "bg-red-500", pill: "bg-red-100 text-red-700", text: "text-red-900" },
};

const FIELD_SEVERITY = {
  ok:      "text-green-600",
  warning: "text-yellow-600",
  mismatch: "text-red-600",
};

export function VerifyStep({ projectId, projectName, marketplace, products, verifiedCount, warningCount, mismatchCount, notFoundCount, discontinuedCount, loading, projectStatus, elapsedMs, completedAt, verifyTotal, verifyDone, onRunVerify, onApproveProduct, onMarkDiscontinued, onReverifyProduct, onNext }: {
  projectId: string;
  projectName: string;
  marketplace: string;
  products: Product[];
  verifiedCount: number;
  warningCount: number;
  mismatchCount: number;
  notFoundCount: number;
  discontinuedCount: number;
  loading: boolean;
  projectStatus: string;
  elapsedMs?: number | null;
  completedAt?: string | null;
  /** Total products in the run, for the "verified N of M" streaming footer. */
  verifyTotal?: number | null;
  /** Products checked so far in the current run — drives the live text progress. */
  verifyDone?: number | null;
  onRunVerify: (force?: boolean, ai?: boolean) => void;
  onApproveProduct: (productId: string) => Promise<void>;
  onMarkDiscontinued: (productId: string) => Promise<void>;
  onReverifyProduct: (productId: string) => Promise<void>;
  onNext: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [discontinuing, setDiscontinuing] = useState<string | null>(null);
  const [reverifying, setReverifying] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  // Image check state keyed by "productId:field".
  // Stores current loading/verdict/attempt state for the AI visual check overlay.
  const [imgCheckState, setImgCheckState] = useState<Map<string, {
    loading: boolean; verdict?: string; note?: string; attempt?: number;
  }>>(new Map());
  // Tracks which products have already had an auto-check triggered so we don't
  // fire again on every expand/collapse cycle.
  const autoCheckedRef = useRef<Set<string>>(new Set());
  // Stable ref so the useEffect can call runImageCheck without a dep-array issue.
  const imgCheckFnRef = useRef<typeof runImageCheck | null>(null);
  // Pending retry timers keyed by stateKey — used to cancel retries when a
  // definitive result arrives or the product is collapsed.
  const retryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Ref-copy of `expanded` so retry closures can check whether the product is
  // still open without capturing a stale value.
  const expandedRef = useRef<string | null>(null);

  // Fields that affect the hard "Mismatch" escalation path.
  // Must stay in sync with HARD_FIELDS in src/lib/marketplaces/verify.ts.
  const HARD_FIELDS_SET = new Set(["title", "brand", "model", "upc"]);

  /**
   * Compute the product's effective displayed status, factoring in the browser
   * AI image check result.  When the browser check has a definitive verdict,
   * replace the images field's server-side severity and re-run the rollup:
   *   hasMismatch (any "mismatch") → "warning"
   *   hasHardMismatch (hard field "mismatch") → "mismatch"
   *   hasHardWarning (hard field "warning") → "warning"
   *   otherwise → "ok"
   * This lets the collapsed card badge update immediately without waiting for a
   * full re-verify round-trip.
   */
  const getEffectiveStatus = (product: { id: string; verifyStatus?: string | null; verifyFields?: unknown }) => {
    const browserKey = `${product.id}:images`;
    const browserCheck = imgCheckState.get(browserKey);
    const dbStatus = product.verifyStatus ?? "not_found";

    // No override: loading, no result, or still uncertain
    if (!browserCheck || browserCheck.loading || !browserCheck.verdict || browserCheck.verdict === "unsure") {
      return dbStatus;
    }

    const allFields = (product.verifyFields ?? []) as Array<{ field: string; severity?: string }>;
    const nonImgFields = allFields.filter(f => f.field !== "images");

    const hasHardMismatch  = nonImgFields.some(f => f.severity === "mismatch" && HARD_FIELDS_SET.has(f.field));
    const hasMismatch      = nonImgFields.some(f => f.severity === "mismatch");
    const hasHardWarning   = nonImgFields.some(f => f.severity === "warning"  && HARD_FIELDS_SET.has(f.field));

    if (browserCheck.verdict === "mismatch") {
      // Images differ — treat image as "mismatch" in rollup
      if (hasHardMismatch) return "mismatch";
      return "warning";
    }

    // verdict === "match" — image issue resolved, recalculate without it
    if (hasHardMismatch) return "mismatch";
    if (hasMismatch || hasHardWarning) return "warning";
    return "ok";
  };

  /**
   * Run an AI image comparison for one product's images field.
   *
   * The server (compare-images API) fetches ALL images server-side via a tiered
   * proxy chain (direct → corsproxy.io → allorigins.win). No base64 transfer from
   * the browser — just send the URLs.
   *
   * Retry logic (MAX_ATTEMPTS = 3):
   *   - "unsure" or HTTP/network error → auto-retry with 4s/8s backoff
   *   - "mismatch" on attempt 1 → retry once to confirm (avoids false diffs
   *     from proxy compression artefacts)
   *   - "match" → done immediately; also triggers onReverifyProduct to persist
   *     the updated status to the database
   *
   * Cancellation:
   *   - Each retry stores its timer in retryTimersRef; a fresh call for the same
   *     stateKey cancels any pending retry before starting.
   *   - Retries check expandedRef at fire-time; if the product was collapsed
   *     before the delay expires the retry is silently skipped.
   */
  async function runImageCheck(
    productId: string,
    fieldKey: string,
    vendorUrl: string,
    liveUrls: string[],
    productName: string,
    attempt = 1,
  ) {
    const MAX_ATTEMPTS = 3;
    const stateKey = `${productId}:${fieldKey}`;

    // Cancel any pending retry for this key before starting a fresh attempt.
    const existing = retryTimersRef.current.get(stateKey);
    if (existing) { clearTimeout(existing); retryTimersRef.current.delete(stateKey); }

    setImgCheckState(prev => new Map(prev).set(stateKey, { loading: true, attempt }));

    const scheduleRetry = (delay: number, interimNote: string) => {
      setImgCheckState(prev => new Map(prev).set(stateKey, { loading: true, attempt, note: interimNote }));
      const timer = setTimeout(() => {
        retryTimersRef.current.delete(stateKey);
        // Skip if the product was collapsed while we were waiting.
        if (expandedRef.current !== productId) return;
        runImageCheck(productId, fieldKey, vendorUrl, liveUrls, productName, attempt + 1);
      }, delay);
      retryTimersRef.current.set(stateKey, timer);
    };

    const setFinal = (verdict: string, note: string) => {
      // Clear any stale retry timer for this key.
      const t = retryTimersRef.current.get(stateKey);
      if (t) { clearTimeout(t); retryTimersRef.current.delete(stateKey); }
      setImgCheckState(prev => new Map(prev).set(stateKey, { loading: false, verdict, note }));
    };

    try {
      const res = await fetch("/api/compare-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorUrl, liveUrls, productName }),
      });

      if (!res.ok) {
        if (attempt < MAX_ATTEMPTS) {
          scheduleRetry(attempt * 4_000, `Server error — retrying… (attempt ${attempt}/${MAX_ATTEMPTS})`);
          return;
        }
        setFinal("unsure", `Image check failed after ${MAX_ATTEMPTS} attempts — please verify manually.`);
        return;
      }

      const data = await res.json() as { verdict: string; reason: string };
      const { verdict, reason } = data;

      // "unsure": proxy chain may have had a transient failure — retry.
      if (verdict === "unsure" && attempt < MAX_ATTEMPTS) {
        scheduleRetry(attempt * 4_000, `Image check uncertain — retrying… (attempt ${attempt}/${MAX_ATTEMPTS})`);
        return;
      }

      // "mismatch" on first attempt: retry once to confirm before showing.
      if (verdict === "mismatch" && attempt === 1) {
        scheduleRetry(3_000, "Possible image mismatch — confirming with second check…");
        return;
      }

      // Definitive result — display it.
      const note =
        verdict === "match"    ? `AI visual check: images match — ${reason}` :
        verdict === "mismatch" ? `AI visual check: images differ — ${reason}` :
                                 `Needs manual review — ${reason}`;
      setFinal(verdict, note);

      // When images are confirmed as matching, trigger a lightweight re-verify
      // so the database status updates and the product moves to the correct
      // section without the user having to click Re-verify manually.
      if (verdict === "match" && expandedRef.current === productId) {
        setReverifying(productId);
        onReverifyProduct(productId).finally(() => setReverifying(null));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      console.error(`[img-check] attempt ${attempt} failed:`, msg);
      if (attempt < MAX_ATTEMPTS) {
        scheduleRetry(attempt * 4_000, `Connection error — retrying… (attempt ${attempt}/${MAX_ATTEMPTS})`);
        return;
      }
      setFinal("unsure", "Image check failed — please verify manually.");
    }
  }

  // Always keep the ref pointing at the latest version of the function.
  imgCheckFnRef.current = runImageCheck;
  // Keep expandedRef in sync so retry closures see the current value.
  expandedRef.current = expanded;

  // Auto-trigger the image check whenever a product is expanded and its
  // server-side image comparison previously failed due to CDN blocking.
  // The user never has to manually click anything — expanding the row is enough.
  useEffect(() => {
    if (!expanded) return;
    if (autoCheckedRef.current.has(expanded)) return; // already triggered for this product

    const product = products.find(p => p.id === expanded);
    if (!product?.verifyFields) return;

    type FR = { field: string; stored?: string; live?: string; liveImage?: string; note?: string };
    const fields = product.verifyFields as FR[];
    const imgField = fields.find(f => f.field === "images");
    if (!imgField) return;

    // Only auto-trigger when the server-side check previously failed
    const serverFailed = /image comparison failed|could not download marketplace image/i.test(imgField.note ?? "");
    if (!serverFailed) return;

    const vendorUrl  = imgField.stored?.startsWith("http") ? imgField.stored : "";
    const liveImgUrl = imgField.liveImage || (imgField.live?.startsWith("http") ? imgField.live : "");
    if (!vendorUrl || !liveImgUrl) return;

    // Mark before calling to prevent re-entry on rapid expand/collapse
    autoCheckedRef.current.add(expanded);
    imgCheckFnRef.current?.(expanded, "images", vendorUrl, [liveImgUrl], product.name);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, products]);

  // A product can carry verifyStatus="discontinued" straight from import (the
  // vendor sheet's status column), so its mere presence does NOT mean
  // verification has run. Treat the report as available only once the project
  // has actually been verified, or a product has a status that only
  // verification produces (ok/warning/mismatch/not_found).
  // Pre-verification states: the project has been created/imported but
  // verification has not produced results yet.
  const preVerify = projectStatus === "processing" || projectStatus === "uploaded";
  const hasResults =
    !preVerify ||
    products.some((p) => p.verifyStatus && p.verifyStatus !== "discontinued");

  // Products with no verifyStatus yet (null) — these were not reached before the
  // server time limit was hit. When > 0, we show a "Resume" button so the user
  // can continue without wiping the results that were already saved.
  const unverifiedCount = products.filter((p) => p.verifyStatus === null).length;

  const marketplaceLabel =
    marketplace === "walmart" ? "Walmart" :
    marketplace === "amazon_us" ? "Amazon US" :
    marketplace === "amazon" ? "Amazon" :
    marketplace.charAt(0).toUpperCase() + marketplace.slice(1);

  // Live running timer while verifying. The server persists elapsedMs only on
  // completion, so we tick client-side from the moment this pass started.
  // Verification is resumable, so we add onto any time accumulated so far.
  const [liveElapsedMs, setLiveElapsedMs] = useState<number | null>(null);
  const passStartRef = useRef<number | null>(null);
  const priorMsRef = useRef(0);
  useEffect(() => {
    if (loading) {
      if (passStartRef.current == null) {
        passStartRef.current = Date.now();
        priorMsRef.current = completedAt ? 0 : (elapsedMs ?? 0);
      }
      const tick = () => setLiveElapsedMs(priorMsRef.current + (Date.now() - passStartRef.current!));
      tick();
      // Ticking re-renders the component every second for the whole run. While the
      // tab is hidden nobody can read the clock, so stop it entirely rather than
      // repaint in the background — the value is derived from wall-clock time, so
      // it's simply recomputed (correctly) the moment the tab is visible again.
      let iv: ReturnType<typeof setInterval> | null = null;
      const start = () => { if (iv == null) iv = setInterval(tick, 1000); };
      const stop = () => { if (iv != null) { clearInterval(iv); iv = null; } };
      const sync = () => {
        if (document.visibilityState === "hidden") stop();
        else { tick(); start(); }
      };
      sync();
      document.addEventListener("visibilitychange", sync);
      return () => { stop(); document.removeEventListener("visibilitychange", sync); };
    }
    passStartRef.current = null;
    setLiveElapsedMs(null);
  }, [loading, elapsedMs, completedAt]);

  // Products carrying a verification verdict right now. During a run this grows
  // as batches land, which is what lets the list render mid-run instead of
  // waiting for the whole catalog.
  const verifiedProducts = products.filter(
    (p) => p.verifyStatus && p.verifyStatus !== "discontinued",
  );
  const hasStreamedResults = verifiedProducts.length > 0;

  // While verifying, show only products that actually have a result — the
  // unverified remainder would otherwise render as a wall of placeholder rows.
  // Once the run finishes, show everything so discontinued items stay visible.
  const resultPool = loading ? verifiedProducts : products;
  const visibleProducts = activeFilter
    ? resultPool.filter((p) => (p.verifyStatus ?? "not_found") === activeFilter)
    : resultPool;

  async function downloadReport() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/verify/report`);
      if (!res.ok) { toast.error("Failed to generate report"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = buildDownloadName({
        prefix: "mercato-verification-report",
        projectName,
        marketplace,
        extension: "csv",
      });
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Report downloaded");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="p-4 sm:p-8">
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Marketplace Verification</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Compare catalog data against live {marketplaceLabel} listings — title, images, description &amp; dimensions
          </p>
          {loading && formatDuration(liveElapsedMs) && (
            <p className="text-xs text-muted-foreground mt-1 font-medium tabular-nums">
              {verifyDone != null && verifyTotal != null && verifyTotal > 0
                ? <>Verifying {verifyDone.toLocaleString()} / {verifyTotal.toLocaleString()} · {formatDuration(liveElapsedMs)} elapsed</>
                : <>Verifying… {formatDuration(liveElapsedMs)} elapsed</>}
            </p>
          )}
          {/* Same as Categorize: a run recovered after its process died has no
              recorded duration, and gating on one hid the completion line
              entirely. */}
          {!loading && completedAt && (
            <p className="text-xs text-green-700 mt-1 font-medium">
              {formatDuration(elapsedMs)
                ? <>Verification done in {formatDuration(elapsedMs)}</>
                : <>Verification complete</>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:gap-3">
          {hasResults && (
            <button
              onClick={downloadReport}
              // Disabled while a run is in progress: a mid-run report would be a
              // partial snapshot that changes seconds later. Enabled only once the
              // full verification has finished.
              disabled={downloading || loading}
              title={loading ? "Available when verification completes" : undefined}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Download Report
            </button>
          )}
          {/* AI image comparison runs automatically on every verify pass, so there
              is no separate "AI deep check" button. Re-verify re-fetches all
              marketplace data AND re-runs the image/title AI pass. */}
          {hasResults && (
            <button
              onClick={() => onRunVerify(true)}
              disabled={loading}
              title="Re-fetch marketplace data and re-run AI image comparison for all products"
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4" />
              Re-verify
            </button>
          )}
          {hasResults && unverifiedCount > 0 && (
            <button
              onClick={() => onRunVerify()}
              disabled={loading}
              title={`Resume checking the ${unverifiedCount.toLocaleString()} products that were not reached yet`}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border border-blue-400 text-blue-600 dark:text-blue-400 text-sm font-medium hover:bg-blue-50 dark:hover:bg-blue-950/30 transition disabled:opacity-50"
            >
              <RefreshCw className="w-4 h-4" />
              Resume ({unverifiedCount.toLocaleString()} left)
            </button>
          )}
          <button
            onClick={hasResults ? onNext : () => onRunVerify()}
            disabled={loading}
            className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {loading ? <LottieLoader size={20} onDark className="-my-2" /> : <ShieldCheck className="w-4 h-4" />}
            {loading ? "Verifying…" : hasResults ? "Continue →" : "Run verification"}
          </button>
        </div>
      </div>

      {/* Summary cards — shown as soon as any result exists, so the tallies
          climb while the run is still going. */}
      {(hasResults || hasStreamedResults) && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 mb-3">
            {[
              { label: "Match",        status: "ok",           count: verifiedCount,    color: "bg-green-50/70 dark:bg-green-950/20",    text: "text-green-700 dark:text-green-400",   ring: "ring-green-400" },
              { label: "Warning",      status: "warning",      count: warningCount,     color: "bg-yellow-50/70 dark:bg-yellow-950/20",  text: "text-yellow-700 dark:text-yellow-400",  ring: "ring-yellow-400" },
              { label: "Mismatch",     status: "mismatch",     count: mismatchCount,    color: "bg-red-50/70 dark:bg-red-950/20",        text: "text-red-700 dark:text-red-400",     ring: "ring-red-400" },
              { label: "Not Found",    status: "not_found",    count: notFoundCount,    color: "bg-muted/30",      text: "text-gray-600 dark:text-gray-400",    ring: "ring-gray-400" },
              { label: "Discontinued", status: "discontinued", count: discontinuedCount, color: "bg-purple-50/70 dark:bg-purple-950/20", text: "text-purple-700 dark:text-purple-400",  ring: "ring-purple-400" },
            ].map((s) => {
              const isActive = activeFilter === s.status;
              return (
                <button
                  key={s.label}
                  onClick={() => { setActiveFilter(isActive ? null : s.status); setExpanded(null); }}
                  className={cn(
                    "rounded-2xl p-4 text-left transition-all w-full",
                    s.color,
                    isActive ? `ring-2 ${s.ring} shadow-sm` : "hover:shadow-sm hover:brightness-95",
                  )}
                >
                  <p className={cn("text-2xl font-bold", s.text)}>{s.count}</p>
                  <p className={cn("text-sm font-medium", s.text)}>{s.label}</p>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mb-6">
            {loading ? (
              // Mid-run the tallies are still climbing, so an export-count
              // sentence here would state a number that is about to change.
              <>Counts update as products finish verifying.</>
            ) : unverifiedCount > 0 ? (
              <><span className="font-medium text-yellow-600">{unverifiedCount.toLocaleString()} product{unverifiedCount !== 1 ? "s" : ""} not yet checked</span> — verification was cut short. Click <strong>Resume</strong> to continue from where it stopped.</>
            ) : marketplace === "amazon_us" ? (
              <><span className="font-medium text-green-700">{verifiedCount} SKU{verifiedCount !== 1 ? "s" : ""}</span> will be included in the {marketplaceLabel} export file (Matched only). Warnings, mismatches and discontinued items are excluded.</>
            ) : (
              <><span className="font-medium text-green-700">{verifiedCount + warningCount + notFoundCount} SKU{(verifiedCount + warningCount + notFoundCount) !== 1 ? "s" : ""}</span> will be included in the export file (Match + Warning + Not Found). Mismatches and discontinued items are excluded.</>
            )}
            {activeFilter && (
              <> &nbsp;·&nbsp; Showing <span className="font-medium">{visibleProducts.length}</span> {activeFilter.replace("_", " ")} product{visibleProducts.length !== 1 ? "s" : ""}.{" "}
                <button onClick={() => setActiveFilter(null)} className="underline hover:no-underline">Clear filter</button>
              </>
            )}
          </p>
        </>
      )}

      {!hasResults && !loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ShieldCheck className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-base font-semibold mb-1">Ready to verify</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            We&apos;ll check each product against the live {marketplaceLabel} listing and flag any discrepancies in title, images, description and dimensions.
          </p>
        </div>
      )}

      {/* Full-page loader only until the first results arrive. Once products
          start streaming in, they replace it and the run reports progress at the
          bottom of the list instead — the user can start reviewing immediately
          rather than waiting for the final batch. */}
      {loading && !hasStreamedResults && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <LottieLoader size={96} className="mb-2" />
          <p className="text-sm font-medium">Verifying products against {marketplaceLabel}…</p>
          {/* Real progress as changing TEXT (deliberately no progress bar): the count
              comes from the same poll that drives the step-header tally, so it ticks
              up as batches land server-side. Until the first count arrives, fall back
              to the generic hint. */}
          {verifyDone != null && verifyTotal != null && verifyTotal > 0 ? (
            <p className="text-sm font-medium mt-1 tabular-nums">
              Checked {verifyDone.toLocaleString()} of {verifyTotal.toLocaleString()} products
            </p>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">
              First results appear within a few seconds
            </p>
          )}
          {formatDuration(liveElapsedMs) && (
            <p className="text-sm text-muted-foreground mt-3 tabular-nums">{formatDuration(liveElapsedMs)} elapsed</p>
          )}
        </div>
      )}

      {/* Product results */}
      {(hasResults || hasStreamedResults) && (
        <div className="space-y-2">
          {visibleProducts.map((p) => {
            const effectiveStatus = getEffectiveStatus(p);
            const cfg = STATUS_CONFIG[effectiveStatus as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.not_found;
            const Icon = cfg.icon;
            const fields = (p.verifyFields ?? []) as FieldResult[];
            const isOpen = expanded === p.id;

            return (
              <div key={p.id} className="bg-muted/20 rounded-2xl overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition text-left cursor-pointer"
                  onClick={() => setExpanded(isOpen ? null : p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExpanded(isOpen ? null : p.id);
                    }
                  }}
                >
                  <span className={cn("inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full shrink-0", cfg.color)}>
                    <Icon className="w-3 h-3" />
                    {cfg.label}
                  </span>
                  <span className="flex-1 text-sm font-medium truncate">{p.name}</span>
                  {(p.verifyStatus === "warning" || effectiveStatus === "warning") && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setApproving(p.id);
                        onApproveProduct(p.id).finally(() => setApproving(null));
                      }}
                      disabled={approving === p.id}
                      title="Approve as Match"
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 hover:bg-green-200 transition shrink-0 disabled:opacity-50"
                    >
                      {approving === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />}
                      Approve
                    </button>
                  )}
                  {p.verifyStatus === "not_found" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDiscontinuing(p.id);
                        onMarkDiscontinued(p.id).finally(() => setDiscontinuing(null));
                      }}
                      disabled={discontinuing === p.id}
                      title="Mark as Discontinued"
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 hover:bg-purple-200 transition shrink-0 disabled:opacity-50"
                    >
                      {discontinuing === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                      Discontinued
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setReverifying(p.id);
                      onReverifyProduct(p.id).finally(() => setReverifying(null));
                    }}
                    disabled={reverifying === p.id}
                    title="Re-verify this product"
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border hover:bg-accent transition shrink-0 disabled:opacity-50"
                  >
                    <RefreshCw className={cn("w-3 h-3", reverifying === p.id && "animate-spin")} />
                    Re-verify
                  </button>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                </div>

                {isOpen && (() => {
                  const imgKey = `${p.id}:images`;
                  const imgBrowser = imgCheckState.get(imgKey);
                  // Show the AI image check banner at the TOP of the expanded panel
                  // so the user can see the check status without scrolling down.
                  const showBanner = imgBrowser && (imgBrowser.loading || imgBrowser.verdict);
                  return (
                    <>
                      {showBanner && (
                        <div className={cn(
                          "border-t flex items-start gap-2.5 px-4 py-2.5 text-[11px] leading-relaxed",
                          imgBrowser.loading
                            ? "bg-yellow-50 dark:bg-yellow-950/30 text-yellow-800 dark:text-yellow-300"
                            : imgBrowser.verdict === "match"
                            ? "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300"
                            : imgBrowser.verdict === "mismatch"
                            ? "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300"
                            : "bg-yellow-50 dark:bg-yellow-950/30 text-yellow-800 dark:text-yellow-300"
                        )}>
                          <span className={cn(
                            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white shadow-sm",
                            imgBrowser.loading ? "bg-yellow-500" :
                            imgBrowser.verdict === "match" ? "bg-green-500" :
                            imgBrowser.verdict === "mismatch" ? "bg-red-500" : "bg-yellow-500"
                          )}>
                            {imgBrowser.loading
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <Sparkles className="h-3 w-3" />
                            }
                          </span>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-semibold uppercase tracking-wide text-[9px] opacity-70">AI Visual Check</span>
                            <span>{imgBrowser.note ?? (imgBrowser.loading ? "Running AI image comparison…" : "")}</span>
                          </div>
                        </div>
                      )}
                      <div className="border-t bg-muted/20 divide-y">
                        {/* SKU, UPC, ASIN always shown */}
                    <div className="grid grid-cols-[90px_1fr_1fr] sm:grid-cols-[120px_1fr_1fr] gap-2 sm:gap-4 px-3 sm:px-4 py-2.5 text-xs">
                      <span className="font-medium text-muted-foreground">SKU</span>
                      <p className="font-medium">{p.vendorSku ?? "—"}</p>
                      <div />
                    </div>
                    <div className="grid grid-cols-[90px_1fr_1fr] sm:grid-cols-[120px_1fr_1fr] gap-2 sm:gap-4 px-3 sm:px-4 py-2.5 text-xs">
                      <span className="font-medium text-muted-foreground">UPC</span>
                      <p className="font-medium">{p.upc ?? "—"}</p>
                      <div />
                    </div>
                    {(marketplace === "amazon" || marketplace === "amazon_us") && (
                      <div className="grid grid-cols-[90px_1fr_1fr] sm:grid-cols-[120px_1fr_1fr] gap-2 sm:gap-4 px-3 sm:px-4 py-2.5 text-xs">
                        <span className="font-medium text-muted-foreground">ASIN</span>
                        <div className="flex items-center gap-2">
                          <p className="font-medium font-mono">{p.asin ?? "—"}</p>
                          {p.asin && p.verifiedAt && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">auto-detected</span>
                          )}
                        </div>
                        <div />
                      </div>
                    )}
                    {/* Field comparison rows */}
                    {fields.map((f) => {
                      const isImg = f.field === "images";
                      const isUrl = (v: string) => v && v.startsWith("http");
                      return (
                        <div key={f.field} className="grid grid-cols-[90px_1fr_1fr] sm:grid-cols-[120px_1fr_1fr] gap-2 sm:gap-4 px-3 sm:px-4 py-2.5 text-xs">
                          <span className={cn("font-medium", FIELD_SEVERITY[f.severity])}>{f.label}</span>
                          <div>
                            <p className="text-muted-foreground mb-0.5">Catalog</p>
                            {isImg && isUrl(f.stored) ? (
                              <img
                                src={f.stored}
                                alt="Catalog"
                                className="w-16 h-16 object-cover rounded border cursor-zoom-in transition hover:opacity-80"
                                onClick={() => setPreviewImage(f.stored)}
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                              />
                            ) : (
                              <p className="font-medium line-clamp-2">{f.stored}</p>
                            )}
                          </div>
                          <div>
                            <p className="text-muted-foreground mb-0.5">{marketplaceLabel}</p>
                            {isImg ? (
                              (() => {
                                // Prefer the dedicated image/URL fields; fall back to `live`
                                // (older records where `live` held one URL).
                                const liveImg = f.liveImage || (isUrl(f.live) && !f.liveUrl ? f.live : "");
                                // Prefer stored product page URL; for Amazon, fall back to ASIN → dp URL
                                // so older verify results still link to the listing.
                                const isAmazon = marketplace === "amazon" || marketplace === "amazon_us";
                                const productUrl =
                                  f.liveUrl ||
                                  (isAmazon && p.asin ? `https://www.amazon.com/dp/${p.asin}` : "") ||
                                  "";
                                if (!liveImg && !productUrl) {
                                  return <p className="font-medium line-clamp-2">{f.live}</p>;
                                }
                                return (
                                  <div className="flex flex-col gap-1">
                                    {liveImg && (
                                      <img
                                        src={liveImg}
                                        alt={marketplaceLabel}
                                        className="w-16 h-16 object-cover rounded border cursor-zoom-in transition hover:opacity-80"
                                        onClick={() => setPreviewImage(liveImg)}
                                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                      />
                                    )}
                                    {productUrl ? (
                                      <a href={productUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline truncate max-w-[160px]">
                                        View Product
                                      </a>
                                    ) : liveImg ? (
                                      <button
                                        type="button"
                                        onClick={() => setPreviewImage(liveImg)}
                                        className="text-blue-600 underline truncate max-w-[160px] text-left"
                                      >
                                        View Image
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })()
                            ) : (
                              <p className="font-medium line-clamp-2">{f.live}</p>
                            )}
                          </div>
                          {(() => {
                            // For the images field, check if there's a browser-side result
                            // that overrides the server-side note (used when the server
                            // couldn't download the marketplace image due to CDN blocking).
                            const stateKey = `${p.id}:${f.field}`;
                            const browserState = imgCheckState.get(stateKey);
                            const displayNote = browserState?.note ?? f.note;
                            const displaySeverity: "ok" | "warning" | "mismatch" =
                              browserState?.verdict === "match" ? "ok"
                              : browserState?.verdict === "mismatch" ? "mismatch"
                              : f.severity;

                            // The auto-check fires on expand (see useEffect above).
                            // Show Retry button only once the check finishes as "unsure".
                            const isImageField = f.field === "images";
                            const serverFailed = isImageField && /image comparison failed|could not download marketplace image/i.test(f.note ?? "");
                            const checkDoneUnsure = browserState && !browserState.loading && browserState.verdict === "unsure";
                            const canRetry = (serverFailed || isImageField) && checkDoneUnsure;
                            const vendorUrl  = f.stored?.startsWith("http") ? f.stored : "";
                            const liveImgUrl = f.liveImage || (isUrl(f.live) ? f.live : "");

                            // Loading message includes attempt counter when retrying
                            const attemptNum = browserState?.attempt ?? 1;
                            const loadingMsg = attemptNum > 1
                              ? `Retrying AI image check… (attempt ${attemptNum}/3)`
                              : "Running AI image check…";

                            if (!displayNote && !browserState?.loading) return null;
                            const style = AI_NOTE_STYLE[displaySeverity] ?? AI_NOTE_STYLE.warning;
                            const isAiNote = /^\s*(ai (visual|title) check|needs manual review)/i.test(displayNote ?? "");
                            const noteText = (displayNote ?? "").replace(/^\s*ai (visual|title) check:?\s*/i, "");
                            return (
                              <div className={cn("col-span-3 flex items-start gap-2 rounded-lg px-3 py-2", style.wrap)}>
                                <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full shadow-sm", style.badge)}>
                                  {browserState?.loading ? (
                                    <Loader2 className="h-3 w-3 text-white animate-spin" />
                                  ) : (
                                    <Sparkles className="h-3 w-3 text-white" />
                                  )}
                                </span>
                                <div className={cn("flex flex-col gap-1.5 text-[11px] leading-relaxed", style.text)}>
                                  {browserState?.loading ? (
                                    <p className="opacity-75">{browserState.note ?? loadingMsg}</p>
                                  ) : displayNote ? (
                                    <p>
                                      <span className={cn("mr-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide", style.pill)}>
                                        {isAiNote ? "AI Visual Check" : "Review"}
                                      </span>
                                      {noteText}
                                    </p>
                                  ) : null}
                                  {canRetry && vendorUrl && liveImgUrl && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        autoCheckedRef.current.delete(p.id);
                                        runImageCheck(p.id, f.field, vendorUrl, [liveImgUrl], p.name);
                                      }}
                                      className="self-start rounded bg-yellow-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-yellow-700 transition"
                                    >
                                      Retry AI Image Check
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                    {fields.length === 0 && (
                      <div className="px-4 py-2.5 text-xs text-muted-foreground">No comparison data available for this product.</div>
                    )}
                  </div>
                    </>
                  );
                })()}
              </div>
            );
          })}

          {/* Streaming footer: sits below the last verified row so the list
              reads as "more on the way" rather than "this is everything". */}
          {loading && hasStreamedResults && (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <LottieLoader size={40} />
              <p className="text-sm font-medium">
                Verified {verifiedProducts.length.toLocaleString()}
                {verifyTotal ? ` of ${verifyTotal.toLocaleString()}` : ""} — still checking…
              </p>
              <p className="text-xs text-muted-foreground">
                Results appear here as they finish. You can review the ones above now.
              </p>
              {formatDuration(liveElapsedMs) && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {formatDuration(liveElapsedMs)} elapsed
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Image preview modal — opens when a thumbnail is clicked. Rendered
          through a portal to <body>: inside the step card it would sit in the
          page's z-10 stacking context and be painted UNDER the sticky header
          (z-20) and floating pills (z-30). z-[100] also clears the sidebar. */}
      {previewImage && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-h-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setPreviewImage(null)}
              aria-label="Close preview"
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-700 shadow hover:bg-gray-100"
            >
              <XCircle className="h-5 w-5" />
            </button>
            <img
              src={previewImage}
              alt="Preview"
              className="max-h-[80vh] max-w-full rounded-lg bg-white object-contain shadow-xl"
            />
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
