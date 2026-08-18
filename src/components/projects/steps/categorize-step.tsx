"use client";

import { useEffect, useRef, useState } from "react";
import { Tag, Loader2, CheckCircle2, AlertTriangle, XCircle, Download, Upload } from "lucide-react";
import { toast } from "sonner";
import { buildDownloadName } from "@/lib/export/filename";
import { LottieLoader } from "@/components/ui/lottie-loader";
import { formatDuration } from "@/lib/utils";

type Product = {
  id: string;
  name: string;
  brand: string | null;
  vendorSku: string | null;
  marketplaceCategory: string | null;
  categoryPath: string | null;
  categoryConfidence: number | null;
  categorizedAt: Date | null;
};

export function CategorizeStep({ projectId, projectName, products, categorizedCount, loading, projectStatus, marketplace, elapsedMs, completedAt, phase, onRunCategorize, onNext }: {
  projectId: string;
  projectName: string;
  products: Product[];
  categorizedCount: number;
  loading: boolean;
  projectStatus: string;
  marketplace: string;
  elapsedMs?: number | null;
  completedAt?: string | null;
  /** Server-reported phase, shown once the per-product count can no longer move. */
  phase?: string | null;
  onRunCategorize: (force?: boolean) => void;
  onNext: () => void;
}) {
  const isMathis = marketplace === "mathis";
  const isTemu = marketplace === "temu";
  const isBestBuy = marketplace === "bestbuy";
  const isWalmart = marketplace === "walmart";
  const hasResults = products.some((p) => p.marketplaceCategory);
  const total = products.length;
  const [uploading, setUploading] = useState(false);
  // Rendered-row cap: counts and the CSV download still cover the whole
  // catalog, but only this many rows go into the DOM — 10k <tr>s freeze the tab.
  const INITIAL_ROWS = 200;
  const ROWS_STEP = 500;
  const [visibleRows, setVisibleRows] = useState(INITIAL_ROWS);
  const csvRef = useRef<HTMLInputElement>(null);

  const uncategorized = products.filter((p) => p.marketplaceCategory === "Uncategorized");
  const categorized = products.filter((p) => p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized");
  const pending = products.filter((p) => !p.marketplaceCategory);
  // Assigned a category, but the model itself wasn't sure. Constrained
  // marketplaces keep low-confidence guesses (gate 0.2) instead of dropping
  // them to "Uncategorized" — precisely so a human can review them here
  // rather than have a silent guess go straight to export.
  const REVIEW_CONFIDENCE = 0.6;
  const needsReview = categorized.filter((p) => p.categoryConfidence != null && p.categoryConfidence < REVIEW_CONFIDENCE);
  // Products that already have a verdict RIGHT NOW. During a run this grows as waves
  // land (see startCategorizeFeed in project-detail.tsx), which is what lets the
  // results table render mid-run instead of waiting for the whole catalog to finish —
  // same streaming pattern as the Verify step.
  const hasStreamedResults = loading && (categorized.length > 0 || uncategorized.length > 0);

  // Live running timer while categorizing (server persists elapsedMs only on
  // completion, so we tick client-side from when this run started).
  const [liveElapsedMs, setLiveElapsedMs] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (loading) {
      if (startRef.current == null) startRef.current = Date.now();
      const tick = () => setLiveElapsedMs(Date.now() - startRef.current!);
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
    startRef.current = null;
    setLiveElapsedMs(null);
  }, [loading]);

  async function handleCsvUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/categorize`, { method: "PUT", body: fd });
      const data = await res.json() as { updated?: number; total?: number; error?: string };
      if (!res.ok) { toast.error(data.error ?? "Upload failed"); return; }
      toast.success(`Categories imported — ${data.updated} of ${data.total} products updated`);
      window.location.reload();
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function downloadCsv() {
    const rows = [
      // "Confidence" is ignored by the CSV import (headers resolve by name),
      // so download -> edit -> upload stays lossless with the extra column.
      ["SKU", "Product Name", "Brand", "Category", "Product Type", "Category Path", "Confidence", "Status"],
      ...products.map((p) => {
        // "Category > Product Type" paths are split into two columns for easier
        // review. The CSV import (PUT) re-joins them, so download -> edit ->
        // upload stays lossless — keep the header names in sync with it.
        // Most rows store only the leaf ("Shop All Wall Sconces") in
        // marketplaceCategory while categoryPath carries the full two-level
        // path — split from the path in that case so Product Type isn't blank.
        const cat = p.marketplaceCategory ?? "";
        const path = p.categoryPath ?? "";
        const full =
          cat && cat !== "Uncategorized" && !cat.includes(" > ") && path.includes(" > ")
            ? path
            : cat;
        const sep = full.indexOf(" > ");
        const topCategory = sep === -1 ? full : full.slice(0, sep);
        const productType = sep === -1 ? "" : full.slice(sep + 3);
        const conf = p.categoryConfidence;
        const confLabel = conf == null || !cat || cat === "Uncategorized" ? ""
          : conf >= 0.8 ? "High" : conf >= REVIEW_CONFIDENCE ? "Medium" : "Low";
        return [
          p.vendorSku ?? p.id,
          p.name,
          p.brand ?? "",
          topCategory,
          productType,
          p.categoryPath ?? "",
          confLabel,
          p.marketplaceCategory === "Uncategorized" ? "No match" : p.marketplaceCategory ? "Done" : "Not categorized",
        ];
      }),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildDownloadName({
      prefix: "mercato-categories",
      projectName,
      marketplace,
      extension: "csv",
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-4 sm:p-8">
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Auto-Categorization</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isMathis
              ? "AI matches each product to an exact Mathis path (up to 4 levels)"
              : isTemu || isBestBuy
              ? "AI matches each product to an exact path from the shared category sheet"
              : `AI assigns each product to the correct ${marketplace} category`}
          </p>
          {loading && formatDuration(liveElapsedMs) && (
            <p className="text-xs text-muted-foreground mt-1 font-medium tabular-nums">
              {(() => {
                const done = categorized.length + uncategorized.length;
                // Every product has a row once the streaming writes land, but the
                // run isn't over: off-list retry, web-search rescue and the
                // forced-choice pass still refine results afterwards. Showing
                // "7,021 / 7,021" through all of that reads as a frozen timer, so
                // once the count saturates we show what the server is actually
                // doing instead of a count that can no longer move.
                if (done > 0 && total > 0 && done < total) {
                  return <>Categorizing {done.toLocaleString()} / {total.toLocaleString()} · {formatDuration(liveElapsedMs)} elapsed</>;
                }
                if (done > 0 && total > 0) {
                  return <>{phase ?? "Finishing up"} · {formatDuration(liveElapsedMs)} elapsed</>;
                }
                return <>Categorizing… {formatDuration(liveElapsedMs)} elapsed</>;
              })()}
            </p>
          )}
          {/* Show completion even when the duration is unknown. A run whose
              process died after writing every product but before stamping
              categorizeMs has a 0/null duration; requiring a formatted duration
              here made the whole line vanish, so a finished run looked as if it
              had never completed. */}
          {!loading && completedAt && (
            <p className="text-xs text-green-700 mt-1 font-medium">
              {formatDuration(elapsedMs)
                ? <>Categorization done in {formatDuration(elapsedMs)}</>
                : <>Categorization complete</>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:gap-3">
          {isWalmart && (
            <button
              onClick={onNext}
              disabled={loading}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              Skip →
            </button>
          )}
          {/* Hidden CSV upload input */}
          <input
            ref={csvRef}
            type="file"
            accept=".csv,.tsv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvUpload(f); e.target.value = ""; }}
          />
          <button
            onClick={() => csvRef.current?.click()}
            disabled={uploading || loading}
            className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            title="Upload a corrected category CSV (SKU, Category, Product Type, Category Path columns)"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Import Categories
          </button>
          {hasResults && (
            <button
              onClick={downloadCsv}
              disabled={loading}
              title={loading ? "Available when categorization completes" : undefined}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              Download CSV
            </button>
          )}
          {hasResults && (
            <button
              onClick={() => onRunCategorize(true)}
              disabled={loading}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              <Tag className="w-4 h-4" />
              Re-categorize
            </button>
          )}
          <button
            onClick={hasResults ? onNext : () => onRunCategorize(false)}
            disabled={loading}
            className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {loading ? <LottieLoader size={20} onDark className="-my-2" /> : <Tag className="w-4 h-4" />}
            {loading ? "Categorizing…" : hasResults ? "Continue to Export →" : "Run Categorization"}
          </button>
        </div>
      </div>

      {/* Progress */}
      {(hasResults || hasStreamedResults) && (
        <div className={`grid grid-cols-1 gap-3 sm:gap-4 mb-6 ${needsReview.length > 0 ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
          <div className="rounded-2xl p-5 bg-green-50/70 dark:bg-green-950/20">
            <p className="text-2xl font-bold text-green-700 dark:text-green-400">{categorized.length}</p>
            <p className="text-sm text-muted-foreground">Categorized</p>
          </div>
          {needsReview.length > 0 && (
            <div className="rounded-2xl p-5 bg-amber-50/70 dark:bg-amber-950/20">
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{needsReview.length}</p>
              <p className="text-sm text-muted-foreground">Low confidence</p>
            </div>
          )}
          <div className={`rounded-2xl p-5 ${uncategorized.length > 0 ? "bg-orange-50/70 dark:bg-orange-950/20" : "bg-muted/30"}`}>
            <p className={`text-2xl font-bold ${uncategorized.length > 0 ? "text-orange-600 dark:text-orange-400" : ""}`}>{uncategorized.length}</p>
            <p className="text-sm text-muted-foreground">Uncategorized</p>
          </div>
          <div className="rounded-2xl p-5 bg-muted/30">
            <p className="text-2xl font-bold">{total}</p>
            <p className="text-sm text-muted-foreground">Total products</p>
          </div>
        </div>
      )}
      {loading && (hasResults || hasStreamedResults) && (
        <p className="text-xs text-muted-foreground -mt-4 mb-6">Counts update as products finish categorizing.</p>
      )}

      {/* Uncategorized warning banner — suppressed while still streaming, since the
          count (and which products) is provisional until the run finishes; the
          bulletproofing gate can still downgrade or upgrade entries at the end. */}
      {hasResults && !loading && uncategorized.length > 0 && (
        <div className="mb-6 rounded-2xl bg-orange-50/70 dark:bg-orange-950/20 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-orange-800">
                {uncategorized.length} product{uncategorized.length !== 1 ? "s" : ""} could not be matched to a{isMathis ? " Mathis" : ""} category
              </p>
              <p className="text-xs text-orange-700 mt-1">
                {isMathis
                  ? "These products don't fit any path in the Mathis category sheet (e.g. everyday apparel, fragrances, electronics, food). They will be excluded from the ZIP export. Review them below or remove them from the vendor file."
                  : "These products couldn't be confidently assigned a category. They will be excluded from the export. Try re-categorizing or check the product names."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Low-confidence review banner — the AI assigned these a category but
          flagged that it was guessing between plausible entries. Surfaced so a
          human can check them before export instead of silently publishing. */}
      {hasResults && !loading && needsReview.length > 0 && (
        <div className="mb-6 rounded-2xl bg-amber-50/70 dark:bg-amber-950/20 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800">
                {needsReview.length} product{needsReview.length !== 1 ? "s" : ""} categorized with low confidence
              </p>
              <p className="text-xs text-amber-700 mt-1">
                The AI assigned these a category but wasn&apos;t sure between multiple plausible options — usually because the product name is short or ambiguous. They&apos;re marked &quot;Review&quot; in the table below. Check them before exporting, or download the CSV, correct the categories, and upload it back.
              </p>
            </div>
          </div>
        </div>
      )}

      {!hasResults && !loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Tag className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-base font-semibold mb-1">Ready to categorize</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {isMathis
              ? "AI will match each product to the Mathis Home taxonomy (Department > Category > Subcategory > Product Type, up to 4 levels). Products that don't fit any path will be flagged."
              : isTemu || isBestBuy
              ? "AI will send each product plus the shared category sheet to Claude and assign the most specific Category > Subcategory > Sub-Subcategory path."
              : `AI will analyze each product and assign it to the correct category in the ${marketplace} taxonomy.`}
          </p>
        </div>
      )}

      {/* Full-page loader only until the first results arrive. Once products start
          streaming in, they replace it and the run reports progress at the bottom
          of the table instead — the user can start reviewing immediately rather
          than waiting for the final batch (mirrors the Verify step). */}
      {loading && !hasStreamedResults && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <LottieLoader size={96} className="mb-2" />
          <p className="text-sm font-medium">Categorizing products with AI…</p>
          {categorized.length + uncategorized.length > 0 && total > 0 ? (
            <p className="text-sm font-medium mt-1 tabular-nums">
              Categorized {(categorized.length + uncategorized.length).toLocaleString()} of {total.toLocaleString()} products
            </p>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">This may take a minute for large batches</p>
          )}
          {formatDuration(liveElapsedMs) && (
            <p className="text-sm text-muted-foreground mt-3 tabular-nums">{formatDuration(liveElapsedMs)} elapsed</p>
          )}
        </div>
      )}

      {/* Results table */}
      {(hasResults || hasStreamedResults) && (
        <div className="rounded-2xl bg-muted/20 overflow-x-auto overflow-y-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Product</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Category</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Path</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {/* While a run is streaming, show only products that already have a
                  verdict — the not-yet-processed remainder would otherwise render as
                  a wall of "—" placeholder rows. Once the run finishes, show
                  everything (matches the Verify step's resultPool pattern). */}
              {(loading ? products.filter((p) => p.marketplaceCategory) : products).slice(0, visibleRows).map((p) => {
                const isUncategorized = p.marketplaceCategory === "Uncategorized";
                const lowConfidence = !isUncategorized && !!p.marketplaceCategory &&
                  p.categoryConfidence != null && p.categoryConfidence < REVIEW_CONFIDENCE;
                return (
                  <tr key={p.id} className={`transition-colors ${isUncategorized ? "bg-orange-50/60 hover:bg-orange-50" : lowConfidence ? "bg-amber-50/60 hover:bg-amber-50" : "hover:bg-muted/30"}`}>
                    <td className="px-4 py-3">
                      <p className="font-medium line-clamp-1">{p.name}</p>
                      {p.brand && <p className="text-xs text-muted-foreground">{p.brand}</p>}
                    </td>
                    <td className="px-4 py-3 font-medium text-sm">
                      {isUncategorized ? (
                        <span className="text-orange-600">No match found</span>
                      ) : (
                        p.marketplaceCategory ?? "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{isUncategorized ? "—" : (p.categoryPath ?? "—")}</td>
                    <td className="px-4 py-3 text-center">
                      {isUncategorized ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                          <XCircle className="w-3 h-3" />
                          No match
                        </span>
                      ) : lowConfidence ? (
                        <span
                          className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700"
                          title={`AI confidence ${Math.round((p.categoryConfidence ?? 0) * 100)}% — the model was unsure between plausible categories; verify this one before exporting`}
                        >
                          <AlertTriangle className="w-3 h-3" />
                          Review
                        </span>
                      ) : p.marketplaceCategory ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                          <CheckCircle2 className="w-3 h-3" />
                          Done
                        </span>
                      ) : (
                        // Not a verdict about the product — this row simply
                        // hasn't been through categorization yet.
                        <span
                          className="text-xs text-muted-foreground"
                          title="This product hasn't been categorized yet — run Categorization to assign it"
                        >
                          Not categorized
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(() => {
            // Same pool as the rows above: streamed verdicts while running,
            // the whole catalog once finished.
            const poolSize = loading ? categorized.length + uncategorized.length : total;
            if (poolSize <= visibleRows) return null;
            return (
              <div className="flex justify-center border-t border-border/40 py-3">
                <button
                  onClick={() => setVisibleRows((v) => v + ROWS_STEP)}
                  className="inline-flex items-center gap-2 h-8 px-4 rounded-lg border text-xs font-medium hover:bg-accent transition"
                >
                  Show more ({(poolSize - visibleRows).toLocaleString()} remaining)
                </button>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
