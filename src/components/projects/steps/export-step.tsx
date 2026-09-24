"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Package, Plus, RefreshCw, Shuffle, Sparkles, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { exportGroupOf } from "@/lib/export/category-group";
import { buildDownloadName } from "@/lib/export/filename";
import { LottieLoader } from "@/components/ui/lottie-loader";
import { sleepForPoll } from "@/lib/poll-scheduler";

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

function matchTemplate(category: string, templates: Template[]): { template: Template; score: number } {
  if (templates.length === 1) return { template: templates[0], score: 1 };
  // Fold accents so "Décor" ↔ "Decor" before stripping to alphanumerics — this
  // MUST match the server's findBestTemplate (zip.ts) exactly, or this preview
  // will disagree with the actual export (e.g. falsely warn a category will be
  // excluded when the server matches it fine).
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();

  // Prefer a generic catch-all over first-in-array when no specific match exists
  const isGeneric = (t: Template) => /\bother(s)?\b|\bgeneral\b|\bdefault\b/i.test(t.name);
  const fallback = templates.find(isGeneric) ?? templates[0];

  const department = category.split(/\s*>\s*/)[0]?.trim() || category;
  const normDept = norm(department);
  const normCat = norm(category);
  // Deduplicate catWords so a word appearing multiple times in the path (e.g.
  // "office" in "Office > Office Furniture > Ergonomic Office Chairs") only
  // counts once — otherwise the repeated word inflates the score and causes
  // false matches to templates that merely share the department name.
  const catWords = [...new Set(normCat.split(" ").filter((w) => w.length > 2))];

  // Score one string against the product category — higher is better.
  const scoreTarget = (raw: string): number => {
    const target = norm(raw);
    const bareName = target.replace(/\s+\d+$/, "").trim();
    const targetWords = target.split(" ").filter((w) => w.length > 2);
    let sc = 0;
    if (target === normDept || bareName === normDept) sc += 20;
    // Give +12 prefix bonus only when the department is multi-word or long (≥ 9 chars).
    // A single short word like "office" or "audio" would match any template whose
    // name starts with that word — causing false matches. Require more specificity.
    else if (normDept.startsWith(target) || (target.startsWith(normDept) && (normDept.includes(" ") || normDept.length >= 9))) sc += 12;
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
  return { template: best, score: bestScore };
}

/**
 * Pick a template file for one category and name it.
 *
 * Written three times in this file before — once in the amber
 * missing-categories panel, once in the Best Buy coverage list, once in the
 * per-category file list — which meant three chances for the accepted file
 * types or the button states to drift apart. The tone differs because the
 * surrounding panel does; nothing else about it should.
 */
function TemplateUploadPanel({
  category,
  tone = "neutral",
  hint = "Click to pick .xlsx / .csv",
  file,
  name,
  uploading,
  onPickFile,
  onNameChange,
  onCancel,
  onSubmit,
}: {
  category: string;
  tone?: "neutral" | "amber";
  hint?: string;
  file: File | null;
  name: string;
  uploading: boolean;
  onPickFile: (f: File | null) => void;
  onNameChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const amber = tone === "amber";
  return (
    <div
      className={cn(
        "rounded-xl border bg-background p-3 flex flex-col gap-2",
        amber ? "border-amber-300 dark:border-amber-700" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium truncate">
          Template for &ldquo;{category}&rdquo;
        </span>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <label
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-4 cursor-pointer transition",
          amber
            ? "border-border hover:border-amber-400 hover:bg-amber-50/30 dark:hover:bg-amber-950/10"
            : "border-border hover:border-primary/60 hover:bg-muted/30",
          file && (amber ? "border-amber-500 bg-amber-50/20 dark:bg-amber-950/10" : "border-primary/50 bg-primary/5"),
        )}
      >
        <Upload className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{file ? file.name : hint}</span>
        <input
          type="file"
          accept=".xlsx,.xlsm,.csv,.tsv"
          className="sr-only"
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <input
        type="text"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Template name"
        className={cn(
          "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1",
          amber ? "focus:ring-amber-500" : "focus:ring-primary",
        )}
      />

      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-muted/40"
        >
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={!file || !name.trim() || uploading}
          className={cn(
            "text-xs px-3 py-1.5 rounded-lg font-medium text-white disabled:opacity-50",
            amber ? "bg-amber-600 hover:bg-amber-700" : "bg-primary text-primary-foreground",
          )}
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>
      </div>
    </div>
  );
}

export function ExportStep({ projectId, projectName, marketplace, products, projectStatus, isNewListing }: {
  projectId: string;
  projectName: string;
  marketplace: string;
  products: Product[];
  verifiedCount: number;
  projectStatus: string;
  isNewListing?: boolean;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [fetching, setFetching] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // For single-template marketplaces: user picks which template to export with
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  // Walmart mode auto-derives from the project's isNewListing flag set at creation.
  // New listing (checkbox checked) → per-category ZIP. Existing listing → item match.
  const [walmartMode, setWalmartMode] = useState<"new" | "existing">(isNewListing ? "new" : "existing");
  const [missingTemplateCategories, setMissingTemplateCategories] = useState<string[]>([]);
  /** Required columns the finished export shipped empty, biggest first. */
  const [unfilledRequired, setUnfilledRequired] = useState<{ label: string; rows: number }[]>([]);
  /**
   * Per-category Best Buy template coverage for THIS project, including
   * templates uploaded during earlier projects — the seller is only ever asked
   * for the workbooks that are genuinely still missing.
   */
  const [bbCategories, setBbCategories] = useState<
    { category: string; products: number; hasTemplate: boolean; templateName: string | null }[]
  >([]);
  const [bbCanGenerate, setBbCanGenerate] = useState(false);
  const [bbLoading, setBbLoading] = useState(false);
  /** True when the run could not reach the AI, so empty cells prove nothing. */
  const [unfilledAiDown, setUnfilledAiDown] = useState(false);
  const [uploadForCategory, setUploadForCategory] = useState<string | null>(null);
  /** Which list opened the upload panel — a category can appear in more than
   *  one, and keying only on the category opened every copy at once. */
  const [uploadSource, setUploadSource] = useState<"missing" | "coverage" | "files" | null>(null);
  /** Category whose Best Buy template is being built from Mirakl right now. */
  const [generatingCategory, setGeneratingCategory] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploading, setUploading] = useState(false);
  // Best Buy builds each category sheet from Mirakl's attribute set, so no
  // uploaded template is needed. Null until the capability check answers.
  const [bestBuyAutoTemplates, setBestBuyAutoTemplates] = useState<boolean | null>(null);
  const mountedRef = useRef(true);

  const isMathis = marketplace === "mathis";
  const isTemu = marketplace === "temu";
  const isBestBuy = marketplace === "bestbuy";
  const isWayfair = marketplace === "wayfair";
  const isWalmart = marketplace === "walmart";
  // Category-split marketplaces: one file per category, matched to template automatically.
  // Walmart in "new listings" mode splits per category; in "existing listings" mode
  // all products go into one file using the selected Item Match template.
  // Wayfair splits per class (one class-specific template workbook per file).
  const usesCategoryZip = isMathis || isTemu || isBestBuy || isWayfair || (isWalmart && walmartMode === "new");

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Best Buy builds each category's sheet from Mirakl's own required-attribute
  // set, so no template needs uploading. Ask the server whether that path is
  // actually available (credentials configured) — without this the screen
  // warns "no matching template" for categories the export will generate.
  useEffect(() => {
    if (!isBestBuy) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/bestbuy/status", { cache: "no-store" });
        const d = await r.json();
        if (!cancelled) setBestBuyAutoTemplates(!!d.autoTemplates);
      } catch {
        // Unreachable → assume no auto-templates, so the screen keeps telling
        // the truth (upload prompts) rather than promising generated sheets.
        if (!cancelled) setBestBuyAutoTemplates(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isBestBuy]);

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

  function openUploadPanel(category: string, source: "missing" | "coverage" | "files") {
    setUploadForCategory(category);
    setUploadSource(source);
    setUploadFile(null);
    setUploadName(category);
  }

  function closeUploadPanel() {
    setUploadForCategory(null);
    setUploadSource(null);
    setUploadFile(null);
    setUploadName("");
  }

  async function submitTemplateUpload() {
    if (!uploadFile || !uploadName.trim() || !uploadForCategory) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", uploadFile);
      form.append("name", uploadName.trim());
      form.append("marketplace", marketplace);
      form.append("category", uploadForCategory);
      const res = await fetch("/api/templates", { method: "POST", body: form });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Upload failed" })) as { error?: string };
        toast.error(error ?? "Upload failed");
        return;
      }
      toast.success(`Template "${uploadName.trim()}" added`);
      closeUploadPanel();
      await loadTemplates(true);
      if (isBestBuy) await loadBestBuyCoverage();
    } catch {
      toast.error("Upload failed — check your connection");
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  }

  /**
   * Which of this project's categories already have a Best Buy template.
   *
   * Reloaded after every upload and every generate, so the list reflects what
   * the next export will actually do rather than what was true on page load.
   */
  const loadBestBuyCoverage = useCallback(async () => {
    setBbLoading(true);
    try {
      const res = await fetch(`/api/bestbuy/template?projectId=${encodeURIComponent(projectId)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        categories?: typeof bbCategories;
        canGenerate?: boolean;
      };
      if (!mountedRef.current) return;
      setBbCategories(data.categories ?? []);
      setBbCanGenerate(!!data.canGenerate);
    } catch {
      /* the panel simply stays as it was */
    } finally {
      if (mountedRef.current) setBbLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (isBestBuy) void loadBestBuyCoverage();
  }, [isBestBuy, loadBestBuyCoverage]);

  /**
   * Build this Best Buy category's template from Mirakl and save it.
   *
   * Best Buy publishes no template FILE to upload — the portal generates one
   * per category from its attribute set, and there are 1,450 of them. Rather
   * than asking for a file that cannot be downloaded, rebuild the sheet from
   * the same attribute configuration the portal uses and store it as an
   * ordinary template, which the export then treats like any other.
   */
  async function generateBestBuyTemplate(category: string) {
    setGeneratingCategory(category);
    try {
      const res = await fetch("/api/bestbuy/template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        created?: boolean;
        name?: string;
        columnCount?: number;
        requiredCount?: number;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Could not build this category's template");
        return;
      }
      toast.success(
        data.created
          ? `${data.name} — ${data.columnCount} columns (${data.requiredCount} required)`
          : `A template for "${category}" already exists`,
      );
      await loadTemplates(true);
      await loadBestBuyCoverage();
    } catch {
      toast.error("Could not build this category's template — check your connection");
    } finally {
      if (mountedRef.current) setGeneratingCategory(null);
    }
  }

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

  // Which category groups will NOT get a usable template — worked out BEFORE
  // the export runs, so the fix is offered up front instead of after a full job.
  //
  //   Temu     — its templates carry a generic catch-all, so landing on that
  //              one means no specific template exists for this category.
  //   Best Buy — nothing is ever excluded, so this list stays empty for it.
  //              The export splits the catalogue: categories with an uploaded
  //              template are filled from it, the rest are built from Best
  //              Buy's own required attributes. The Category templates panel
  //              above reports that coverage instead. (This arm used to flag
  //              every weakly-matched category as excluded, which was true
  //              before the split existed and became a false alarm after —
  //              it reported "0 categories will be exported" for a run that
  //              exported all ten.)
  const isGenericTemplate = (t: Template) => /\bother(s)?\b|\bgeneral\b|\bdefault\b/i.test(t.name);
  const preExportMissingCategories: string[] =
    isTemu && templates.length > 1 && templates.some(isGenericTemplate)
      ? categories
          .map(([cat]) => cat)
          .filter((cat) => isGenericTemplate(matchTemplate(cat, templates).template))
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
      // Category-split (Mathis/Temu/BestBuy/Walmart-new): autoMatch=true
      // Walmart existing listings: templateIds=[selectedId] → all products in one file
      // Single-template with selection: pass templateIds=[selectedId]
      // Fallback: autoMatch=true → flat export
      const body = (isWalmart && walmartMode === "existing" && selectedTemplateId)
        ? { templateIds: [selectedTemplateId] }
        : usesCategoryZip
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
        const isHtml = text.trimStart().startsWith("<");
        if (isHtml) {
          msg = startRes.status === 502 || startRes.status === 503
            ? "Server is busy — export couldn't start. Please try again in a moment."
            : `Export failed (${startRes.status}) — please try again.`;
        } else {
          try { msg = (JSON.parse(text) as { error?: string }).error ?? (text.slice(0, 300) || msg); } catch { msg = text.slice(0, 300) || msg; }
        }
        toast.error(msg);
        return;
      }

      type StartResult = {
        jobId: string;
        mode?: "sliced" | "background";
        done?: boolean;
        remaining?: number;
        total?: number;
      };
      let start = (await startRes.json()) as StartResult;
      const { jobId } = start;
      setStatusMsg("Processing files…");

      // ── Resume loop ────────────────────────────────────────────────────
      //
      // An export that produces more than one file is built a group at a time,
      // because a whole catalogue does not fit in one serverless invocation.
      // Each request writes the files it managed and reports what is left; this
      // calls back until nothing is.
      //
      // Nothing already finished is redone: the files are stored server-side as
      // they are written, and values the AI resolved are persisted per product,
      // so a later pass reads them instead of paying for them again.
      if (start.mode === "sliced") {
        // Generous: a slice runs to the server's own budget, and the tail of a
        // large catalogue is the slowest part.
        const MAX_PASSES = 60;
        for (let pass = 0; pass < MAX_PASSES && !start.done; pass++) {
          const total = start.total ?? 0;
          const remaining = start.remaining ?? 0;
          setStatusMsg(
            total > 0
              ? `Building files — ${total - remaining} of ${total} done…`
              : "Building files…",
          );
          const nextRes = await fetch(
            `/api/projects/${projectId}/export?jobId=${encodeURIComponent(jobId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          if (!nextRes.ok) {
            // The invocation may have been cut short mid-slice. Whatever it
            // wrote is kept, so retrying continues rather than restarting —
            // but stop asking after a failure and let the user decide.
            const text = await nextRes.text().catch(() => "");
            let msg = "Export stopped part-way — press Export again to continue from where it left off.";
            try {
              msg = (JSON.parse(text) as { error?: string }).error ?? msg;
            } catch {
              /* keep the friendly message */
            }
            toast.error(msg);
            return;
          }
          start = (await nextRes.json()) as StartResult;
        }
        if (!start.done) {
          toast.error("Export is taking unusually long — press Export again to continue.");
          return;
        }
        setStatusMsg("Finishing…");
      }

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
      let lastUpdatedAt = 0;
      // Consecutive poll failures before giving up. A single 502 during a long
      // xlsx-generation pass (Render proxy timeout while event loop is busy) should
      // not abort an otherwise healthy export — the server keeps building and the
      // next poll usually succeeds. Only give up after 3 consecutive failures.
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 3;

      while (Date.now() - startedAt < HARD_LIMIT_MS) {
        // Polls every 2.5s while visible, 10s while hidden (wakes instantly on
        // return) — the export keeps building server-side either way.
        await sleepForPoll(2500);
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

          // Required columns that shipped empty, as "label:rows" pairs. Shown
          // right here so the gap is answered where it was discovered.
          const unfilledHeader = pollRes.headers.get("X-Unfilled-Required") ?? "";
          const unfilled = unfilledHeader
            .split(",")
            .filter(Boolean)
            .map((pair) => {
              const at = pair.lastIndexOf(":");
              return { label: decodeURIComponent(pair.slice(0, at)), rows: Number(pair.slice(at + 1)) || 0 };
            })
            .filter((c) => c.label);
          setUnfilledRequired(unfilled);
          setUnfilledAiDown(pollRes.headers.get("X-Unfilled-Ai-Down") === "1");

          if (isZip) {
            const fileCount = usesCategoryZip ? categories.length : 1;
            toast.success(`ZIP downloaded — ${fileCount} file${fileCount !== 1 ? "s" : ""}`);
          } else {
            toast.success(`Downloaded ${filename}`);
          }
          return;
        }

        if (!pollRes.ok) {
          consecutiveErrors++;
          // Transient 5xx (e.g. Render proxy timeout during a heavy xlsx pass)
          // should not abort the export — the server keeps running. Only give up
          // after several consecutive failures, which indicate a real server crash.
          if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) continue;
          const data = await pollRes.json().catch(() => ({ error: "Export failed" })) as { error?: string };
          toast.error(data.error ?? "Export failed");
          return;
        }
        consecutiveErrors = 0; // reset on any successful poll

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
        // The server also bumps updatedAt on every setJobPhase call, even when
        // the phase string is unchanged. Honouring it (as the categorize poller
        // does) means a long single-phase stretch — a slow DB load, one huge
        // batch — still reads as alive rather than stalled.
        if (typeof data.updatedAt === "number" && data.updatedAt > lastUpdatedAt) {
          lastUpdatedAt = data.updatedAt;
          lastProgressAt = Date.now();
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

      {/* No listing-type toggle — mode is set by the "New listing" checkbox at project creation */}

      {/* Walmart existing-listings: template picker (same as single-template marketplaces) */}
      {isWalmart && walmartMode === "existing" && (
        <div className="mb-6">
          {!hasTemplates ? (
            <div className="flex flex-col items-center justify-center py-10 text-center bg-muted/30 rounded-2xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload your Walmart <strong>item_match</strong> Excel template. Its columns will be used to export all products into one file.
              </p>
            </div>
          ) : (
            <div>
              <h3 className="text-sm font-medium mb-2">Choose Item Match template</h3>
              <p className="text-xs text-muted-foreground mb-3">All {products.length} products will be written into one file using this template.</p>
              <div className="rounded-2xl bg-muted/20 divide-y divide-border/40 overflow-hidden">
                {templates.map((t) => (
                  <label
                    key={t.id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 cursor-pointer transition hover:bg-muted/40",
                      selectedTemplateId === t.id && "bg-blue-50 dark:bg-blue-950/20 border-blue-200"
                    )}
                  >
                    <input
                      type="radio"
                      name="walmart-template"
                      value={t.id}
                      checked={selectedTemplateId === t.id}
                      onChange={() => setSelectedTemplateId(t.id)}
                      className="accent-primary"
                    />
                    <FileSpreadsheet className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-sm flex-1 font-medium">{t.name}</span>
                    {t.userId === null && (
                      <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300 px-1.5 py-0.5 rounded font-medium">Admin</span>
                    )}
                    {t.category && (
                      <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">{t.category}</span>
                    )}
                    <span className={cn(
                      "text-xs px-1.5 py-0.5 rounded font-medium",
                      t.fileFormat === "xlsx" ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300" : "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
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

      {/* Missing-template warning — shown before export so user knows what will be excluded */}
      {walmartMode !== "existing" && (() => {
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
                  {isBestBuy && bestBuyAutoTemplates === true
                    ? "Build each category's template from Best Buy's own required attributes, or upload your own file. Either way it is saved and reused by every later export."
                    : "Upload a dedicated template for each category below, then click Refresh to pick it up here (no page reload needed)."}
                </p>
                <ul className="flex flex-col gap-1.5 mb-3">
                  {allMissing.map((cat) => (
                    <li key={cat}>
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                        <span className="text-xs text-amber-800 dark:text-amber-300 flex-1">{cat}</span>
                        {/* Best Buy's templates are generated per category from
                            its own attribute set and cannot be downloaded, so
                            offer to build one rather than asking for a file. */}
                        {isBestBuy && bestBuyAutoTemplates === true && (
                          <button
                            onClick={() => generateBestBuyTemplate(cat)}
                            disabled={generatingCategory !== null}
                            className="flex items-center gap-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:underline shrink-0 disabled:opacity-50 disabled:no-underline"
                          >
                            <Sparkles className={cn("w-3 h-3", generatingCategory === cat && "animate-pulse")} />
                            {generatingCategory === cat ? "Building…" : "Build from Best Buy"}
                          </button>
                        )}
                        {uploadForCategory !== cat && (
                          <button
                            onClick={() => openUploadPanel(cat, "missing")}
                            className="flex items-center gap-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:underline shrink-0"
                          >
                            <Plus className="w-3 h-3" />
                            Add
                          </button>
                        )}
                      </div>
                      {uploadForCategory === cat && uploadSource === "missing" && (
                        <TemplateUploadPanel
                          category={cat}
                          tone="amber"
                          file={uploadFile}
                          name={uploadName}
                          uploading={uploading}
                          onPickFile={(f) => { setUploadFile(f); if (f && uploadName === uploadForCategory) setUploadName(f.name.replace(/\.[^.]+$/, "")); }}
                          onNameChange={setUploadName}
                          onCancel={closeUploadPanel}
                          onSubmit={submitTemplateUpload}
                        />
                      )}
                    </li>
                  ))}
                </ul>
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
        );
      })()}

      {/* ── Required columns the finished export shipped empty ──────────────
          Found during the run, answered here. These are the cells no catalog
          lookup can fill and the model is forbidden from filling — compliance
          declarations the seller makes. Mercato finds the gap and remembers the
          answer; it never invents one. Saved once, every future export for this
          marketplace fills the column deterministically at no token cost. */}
      {unfilledRequired.length > 0 && (
        <div className="mb-5 rounded-2xl bg-blue-50 dark:bg-blue-950/25 p-4">
          <div className="flex items-start gap-3">
            <FileSpreadsheet className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">
                {unfilledRequired.length} required column
                {unfilledRequired.length === 1 ? "" : "s"} shipped empty
              </p>
              <p className="text-xs text-blue-800/80 dark:text-blue-300/80 mt-0.5 mb-3">
                {unfilledAiDown
                  ? "The AI had no credit during this run, so the columns it normally fills were never attempted. Top up and export again."
                  : "Nothing in this project's data answered these columns, so they shipped empty. They are defined by the category's own template."}
              </p>

              <ul className="flex flex-col gap-2">
                {unfilledRequired.map(({ label, rows }) => {
                  return (
                    <li
                      key={label}
                      className="rounded-xl border border-blue-200 dark:border-blue-900 bg-background px-3 py-2.5"
                    >
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-xs font-medium">{label}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {rows} row{rows === 1 ? "" : "s"} affected
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ── Best Buy: one template per category, built up across projects ──────
          Best Buy publishes no bulk download — a seller fetches one category's
          workbook at a time from the portal — so coverage accumulates run by
          run. Templates are shared across projects, so a category answered once
          is never asked for again. */}
      {isBestBuy && bbCategories.length > 0 && (() => {
        const ready = bbCategories.filter((c) => c.hasTemplate);
        const missing = bbCategories.filter((c) => !c.hasTemplate);
        return (
          <div className="mb-5 rounded-2xl border border-border p-4">
            <div className="flex items-start gap-3">
              <FileSpreadsheet className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <p className="text-sm font-semibold">Category templates</p>
                  <p className="text-xs text-muted-foreground">
                    {ready.length} of {bbCategories.length} ready
                  </p>
                  <button
                    onClick={() => loadBestBuyCoverage()}
                    disabled={bbLoading}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw className={cn("w-3 h-3", bbLoading && "animate-spin")} />
                    Refresh
                  </button>
                </div>

                <p className="text-xs text-muted-foreground mt-1 mb-3">
                  {missing.length === 0
                    ? "Every category in this project has a template. Re-run the export to fill them with this project's rows."
                    : `Upload Best Buy's own spreadsheet for the ${missing.length} categor${missing.length === 1 ? "y" : "ies"} below. The rest already have one from an earlier project and are not asked for again. A category with no template still exports — as a sheet built from Best Buy's required attributes.`}
                </p>

                <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${(ready.length / bbCategories.length) * 100}%` }}
                  />
                </div>

                <ul className="flex flex-col divide-y divide-border/60">
                  {[...missing, ...ready].map(({ category, products, hasTemplate, templateName }) => (
                    <li key={category} className="py-2">
                      <div className="flex items-center gap-2">
                        {hasTemplate ? (
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-xs" title={category}>
                          {category}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {products} product{products === 1 ? "" : "s"}
                        </span>
                        {hasTemplate ? (
                          <span
                            className="hidden sm:inline max-w-[180px] truncate shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400"
                            title={templateName ?? ""}
                          >
                            {templateName}
                          </span>
                        ) : (
                          <span className="flex shrink-0 items-center gap-2">
                            {bbCanGenerate && (
                              <button
                                onClick={() => generateBestBuyTemplate(category)}
                                disabled={generatingCategory !== null}
                                className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
                                title="Rebuild this category's sheet from Best Buy's own required attributes"
                              >
                                <Sparkles
                                  className={cn("w-3 h-3", generatingCategory === category && "animate-pulse")}
                                />
                                {generatingCategory === category ? "Building…" : "Build"}
                              </button>
                            )}
                            {uploadForCategory !== category && (
                              <button
                                onClick={() => openUploadPanel(category, "coverage")}
                                className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary hover:underline"
                              >
                                <Plus className="w-3 h-3" />
                                Upload
                              </button>
                            )}
                          </span>
                        )}
                      </div>

                      {uploadForCategory === category && uploadSource === "coverage" && (
                        <TemplateUploadPanel
                          category={category}
                          tone="neutral"
                          hint="Click to pick the .xlsx from Best Buy"
                          file={uploadFile}
                          name={uploadName}
                          uploading={uploading}
                          onPickFile={(f) => { setUploadFile(f); if (f && uploadName === uploadForCategory) setUploadName(f.name.replace(/\.[^.]+$/, "")); }}
                          onNameChange={setUploadName}
                          onCancel={closeUploadPanel}
                          onSubmit={submitTemplateUpload}
                        />
                      )}
                    </li>
                  ))}
                </ul>

                {ready.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      onClick={handleExport}
                      disabled={!canExport}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                    >
                      <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
                      {loading ? "Running…" : "Re-run export"}
                    </button>
                    <span className="text-[11px] text-muted-foreground">
                      {`Fills the ${ready.length} uploaded template${ready.length === 1 ? "" : "s"} with this project's rows.`}
                    </span>
                  </div>
                )}
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
              <p className="text-2xl font-bold text-green-700 dark:text-green-400">{categories.length - preExportMissingCategories.length}</p>
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
                {uncategorizedCount} product{uncategorizedCount !== 1 ? "s" : ""} {hasTemplates ? "will be exported to a separate Uncategorized.csv" : "will be excluded from the export"}
              </p>
              <p className="text-xs text-orange-700 mt-1">
                {hasTemplates
                  ? `These products were marked "Uncategorized" and will go into their own Uncategorized.csv for review — they are not placed into any template file. ${exportableCount} categorized product${exportableCount !== 1 ? "s" : ""} will be matched to their specific templates.`
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

          {usesCategoryZip && categories.length > 0 && (() => {
            const rows = categories
              .filter(([category]) => !preExportMissingCategories.includes(category))
              .map(([category, count]) => {
                // Best Buy answers this exactly: a template declares the one
                // category it serves, so coverage is a lookup rather than a
                // guess. Everything else still scores a fuzzy name match, where
                // < 4 means only a generic word overlapped ("office") and is
                // not a real match.
                const bbEntry = isBestBuy
                  ? bbCategories.find((c) => c.category === category)
                  : undefined;

                // A category with no uploaded template still exports: the run
                // builds its sheet from Best Buy's own required attributes.
                const autoGenerated =
                  isBestBuy && bestBuyAutoTemplates === true && !bbEntry?.hasTemplate;

                if (isBestBuy) {
                  return {
                    category,
                    count,
                    matched: bbEntry?.hasTemplate
                      ? ({ name: bbEntry.templateName ?? "Uploaded template", userId: "" } as Template)
                      : null,
                    hasGoodMatch: !!bbEntry?.hasTemplate || autoGenerated,
                    autoGenerated,
                  };
                }

                const matchResult = hasTemplates ? matchTemplate(category, templates) : null;
                return {
                  category,
                  count,
                  matched: matchResult?.template ?? null,
                  hasGoodMatch: (matchResult?.score ?? 0) >= 4,
                  autoGenerated: false,
                };
              });
            const noMatchCount = rows.filter(r => !r.autoGenerated && hasTemplates && !r.hasGoodMatch).length;
            return (
              <div>
                <h3 className="text-sm font-medium mb-2">Files that will be created</h3>
                {noMatchCount > 0 && (
                  <div className="mb-3 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-3 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                      <span className="font-semibold">{noMatchCount} categor{noMatchCount === 1 ? "y has" : "ies have"} no matching template.</span>{" "}
                      Click <span className="font-semibold">+ Add</span> next to a category to upload its template directly, or go to the Templates section.
                    </p>
                  </div>
                )}
                <div className="rounded-2xl bg-muted/20 divide-y divide-border/40 overflow-hidden">
                  {rows.map(({ category, count, matched, hasGoodMatch, autoGenerated }) => (
                    <div key={category}>
                      <div className="flex items-center gap-3 px-4 py-2.5">
                        <FileSpreadsheet className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="text-sm flex-1 truncate">{category}</span>
                        {autoGenerated && (
                          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium shrink-0" title="Built from Best Buy’s own required attributes for this category">
                            <FileSpreadsheet className="w-3 h-3" />
                            Best Buy template
                          </span>
                        )}
                        {!autoGenerated && hasTemplates && matched && hasGoodMatch && (
                          <span className="flex items-center gap-1 text-xs text-blue-600 font-medium shrink-0">
                            <Shuffle className="w-3 h-3" />
                            {matched.name}
                            {matched.userId === null && (
                              <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300 px-1 py-0.5 rounded font-medium ml-1">Admin</span>
                            )}
                          </span>
                        )}
                        {hasTemplates && !hasGoodMatch && (
                          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 font-medium shrink-0">
                            <AlertTriangle className="w-3 h-3" />
                            No template
                          </span>
                        )}
                        {!autoGenerated && hasTemplates && !hasGoodMatch && uploadForCategory !== category && (
                          <button
                            onClick={() => openUploadPanel(category, "files")}
                            className="flex items-center gap-1 text-xs text-primary font-medium shrink-0 hover:underline"
                          >
                            <Plus className="w-3 h-3" />
                            Add
                          </button>
                        )}
                        <span className="text-xs text-muted-foreground shrink-0">
                          {count} product{count !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {uploadForCategory === category && uploadSource === "files" && (
                        <TemplateUploadPanel
                          category={category}
                          tone="neutral"
                          file={uploadFile}
                          name={uploadName}
                          uploading={uploading}
                          onPickFile={(f) => { setUploadFile(f); if (f && uploadName === uploadForCategory) setUploadName(f.name.replace(/\.[^.]+$/, "")); }}
                          onNameChange={setUploadName}
                          onCancel={closeUploadPanel}
                          onSubmit={submitTemplateUpload}
                        />
                      )}
                    </div>
                  ))}
                  {hasTemplates && uncategorizedCount > 0 && (
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <FileSpreadsheet className="w-4 h-4 text-orange-500 shrink-0" />
                      <span className="text-sm flex-1 truncate">Uncategorized.csv</span>
                      <span className="flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400 font-medium shrink-0">
                        <AlertTriangle className="w-3 h-3" />
                        Needs review — no template
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {uncategorizedCount} product{uncategorizedCount !== 1 ? "s" : ""}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ── SINGLE-TEMPLATE MARKETPLACES ── (hidden for Walmart existing-listings — has its own picker above) */}
          {!usesCategoryZip && !(isWalmart && walmartMode === "existing") && products.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center bg-muted/30 rounded-2xl">
              <Package className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No products to export</p>
              <p className="text-xs text-muted-foreground">Upload and verify products first.</p>
            </div>
          )}

          {!usesCategoryZip && !(isWalmart && walmartMode === "existing") && products.length > 0 && !hasTemplates && (
            <div className="flex flex-col items-center justify-center py-12 text-center bg-muted/30 rounded-2xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload an Excel template for <span className="font-medium">{marketplace}</span>. Its columns will be used when exporting.
              </p>
            </div>
          )}

          {!usesCategoryZip && !(isWalmart && walmartMode === "existing") && products.length > 0 && hasTemplates && (
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
                      selectedTemplateId === t.id && "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900"
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
                      <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300 px-1.5 py-0.5 rounded font-medium">Admin</span>
                    )}
                    {t.category && (
                      <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">{t.category}</span>
                    )}
                    <span className={cn(
                      "text-xs px-1.5 py-0.5 rounded font-medium",
                      t.fileFormat === "xlsx" ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300" : "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
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
