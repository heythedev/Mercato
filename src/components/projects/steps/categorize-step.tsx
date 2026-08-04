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
  categorizedAt: Date | null;
};

export function CategorizeStep({ projectId, projectName, products, categorizedCount, loading, projectStatus, marketplace, elapsedMs, completedAt, onRunCategorize, onNext }: {
  projectId: string;
  projectName: string;
  products: Product[];
  categorizedCount: number;
  loading: boolean;
  projectStatus: string;
  marketplace: string;
  elapsedMs?: number | null;
  completedAt?: string | null;
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
  const csvRef = useRef<HTMLInputElement>(null);

  const uncategorized = products.filter((p) => p.marketplaceCategory === "Uncategorized");
  const categorized = products.filter((p) => p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized");
  const pending = products.filter((p) => !p.marketplaceCategory);
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
      const iv = setInterval(tick, 1000);
      return () => clearInterval(iv);
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
      ["SKU", "Product Name", "Brand", "Category", "Category Path", "Status"],
      ...products.map((p) => [
        p.vendorSku ?? p.id,
        p.name,
        p.brand ?? "",
        p.marketplaceCategory ?? "",
        p.categoryPath ?? "",
        p.marketplaceCategory === "Uncategorized" ? "No match" : p.marketplaceCategory ? "Done" : "Not categorized",
      ]),
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
              {categorized.length + uncategorized.length > 0 && total > 0
                ? <>Categorizing {(categorized.length + uncategorized.length).toLocaleString()} / {total.toLocaleString()} · {formatDuration(liveElapsedMs)} elapsed</>
                : <>Categorizing… {formatDuration(liveElapsedMs)} elapsed</>}
            </p>
          )}
          {!loading && completedAt && formatDuration(elapsedMs) && (
            <p className="text-xs text-green-700 mt-1 font-medium">
              Categorization done in {formatDuration(elapsedMs)}
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
            title="Upload a corrected category CSV (SKU, Category, Category Path columns)"
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
          <div className="rounded-2xl p-5 bg-green-50/70 dark:bg-green-950/20">
            <p className="text-2xl font-bold text-green-700 dark:text-green-400">{categorized.length}</p>
            <p className="text-sm text-muted-foreground">Categorized</p>
          </div>
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
              {(loading ? products.filter((p) => p.marketplaceCategory) : products).map((p) => {
                const isUncategorized = p.marketplaceCategory === "Uncategorized";
                return (
                  <tr key={p.id} className={`transition-colors ${isUncategorized ? "bg-orange-50/60 hover:bg-orange-50" : "hover:bg-muted/30"}`}>
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
        </div>
      )}
    </div>
  );
}
