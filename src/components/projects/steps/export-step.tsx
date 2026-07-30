"use client";

import { useState, useEffect, useRef } from "react";
import { AlertTriangle, Download, FileSpreadsheet, Package, RefreshCw, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { exportGroupOf } from "@/lib/export/category-group";
import { buildDownloadName } from "@/lib/export/filename";
import { LottieLoader } from "@/components/ui/lottie-loader";

type Template = {
  id: string;
  name: string;
  marketplace: string;
  category: string | null;
  fileFormat: string;
  userId: string | null;
};

type Product = {
  id: string;
  name: string;
  marketplaceCategory: string | null;
};

function matchTemplate(category: string, templates: Template[]): Template {
  if (templates.length === 1) return templates[0];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  // Prefer a generic catch-all over first-in-array when no specific match exists
  const isGeneric = (t: Template) => /\bother(s)?\b|\bgeneral\b|\bdefault\b/i.test(t.name);
  const fallback = templates.find(isGeneric) ?? templates[0];

  const department = category.split(/\s*>\s*/)[0]?.trim() || category;
  const normDept = norm(department);
  const normCat = norm(category);
  const catWords = normCat.split(" ").filter((w) => w.length > 2);

  // Score one string against the product category — higher is better.
  const scoreTarget = (raw: string): number => {
    const target = norm(raw);
    const bareName = target.replace(/\s+\d+$/, "").trim();
    const targetWords = target.split(" ").filter((w) => w.length > 2);
    let sc = 0;
    if (target === normDept || bareName === normDept) sc += 20;
    else if (normDept.startsWith(target) || target.startsWith(normDept)) sc += 12;
    else if (
      (target.length >= 5 && normDept.startsWith(target.slice(0, 5))) ||
      (normDept.length >= 5 && target.startsWith(normDept.slice(0, 5)))
    ) sc += 10;
    for (const word of catWords) if (targetWords.includes(word)) sc += 2;
    for (const word of targetWords) if (catWords.includes(word)) sc += 1;
    if (target.includes(normCat)) sc += 5;
    if (normCat.includes(target)) sc += 3;
    if (target === normCat) sc += 10;
    return sc;
  };

  let best = fallback;
  let bestScore = 0; // must beat 0 to override the chosen fallback

  for (const t of templates) {
    // Score against BOTH the template name AND its category field — take the higher.
    // This matters when a template has a short internal category label ("TEMU CHAIRS (1)")
    // but a descriptive name ("Home & Kitchen / Furniture / Dining Room Furniture / Chairs").
    const score = Math.max(
      scoreTarget(t.name),
      t.category ? scoreTarget(t.category) : 0,
    );
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

export function ExportStep({ projectId, projectName, marketplace, products, projectStatus }: {
  projectId: string;
  projectName: string;
  marketplace: string;
  products: Product[];
  verifiedCount: number;
  projectStatus: string;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [fetching, setFetching] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // For single-template marketplaces: user picks which template to export with
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [missingTemplateCategories, setMissingTemplateCategories] = useState<string[]>([]);
  const mountedRef = useRef(true);

  const isMathis = marketplace === "mathis";
  const isTemu = marketplace === "temu";
  const isBestBuy = marketplace === "bestbuy";
  // Category-split marketplaces: one file per category, matched to template automatically.
  // Walmart uses single-template picker (like Amazon) so users can choose their template.
  const usesCategoryZip = isMathis || isTemu || isBestBuy;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Load templates for this marketplace. Extracted so the "Refresh" button can
  // re-run it after the user uploads a new template in another tab — without a
  // full page reload. `isRefresh` drives the button spinner (vs. initial fetch)
  // and lets us report how many templates were found on demand.
  async function loadTemplates(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    try {
      const r = await fetch(`/api/templates?marketplace=${marketplace}`, { cache: "no-store" });
      const data = await r.json();
      const tpls: Template[] = data.templates ?? [];
      if (!mountedRef.current) return;
      const prevCount = templates.length;
      setTemplates(tpls);
      // Auto-select first template for single-template marketplaces when none picked yet
      if (!usesCategoryZip && tpls.length > 0 && !selectedTemplateId) {
        setSelectedTemplateId(tpls[0].id);
      }
      if (isRefresh) {
        const added = tpls.length - prevCount;
        toast.success(
          added > 0
            ? `Found ${added} new template${added !== 1 ? "s" : ""} (${tpls.length} total)`
            : `No new templates — ${tpls.length} available`,
        );
      }
    } catch {
      if (isRefresh && mountedRef.current) toast.error("Couldn't refresh templates");
    } finally {
      if (mountedRef.current) {
        setFetching(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    void loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace]);

  // One entry per output FILE. Mathis produces one file per department, so all
  // "Baby & Kids > …" leaf paths collapse into a single "Baby & Kids" row here —
  // this must stay in sync with the server-side grouping in generateCategoryZip.
  const categoryCounts = new Map<string, number>();
  for (const p of products) {
    if (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") {
      const group = exportGroupOf(p.marketplaceCategory, marketplace);
      categoryCounts.set(group, (categoryCounts.get(group) ?? 0) + 1);
    }
  }
  const categories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
  // "Uncategorized" (AI flagged) + null (never categorized) — both are excluded from export
  const uncategorizedCount = products.filter((p) => !p.marketplaceCategory || p.marketplaceCategory === "Uncategorized").length;
  const exportableCount = products.length - uncategorizedCount;

  const hasTemplates = templates.length > 0;

  // For Temu: compute which category groups have no specific matching template
  // (would fall back to the catch-all OTHER template) so we can warn the user
  // before they export rather than after.
  const isGenericTemplate = (t: Template) => /\bother(s)?\b|\bgeneral\b|\bdefault\b/i.test(t.name);
  const preExportMissingCategories: string[] = isTemu && templates.length > 1 && templates.some(isGenericTemplate)
    ? categories
        .map(([cat]) => cat)
        .filter(cat => isGenericTemplate(matchTemplate(cat, templates)))
    : [];

  // Category-split (Mathis/Temu/BestBuy): needs categorized products; Mathis also requires templates
  // Other: needs at least 1 product; if templates exist, one must be selected
  const canExport = !loading && !fetching && (
    usesCategoryZip
      ? (isMathis ? hasTemplates : true) && categories.length > 0
      : products.length > 0 && (!hasTemplates || !!selectedTemplateId)
  );

  async function handleExport() {
    setLoading(true);
    setStatusMsg("Starting export…");
    try {
      // Category-split (Mathis/Temu/BestBuy): autoMatch=true — server matches each category to closest template
      // Single-template with selection: pass templateIds=[selectedId]
      // Fallback: autoMatch=true → flat export
      const body = usesCategoryZip
        ? { autoMatch: true }
        : hasTemplates && selectedTemplateId
          ? { templateIds: [selectedTemplateId] }
          : { autoMatch: true };

      const startRes = await fetch(`/api/projects/${projectId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!startRes.ok) {
        const text = await startRes.text().catch(() => "");
        let msg = "Export failed";
        try { msg = (JSON.parse(text) as { error?: string }).error ?? (text.slice(0, 300) || msg); } catch { msg = text.slice(0, 300) || msg; }
        toast.error(msg);
        return;
      }

      const { jobId } = (await startRes.json()) as { jobId: string };
      setStatusMsg("Processing files…");

      // A fixed wall-clock deadline used to abandon exports that were still
      // running fine — the ZIP finished server-side but nobody collected it, so
      // the user saw "timed out" and got no file. Instead of a hard cap, give up
      // only when the server stops making progress: each new phase (or any
      // successful poll) resets the stall window.
      const STALL_LIMIT_MS = 5 * 60 * 1000;  // no progress at all for 5 min → give up
      const HARD_LIMIT_MS = 30 * 60 * 1000;  // absolute backstop
      const startedAt = Date.now();
      let lastProgressAt = Date.now();
      let lastPhase = "";

      while (Date.now() - startedAt < HARD_LIMIT_MS) {
        await new Promise((r) => setTimeout(r, 2500));
        if (!mountedRef.current) return;

        const pollRes = await fetch(
          `/api/projects/${projectId}/export?jobId=${encodeURIComponent(jobId)}`
        );

        const contentType = pollRes.headers.get("content-type") ?? "";

        // Anything that isn't a JSON status update is the finished export. A
        // single-file export (Walmart) arrives as the spreadsheet itself rather
        // than a ZIP, so match on "not JSON" instead of a fixed ZIP type.
        if (pollRes.ok && !contentType.includes("application/json")) {
          const blob = await pollRes.blob();
          const isZip = contentType.includes("application/zip");
          // Prefer the server's own filename so both sides can never disagree
          // about the extension; fall back to rebuilding it locally.
          const disposition = pollRes.headers.get("content-disposition") ?? "";
          const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
          const plainName = disposition.match(/filename="([^"]+)"/i)?.[1];
          const serverName = encodedName
            ? decodeURIComponent(encodedName)
            : plainName;
          const filename = serverName || buildDownloadName({
            projectName, marketplace, extension: isZip ? "zip" : "xlsx",
          });

          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);

          // Check if any Temu categories were excluded due to missing templates
          const missingHeader = pollRes.headers.get("X-Missing-Template-Categories") ?? "";
          const missing = missingHeader.split(",").filter(Boolean).map(decodeURIComponent);
          setMissingTemplateCategories(missing);

          if (isZip) {
            const fileCount = usesCategoryZip ? categories.length : 1;
            toast.success(`ZIP downloaded — ${fileCount} file${fileCount !== 1 ? "s" : ""}`);
          } else {
            toast.success(`Downloaded ${filename}`);
          }
          return;
        }

        if (!pollRes.ok) {
          const data = await pollRes.json().catch(() => ({ error: "Export failed" })) as { error?: string };
          toast.error(data.error ?? "Export failed");
          return;
        }

        const data = (await pollRes.json()) as {
          status: string; error?: string; phase?: string; updatedAt?: number;
        };
        if (data.status === "error") {
          toast.error(data.error ?? "Export failed");
          return;
        }

        // Any phase change counts as progress and resets the stall window, so a
        // genuinely slow export (large catalogs, AI title generation) is never
        // cut off while it is still working.
        if (data.phase && data.phase !== lastPhase) {
          lastPhase = data.phase;
          lastProgressAt = Date.now();
          setStatusMsg(data.phase);
        }
        if (Date.now() - lastProgressAt > STALL_LIMIT_MS) {
          toast.error("Export stalled — no progress from the server. Please try again.");
          return;
        }
      }

      toast.error("Export timed out — please try again");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed — check server logs");
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setStatusMsg("");
      }
    }
  }

  // Multi-file marketplaces ship a ZIP; single-file ones (Walmart) download the
  // spreadsheet directly, so the label shouldn't promise an archive.
  const buttonLabel = loading
    ? (statusMsg || (usesCategoryZip ? "Generating ZIP…" : "Generating file…"))
    : usesCategoryZip
      ? `Download ZIP (${categories.length} file${categories.length !== 1 ? "s" : ""})`
      : `Download Excel (${products.length} product${products.length !== 1 ? "s" : ""})`;

  return (
    <div className="p-4 sm:p-8">
      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Export ZIP</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {usesCategoryZip
              ? "One Excel file per category — templates matched automatically"
              : "Export all products using your chosen template"}
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={!canExport}
          className="inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? <LottieLoader size={20} onDark className="-my-2" /> : <Download className="w-4 h-4" />}
          {buttonLabel}
        </button>
      </div>

      {/* Missing-template warning — shown before export so user knows what will be excluded */}
      {(() => {
        const allMissing = [...new Set([...preExportMissingCategories, ...missingTemplateCategories])];
        if (allMissing.length === 0) return null;
        return (
          <div className="mb-5 rounded-2xl bg-amber-50 dark:bg-amber-950/30 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  {allMissing.length} categor{allMissing.length === 1 ? "y" : "ies"} will be excluded — no matching template
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5 mb-2">
                  Upload a dedicated template for each category below, then click Refresh to pick it up here (no page reload needed).
                </p>
                <ul className="flex flex-col gap-1 mb-3">
                  {allMissing.map((cat) => (
                    <li key={cat} className="flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                      {cat}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-2">
                  <a
                    href="/templates"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 transition"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    Upload template
                  </a>
                  <button
                    onClick={() => loadTemplates(true)}
                    disabled={refreshing}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-xs font-medium hover:bg-amber-200 dark:hover:bg-amber-900/60 transition disabled:opacity-50"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
                    {refreshing ? "Refreshing…" : "Refresh templates"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
        {usesCategoryZip ? (
          <>
            <div className="rounded-2xl p-4 bg-green-50/70 dark:bg-green-950/20">
              <p className="text-2xl font-bold text-green-700 dark:text-green-400">{categories.length}</p>
              <p className="text-sm text-muted-foreground">Categories → files</p>
            </div>
            <div className="rounded-2xl p-4 bg-muted/30">
              <p className="text-2xl font-bold">{exportableCount}</p>
              <p className="text-sm text-muted-foreground">Products to export</p>
            </div>
            <div className="rounded-2xl p-4 bg-muted/30">
              <div className="flex items-center justify-between">
                <p className="text-2xl font-bold">{templates.length}</p>
                <button
                  onClick={() => loadTemplates(true)}
                  disabled={refreshing}
                  title="Refresh templates"
                  className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-background/60 text-muted-foreground hover:bg-background transition disabled:opacity-50"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
                </button>
              </div>
              <p className="text-sm text-muted-foreground">Templates available</p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-2xl p-4 bg-green-50/70 dark:bg-green-950/20">
              <p className="text-2xl font-bold text-green-700 dark:text-green-400">{products.length}</p>
              <p className="text-sm text-muted-foreground">Products to export</p>
            </div>
            <div className="rounded-2xl p-4 bg-muted/30">
              <p className="text-2xl font-bold">{categories.length}</p>
              <p className="text-sm text-muted-foreground">Categories detected</p>
            </div>
            <div className="rounded-2xl p-4 bg-muted/30">
              <p className="text-2xl font-bold">{templates.length}</p>
              <p className="text-sm text-muted-foreground">Templates available</p>
            </div>
          </>
        )}
      </div>

      {/* Uncategorized warning banner */}
      {usesCategoryZip && !fetching && uncategorizedCount > 0 && (
        <div className="mb-4 rounded-2xl bg-orange-50/70 dark:bg-orange-950/20 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-orange-800">
                {uncategorizedCount} product{uncategorizedCount !== 1 ? "s" : ""} {hasTemplates ? "will be added to the default template" : "will be excluded from the export"}
              </p>
              <p className="text-xs text-orange-700 mt-1">
                {hasTemplates
                  ? `These products were marked "Uncategorized" and will be placed in the first available template. ${exportableCount} categorized product${exportableCount !== 1 ? "s" : ""} will be matched to their specific templates.`
                  : `These products were marked "Uncategorized" and don't match any available category. Only ${exportableCount} product${exportableCount !== 1 ? "s" : ""} will be included in the ZIP.`}
              </p>
            </div>
          </div>
        </div>
      )}

      {fetching && (
        <div className="flex items-center justify-center py-16">
          <LottieLoader size={64} />
        </div>
      )}

      {!fetching && (
        <div className="space-y-4">

          {/* ── CATEGORY-SPLIT (Mathis / Temu / Best Buy) ── */}
          {usesCategoryZip && isMathis && !hasTemplates && (
            <div className="flex flex-col items-center justify-center py-12 text-center bg-muted/30 rounded-2xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload an Excel template for {marketplace}. Its columns will be used for all exported files.
              </p>
            </div>
          )}

          {usesCategoryZip && !isMathis && !hasTemplates && categories.length > 0 && (
            <div className="mb-4 rounded-2xl bg-blue-50/70 dark:bg-blue-950/20 p-4">
              <div className="flex items-start gap-3">
                <FileSpreadsheet className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-blue-800">No templates — using flat column export</p>
                  <p className="text-xs text-blue-700 mt-1">
                    Upload templates per category in the Templates section to use custom column layouts. Without templates, the export uses standard columns.
                  </p>
                </div>
              </div>
            </div>
          )}

          {usesCategoryZip && categories.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center bg-muted/30 rounded-2xl">
              <Package className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No categorized products</p>
              <p className="text-xs text-muted-foreground">Run the Categorize step first before exporting.</p>
            </div>
          )}

          {usesCategoryZip && categories.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-2">Files that will be created</h3>
              <div className="rounded-2xl bg-muted/20 divide-y divide-border/40 overflow-hidden">
                {categories.map(([category, count]) => {
                  const matched = hasTemplates ? matchTemplate(category, templates) : null;
                  return (
                    <div key={category} className="flex items-center gap-3 px-4 py-2.5">
                      <FileSpreadsheet className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm flex-1 truncate">{category}</span>
                      {matched && (
                        <span className="flex items-center gap-1 text-xs text-blue-600 font-medium shrink-0">
                          <Shuffle className="w-3 h-3" />
                          {matched.name}
                          {matched.userId === null && (
                            <span className="text-xs bg-purple-100 text-purple-700 px-1 py-0.5 rounded font-medium ml-1">Admin</span>
                          )}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">
                        {count} product{count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── SINGLE-TEMPLATE MARKETPLACES ── */}
          {!usesCategoryZip && products.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center bg-muted/30 rounded-2xl">
              <Package className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No products to export</p>
              <p className="text-xs text-muted-foreground">Upload and verify products first.</p>
            </div>
          )}

          {!usesCategoryZip && products.length > 0 && !hasTemplates && (
            <div className="flex flex-col items-center justify-center py-12 text-center bg-muted/30 rounded-2xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload an Excel template for <span className="font-medium">{marketplace}</span>. Its columns will be used when exporting.
              </p>
            </div>
          )}

          {!usesCategoryZip && products.length > 0 && hasTemplates && (
            <div>
              <h3 className="text-sm font-medium mb-2">Choose export template</h3>
              <p className="text-xs text-muted-foreground mb-3">
                All {products.length} product{products.length !== 1 ? "s" : ""} will be exported into one file.
                {templates.some((t) => t.userId === null) && " Admin templates are available by default — no upload needed."}
              </p>
              <div className="rounded-2xl bg-muted/20 divide-y divide-border/40 overflow-hidden">
                {templates.map((t) => (
                  <label
                    key={t.id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 cursor-pointer transition hover:bg-muted/40",
                      selectedTemplateId === t.id && "bg-blue-50 border-blue-200"
                    )}
                  >
                    <input
                      type="radio"
                      name="template"
                      value={t.id}
                      checked={selectedTemplateId === t.id}
                      onChange={() => setSelectedTemplateId(t.id)}
                      className="accent-primary"
                    />
                    <FileSpreadsheet className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-sm flex-1 font-medium">{t.name}</span>
                    {t.userId === null && (
                      <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">Admin</span>
                    )}
                    {t.category && (
                      <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">{t.category}</span>
                    )}
                    <span className={cn(
                      "text-xs px-1.5 py-0.5 rounded font-medium",
                      t.fileFormat === "xlsx" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                    )}>
                      {t.fileFormat.toUpperCase()}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
