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

export function VerifyStep({ projectId, projectName, marketplace, products, verifiedCount, warningCount, mismatchCount, notFoundCount, discontinuedCount, loading, projectStatus, elapsedMs, completedAt, onRunVerify, onApproveProduct, onMarkDiscontinued, onReverifyProduct, onNext }: {
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
      const iv = setInterval(tick, 1000);
      return () => clearInterval(iv);
    }
    passStartRef.current = null;
    setLiveElapsedMs(null);
  }, [loading, elapsedMs, completedAt]);

  const visibleProducts = activeFilter
    ? products.filter((p) => (p.verifyStatus ?? "not_found") === activeFilter)
    : products;

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
              Verifying… {formatDuration(liveElapsedMs)} elapsed
            </p>
          )}
          {!loading && completedAt && formatDuration(elapsedMs) && (
            <p className="text-xs text-green-700 mt-1 font-medium">
              Verification done in {formatDuration(elapsedMs)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:gap-3">
          {hasResults && (
            <button
              onClick={downloadReport}
              disabled={downloading}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Download Report
            </button>
          )}
          {hasResults && (warningCount > 0 || mismatchCount > 0) && (
            <button
              onClick={() => onRunVerify(true, true)}
              disabled={loading}
              title="Re-check flagged products with AI image and title comparison. Slower, and only examines warnings and mismatches."
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              AI deep check
            </button>
          )}
          {hasResults && (
            <button
              onClick={() => onRunVerify(true)}
              disabled={loading}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4" />
              Re-verify
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

      {/* Summary cards */}
      {hasResults && (
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
            {marketplace === "amazon_us" ? (
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

      {loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <LottieLoader size={96} className="mb-2" />
          <p className="text-sm font-medium">Verifying products against {marketplaceLabel}…</p>
          <p className="text-xs text-muted-foreground mt-1">This may take a few minutes</p>
          {formatDuration(liveElapsedMs) && (
            <p className="text-sm font-medium mt-3 tabular-nums">{formatDuration(liveElapsedMs)} elapsed</p>
          )}
        </div>
      )}

      {/* Product results */}
      {hasResults && !loading && (
        <div className="space-y-2">
          {visibleProducts.map((p) => {
            const cfg = STATUS_CONFIG[p.verifyStatus as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.not_found;
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
                  {p.verifyStatus === "warning" && (
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

                {isOpen && (
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
                          {f.note && (() => {
                            const style = AI_NOTE_STYLE[f.severity];
                            // AI-generated verdicts are prefixed ("AI visual check:" /
                            // "AI title check:" / "Needs manual review —"). A note without
                            // that prefix is a static reviewer hint (e.g. the image check
                            // was skipped), so label it "Review", not "AI Visual Check".
                            const isAiNote = /^\s*(ai (visual|title) check|needs manual review)/i.test(f.note);
                            const noteText = f.note.replace(/^\s*ai (visual|title) check:?\s*/i, "");
                            return (
                              <div className={cn("col-span-3 flex items-start gap-2 rounded-lg px-3 py-2", style.wrap)}>
                                <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full shadow-sm", style.badge)}>
                                  <Sparkles className="h-3 w-3 text-white" />
                                </span>
                                <p className={cn("text-[11px] leading-relaxed", style.text)}>
                                  <span className={cn("mr-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide", style.pill)}>
                                    {isAiNote ? "AI Visual Check" : "Review"}
                                  </span>
                                  {noteText}
                                </p>
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
                )}
              </div>
            );
          })}
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
