"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  FileSpreadsheet, ShieldCheck, Tag, Download,
  CheckCircle2, ChevronRight, ArrowLeft, Trash2,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ProductsTable } from "./products-table";
import { VerifyStep } from "./steps/verify-step";
import { CategorizeStep } from "./steps/categorize-step";
import { ExportStep } from "./steps/export-step";
import { SKIP_VERIFY_MARKETPLACES } from "@/lib/projects/marketplace-flow";
import { startPolling, sleepForPoll } from "@/lib/poll-scheduler";

type Product = {
  id: string;
  name: string;
  vendorSku: string | null;
  upc: string | null;
  asin: string | null;
  brand: string | null;
  price: number | null;
  imageUrl: string | null;
  verifyStatus: string | null;
  verifyFields: Record<string, unknown>[] | null;
  marketplaceCategory: string | null;
  categoryPath: string | null;
  categorizedAt: Date | null;
  verifiedAt: Date | null;
};

type Project = {
  id: string;
  name: string;
  marketplace: string;
  status: string;
  isNewListing?: boolean;
  verifyMs?: number | null;
  verifyCompletedAt?: string | null;
  categorizeMs?: number | null;
  categorizeCompletedAt?: string | null;
};

const STEPS = [
  { key: "uploaded",     label: "Upload",      icon: FileSpreadsheet, desc: "Vendor file imported" },
  { key: "verified",     label: "Verify",       icon: ShieldCheck, desc: "Check against marketplace" },
  { key: "categorized",  label: "Categorize",   icon: Tag,         desc: "AI category assignment" },
  { key: "done",         label: "Export",       icon: Download,    desc: "Generate & download ZIP" },
];

const AMAZON_SKIP_CATEGORIZE = true;
// These marketplaces have no public API for verification — skip straight to
// Categorize. Shared with the server so the two never drift.
const SKIP_VERIFY = SKIP_VERIFY_MARKETPLACES;


function stepIndex(status: string) {
  if (["verifying", "verified"].includes(status)) return 1;
  if (["categorizing", "categorized"].includes(status)) return 2;
  if (["exporting", "done"].includes(status)) return 3;
  return 0;
}

const MARKETPLACE_LABELS: Record<string, string> = {
  amazon_us: "Amazon US", amazon: "Amazon", bestbuy: "Best Buy", walmart: "Walmart",
  temu: "Temu", mathis: "Mathis", sears: "Sears", wayfair: "Wayfair",
};

const MARKETPLACE_DOMAIN: Record<string, string> = {
  amazon_us: "amazon.com", amazon: "amazon.com", bestbuy: "bestbuy.com", walmart: "walmart.com",
  temu: "temu.com", mathis: "mathishome.com", sears: "sears.com", wayfair: "wayfair.com",
};

function MarketplaceLogo({ marketplace, className }: { marketplace: string; className?: string }) {
  const domain = MARKETPLACE_DOMAIN[marketplace];
  if (!domain) return null;
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      className={cn("shrink-0 rounded-sm", className)}
    />
  );
}

export function ProjectDetail({ project: initial, products: initialProducts }: {
  project: Project;
  products: Product[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  // Skip Verify when the marketplace has no verification API, OR when this
  // specific project is a new listing (no live page to check against).
  const skipVerify = SKIP_VERIFY.has(initial.marketplace) || !!initial.isNewListing;
  const [project, setProject] = useState(initial);
  const [products, setProducts] = useState(initialProducts);
  const [activeStep, setActiveStep] = useState(() => {
    const idx = stepIndex(initial.status);
    // If this project skips verification and we land on the verify step, advance to categorize
    if (skipVerify && idx === 1) return 2;
    return idx;
  });
  const [loading, setLoading] = useState(false);
  // The step index currently executing, so the spinner shows on the step that
  // is actually running rather than one derived from the (stale during a run)
  // project status. null when idle.
  const [loadingStep, setLoadingStep] = useState<number | null>(null);
  // Cumulative progress across the multi-pass verify loop; null when idle.
  const [verifyProgress, setVerifyProgress] = useState<{ done: number; total: number } | null>(null);
  /** Latest server-reported categorization phase (e.g. "web-search rescue"). */
  const [categorizePhase, setCategorizePhase] = useState<string | null>(null);

  const currentStepIndex = stepIndex(project.status);

  async function refreshProject() {
    const res = await fetch(`/api/projects/${project.id}`);
    if (res.ok) {
      const data = await res.json();
      setProject(data.project);
      setProducts(data.products);
    }
  }

  // `force` re-checks every product (explicit "Re-verify"); the default resumes,
  // processing only products that have not been verified yet.
  //
  // A single request is capped by the route's `maxDuration`, so large catalogs
  // (500+) always come back partial. Rather than making the user click Verify
  // four or five times, we drive the resume loop here: keep POSTing while the
  // server reports work remaining, reporting cumulative progress as we go.
  /**
   * AI image/title adjudication runs on every verification pass by default.
   * `ai = false` can disable it explicitly (e.g. a quick re-fetch without model calls).
   */
  async function runVerify(force = false, ai = true) {
    setLoading(true);
    setLoadingStep(1);
    // Move to the Verify step up front so its loader shows there — not the
    // button spinner on whichever step the run was triggered from.
    setActiveStep(1);
    setVerifyProgress(null);

    // Results stream in while the run is still going: verification commits each
    // batch to the database, so we poll for finished products and render them
    // immediately rather than making the user stare at a spinner until the last
    // batch lands. A re-verify clears the previous results first, otherwise the
    // stale list would sit there looking like fresh progress.
    if (force) setProducts((prev) => prev.map((p) => ({ ...p, verifyStatus: null, verifyFields: null })));
    const stopPolling = startVerifyFeed(force);

    try {
      let totalVerified = 0;
      let totalSkipped = 0;
      // Only the first request carries `force`; the follow-up passes must resume
      // (force=1 would re-check the products we just finished, and never end).
      let useForce = force;

      // Bounds the loop so a server that stops making progress can't spin
      // forever. Each pass covers up to `maxDuration` of work, so this is far
      // more headroom than any real catalog needs.
      for (let pass = 0; pass < 25; pass++) {
        const qs = new URLSearchParams();
        if (useForce) qs.set("force", "1");
        if (ai) qs.set("ai", "1");
        const res = await fetch(
          `/api/projects/${project.id}/verify${qs.size ? `?${qs}` : ""}`,
          { method: "POST" },
        );
        const data = await res.json();
        useForce = false;

        if (!res.ok) {
          if (data.code === "INSUFFICIENT_KEEPA_TOKENS") {
            toast.warning(data.error ?? "Not enough Keepa tokens available to verify");
          } else if (data.resumable && (data.verified > 0 || totalVerified > 0)) {
            toast.warning(`Verification stopped after ${totalVerified + (data.verified ?? 0)} products — results so far are saved. Run Verify again to continue.`);
          } else {
            toast.error(data.error ?? "Verification failed");
          }
          await refreshProject();
          return;
        }

        totalVerified += data.verified ?? 0;
        totalSkipped += data.skipped ?? 0;

        if (data.remaining > 0) {
          setVerifyProgress({ done: totalVerified, total: totalVerified + data.remaining });
          // A pass that verified nothing but still reports work left would loop
          // without end — surface it and keep the partial results.
          if (!data.verified) {
            toast.warning(`Verified ${totalVerified} products — ${data.remaining} still to check. Run Verify again to continue.`);
            break;
          }
          continue;
        }

        if (totalSkipped > 0) {
          toast.warning(`Verified ${totalVerified} products. ${totalSkipped} skipped (Keepa tokens ran low — previous results preserved). Re-verify when tokens refill.`);
        } else {
          toast.success(`Verified ${totalVerified} products`);
        }
        break;
      }

      await refreshProject();
      setActiveStep(1);
    } catch (e) {
      console.error("Verify error:", e);
      toast.error("Verification failed — check the server console for details.");
    } finally {
      // Stop the feed before the final refresh so a late poll can't overwrite
      // the authoritative full payload with a partial page.
      stopPolling();
      setLoading(false);
      setLoadingStep(null);
      setVerifyProgress(null);
    }
  }

  /**
   * Poll the incremental verification feed and merge finished products into
   * state as they land.
   *
   * Returns a stop function. The feed walks a cursor so each product is fetched
   * exactly once; it never re-reads the whole catalog, which is what makes this
   * affordable to poll on a 10k project.
   */
  function startVerifyFeed(fromScratch: boolean): () => void {
    let cancelled = false;
    // On a forced re-verify the server clears the previous verdicts inside the
    // POST handler, but this feed's first poll is a much lighter query and
    // usually reaches the database first — it would read the previous run's
    // rows and merge them back into state, resurrecting the results the client
    // just cleared from the screen. Start the cursor past the newest existing
    // verdict so only rows written by THIS run (whose verifiedAt is always
    // newer) can come back, no matter which request lands first. "~" sorts
    // after every id character, so same-timestamp rows are excluded too.
    // A resume keeps the cursor at the start: rows verified by earlier passes
    // are legitimately part of what should be on screen.
    let cursor: string | null = null;
    if (fromScratch) {
      let newest: string | null = null;
      for (const p of products) {
        if (!p.verifiedAt) continue;
        const at = new Date(p.verifiedAt).toISOString();
        if (!newest || at > newest) newest = at;
      }
      if (newest) cursor = `${newest}|~`;
    }

    // Returns true when this poll produced new rows, so the scheduler can stay on
    // the fast cadence while data flows and ease off when the run goes quiet.
    const poll = async (): Promise<boolean> => {
      if (cancelled) return false;
      let sawData = false;
      // Drain everything currently available before sleeping, so a fast run
      // isn't rate-limited by the poll interval.
      for (;;) {
        if (cancelled) return sawData;
        const qs = new URLSearchParams({ limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`/api/projects/${project.id}/verify/progress?${qs}`);
        if (!res.ok) break;
        const data = await res.json();
        if (cancelled) return sawData;

        if (data.products?.length) {
          sawData = true;
          cursor = data.nextCursor ?? cursor;
          setProducts((prev) => {
            const byId = new Map(prev.map((p: Product) => [p.id, p]));
            for (const incoming of data.products as Product[]) {
              const existing = byId.get(incoming.id);
              // Merge rather than replace: the feed carries a subset of
              // columns, and clobbering would drop categorization fields.
              byId.set(incoming.id, existing ? { ...existing, ...incoming } : incoming);
            }
            // Preserve the original catalog order.
            return prev.map((p: Product) => byId.get(p.id) ?? p);
          });
        }

        if (data.verifiedTotal != null && data.total != null && data.verifiedTotal < data.total) {
          setVerifyProgress({ done: data.verifiedTotal, total: data.total });
        }

        // Caught up with what's committed so far — wait for more.
        if (data.exhausted) break;
      }
      return sawData;
    };

    // Visibility-aware, non-overlapping, backs off when idle — see poll-scheduler.
    const scheduler = startPolling({ poll });
    return () => { cancelled = true; scheduler.stop(); };
  }

  /**
   * Poll the incremental categorization feed and merge finished products into
   * state as they land — the categorize-step analogue of startVerifyFeed above.
   * Returns a stop function.
   */
  function startCategorizeFeed(): () => void {
    let cancelled = false;
    let cursor: string | null = null;

    // Returns true when this poll produced new rows, so the scheduler can stay on
    // the fast cadence while data flows and ease off when the run goes quiet.
    const poll = async (): Promise<boolean> => {
      if (cancelled) return false;
      let sawData = false;
      // Drain everything currently available before sleeping, so a fast run
      // isn't rate-limited by the poll interval.
      for (;;) {
        if (cancelled) return sawData;
        const qs = new URLSearchParams({ limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`/api/projects/${project.id}/categorize/progress?${qs}`);
        if (!res.ok) break;
        const data = await res.json();
        if (cancelled) return sawData;

        if (data.products?.length) {
          sawData = true;
          cursor = data.nextCursor ?? cursor;
          setProducts((prev) => {
            const byId = new Map(prev.map((p: Product) => [p.id, p]));
            for (const incoming of data.products as Product[]) {
              const existing = byId.get(incoming.id);
              // Merge rather than replace: the feed carries a subset of
              // columns, and clobbering would drop verification fields.
              byId.set(incoming.id, existing ? { ...existing, ...incoming } : incoming);
            }
            // Preserve the original catalog order.
            return prev.map((p: Product) => byId.get(p.id) ?? p);
          });
        }

        // Caught up with what's committed so far — wait for more.
        if (data.exhausted) break;
      }
      return sawData;
    };

    // Visibility-aware, non-overlapping, backs off when idle — see poll-scheduler.
    const scheduler = startPolling({ poll });
    return () => { cancelled = true; scheduler.stop(); };
  }

  async function runCategorize(force = false) {
    setLoading(true);
    setLoadingStep(2);
    // Move to the Categorize step up front so its loader shows there.
    setActiveStep(2);
    setCategorizePhase(null);
    // A re-categorize (force) clears the previous run's results first, otherwise the
    // stale list would sit there looking like fresh progress — matches runVerify.
    if (force) setProducts((prev) => prev.map((p) => ({ ...p, marketplaceCategory: null, categoryPath: null })));
    const stopPolling = startCategorizeFeed();
    try {
      // Categorization is a background job (large catalogs make dozens of model
      // round-trips and run well past the request timeout). POST returns a jobId
      // immediately; poll GET until done/error rather than holding one long request.
      const startRes = await fetch(`/api/projects/${project.id}/categorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      if (!startRes.ok) {
        const data = await startRes.json().catch(() => ({ error: "Categorization failed" }));
        toast.error(data.error ?? "Categorization failed");
        return;
      }
      const { jobId } = (await startRes.json()) as { jobId: string };

      // Give up only when the server stops making progress, not on a fixed clock —
      // a slow-but-alive run (thousands of products) must not be cut off.
      const STALL_LIMIT_MS = 5 * 60 * 1000;
      const HARD_LIMIT_MS = 30 * 60 * 1000;
      const startedAt = Date.now();
      let lastProgressAt = Date.now();
      let lastPhase = "";
      let lastUpdatedAt = 0;

      while (Date.now() - startedAt < HARD_LIMIT_MS) {
        // Polls every 2.5s while visible, 10s while hidden (wakes instantly on
        // return) — keeps the job-completion check alive without burning CPU or
        // requests while the user works elsewhere.
        await sleepForPoll(2500);

        const pollRes = await fetch(
          `/api/projects/${project.id}/categorize?jobId=${encodeURIComponent(jobId)}`,
        );
        const data = await pollRes.json().catch(() => ({ status: "error", error: "Categorization failed" })) as {
          status: string; error?: string; phase?: string; updatedAt?: number;
          matched?: number; unmatched?: number; categorized?: number;
        };

        if (!pollRes.ok || data.status === "error") {
          toast.error(data.error ?? "Categorization failed");
          return;
        }

        if (data.status === "done") {
          const matched = typeof data.matched === "number" ? data.matched : (data.categorized ?? 0);
          const unmatched = typeof data.unmatched === "number" ? data.unmatched : 0;
          if (matched === 0 && unmatched > 0) {
            toast.warning(`No category match for ${unmatched} product${unmatched === 1 ? "" : "s"}`);
          } else if (unmatched > 0) {
            toast.success(`Categorized ${matched} product${matched === 1 ? "" : "s"} (${unmatched} unmatched)`);
          } else {
            toast.success(`Categorized ${matched} product${matched === 1 ? "" : "s"}`);
          }
          await refreshProject();
          setActiveStep(2);
          return;
        }

        // Any forward progress resets the stall window: a changed phase string OR a
        // newer server-side updatedAt (the job store bumps it on every batch, so even
        // a repeated phase still counts as a live run).
        if (data.phase && data.phase !== lastPhase) {
          lastPhase = data.phase;
          lastProgressAt = Date.now();
          // Surface it: after the streaming writes land, every product has a
          // category row and the "N / total" counter saturates, but refinement
          // passes are still running. The phase is the only honest progress
          // signal left at that point.
          setCategorizePhase(data.phase);
        }
        if (typeof data.updatedAt === "number" && data.updatedAt > lastUpdatedAt) {
          lastUpdatedAt = data.updatedAt;
          lastProgressAt = Date.now();
        }
        if (Date.now() - lastProgressAt > STALL_LIMIT_MS) {
          toast.error("Categorization stalled — no progress from the server. Please try again.");
          return;
        }
      }

      toast.error("Categorization timed out — please try again");
    } catch (e) {
      console.error("Categorize error:", e);
      toast.error("Categorization failed — check the server console for details.");
    } finally {
      // Stop the feed before the final refresh so a late poll can't overwrite
      // the authoritative full payload with a partial page.
      stopPolling();
      setLoading(false);
      setLoadingStep(null);
      setCategorizePhase(null);
    }
  }

  async function handleApproveProduct(productId: string) {
    const res = await fetch(`/api/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifyStatus: "ok" }),
    });
    if (!res.ok) { toast.error("Failed to approve product"); return; }
    setProducts((prev) => prev.map((p) => p.id === productId ? { ...p, verifyStatus: "ok" } : p));
  }

  async function handleMarkDiscontinued(productId: string) {
    const res = await fetch(`/api/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifyStatus: "discontinued" }),
    });
    if (!res.ok) { toast.error("Failed to mark product as discontinued"); return; }
    setProducts((prev) => prev.map((p) => p.id === productId ? { ...p, verifyStatus: "discontinued" } : p));
  }

  async function handleReverifyProduct(productId: string) {
    const res = await fetch(`/api/projects/${project.id}/verify/product`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? "Failed to re-verify product");
      return;
    }
    const u = data.product as {
      id: string; asin: string | null; upc: string | null;
      verifyStatus: string | null; verifyFields: Record<string, unknown>[] | null;
      verifiedAt: string | null;
    };
    setProducts((prev) => prev.map((p) => p.id === productId
      ? {
          ...p,
          asin: u.asin,
          upc: u.upc,
          verifyStatus: u.verifyStatus,
          verifyFields: u.verifyFields,
          verifiedAt: u.verifiedAt ? new Date(u.verifiedAt) : p.verifiedAt,
        }
      : p));
    toast.success("Product re-verified");
  }

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete "${project.name}"?`,
      description: "This will permanently delete the project and all its products. This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Failed to delete project"); return; }
    toast.success(`"${project.name}" deleted`);
    router.push("/projects");
  }

  const verifiedCount     = products.filter((p) => p.verifyStatus === "ok").length;
  const exportCount       = products.filter((p) => p.verifyStatus === "ok" || p.verifyStatus === "warning").length;
  const warningCount      = products.filter((p) => p.verifyStatus === "warning").length;
  const mismatchCount     = products.filter((p) => p.verifyStatus === "mismatch").length;
  const notFoundCount     = products.filter((p) => p.verifyStatus === "not_found").length;
  const discontinuedCount = products.filter((p) => p.verifyStatus === "discontinued").length;
  const categorizedCount = products.filter((p) => p.marketplaceCategory).length;

  return (
    // The (app) layout insets <main> on the right (lg:pr-52) so content clears
    // The page scrolls on the window (the app shell uses min-h-screen, not a
    // fixed-height inner scroller), so we DON'T set overflow here — an inner
    // overflow context would break `position: sticky` on the header. bg-muted/30
    // tints the whole page; -mr-52 cancels the layout's right inset so the tint
    // fills edge-to-edge with no mismatched strip. Content stays centered via
    // its max-w-6xl columns, clear of the top-right pill.
    <div className="relative flex flex-col min-h-screen lg:-mr-52">
      {/* Full-bleed page tint. A fixed underlay (rather than a bg on this box)
          so the sidebar gutter on the left gets the same tint — the root only
          starts at the sidebar inset, which left a white seam beside it. */}
      <div aria-hidden className="fixed inset-0 -z-10 bg-muted/30" />
      {/* Header — sticky against the window scroll so it stays pinned at the top.
          The stepper and step content below scroll under it. The solid bg (page
          tint over the base background) keeps scrolling content from showing
          through the padding gaps around the header card. lg:pr-52 re-insets its
          content to match the other rows now that the root cancels the padding. */}
      <div className="sticky top-14 lg:top-0 z-20 pt-5 pb-2 shrink-0 lg:pr-52">
        {/* Opaque backdrop for the sticky band. On mobile it extends up over
            the 56px pill strip (-top-14) so scrolling content can't peek
            through between the floating pills and the header card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-14 bottom-0 bg-background lg:top-0"
        >
          <div className="absolute inset-0 bg-muted/30" />
        </div>
        <div className="relative mx-auto max-w-6xl px-4 sm:px-8">
          <div className="flex items-center gap-3 sm:gap-4 rounded-3xl bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] px-4 py-3 sm:px-5">
            <Link
              href="/projects"
              title="Back to projects"
              aria-label="Back to projects"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="w-4.5 h-4.5" />
            </Link>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-lg truncate">{project.name}</h1>
                <span className="flex items-center gap-1.5 text-muted-foreground text-sm shrink-0">
                  <MarketplaceLogo marketplace={project.marketplace} className="w-4 h-4" />
                  {MARKETPLACE_LABELS[project.marketplace]}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{products.length} products</p>
            </div>
            <button
              onClick={handleDelete}
              title="Delete project"
              className="ml-2 w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-red-50 hover:text-red-600 hover:border hover:border-red-200 transition-all"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Stepper — lg:pr-52 re-insets to match the header row now that the root
          cancels the layout's right padding. */}
      <div className="relative z-10 py-4 shrink-0 lg:pr-52">
        <div className="mx-auto max-w-6xl px-4 sm:px-8">
          <div className="flex items-center gap-0 overflow-x-auto rounded-3xl bg-muted/30 p-2 sm:p-3">
          {STEPS.map((step, idx) => {
            const Icon = step.icon;
            const isSkipVerifyStep = skipVerify && idx === 1;
            const isAmazonCategorize = AMAZON_SKIP_CATEGORIZE && project.marketplace === "amazon_us" && idx === 2;
            const isSkipped = isSkipVerifyStep || isAmazonCategorize;
            // For skip-verify marketplaces, step 2 (Categorize) is reachable once the project is uploaded
            const maxStep = skipVerify ? Math.max(currentStepIndex, 2) : currentStepIndex;
            // A step the project has reached is itself complete (e.g. status "uploaded"
            // means the Upload step finished), so it stays navigable and shows as done.
            const done = !isSkipped && maxStep >= idx;
            const active = activeStep === idx;
            // Spinner belongs on the step actually executing, not one inferred
            // from project status (which is stale on the client during a run).
            const isLoading = loading && loadingStep === idx;

            return (
              <div key={step.key} className="flex items-center flex-1 last:flex-none">
                <button
                  onClick={() => !isSkipped && idx <= maxStep && setActiveStep(idx)}
                  disabled={isSkipped || idx > maxStep}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-xl transition-all",
                    active ? "bg-primary/10" : "hover:bg-accent",
                    (isSkipped || idx > maxStep) && "opacity-40 cursor-not-allowed"
                  )}
                >
                  <div className={cn(
                    "relative w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors",
                    isSkipped ? "bg-muted text-muted-foreground" :
                    done ? "bg-primary text-primary-foreground" :
                    active ? "bg-primary text-primary-foreground" :
                    "bg-muted text-muted-foreground"
                  )}>
                    {/* Always show the step's own icon so each step stays
                        distinct; a small green check badge marks completion. */}
                    <Icon className="w-4 h-4" />
                    {done && (
                      <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                      </span>
                    )}
                  </div>
                  <div className="text-left hidden lg:block">
                    <p className={cn("text-xs font-semibold", active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground")}>
                      {step.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {isLoading && verifyProgress && step.key === "verified"
                        ? `${verifyProgress.done} / ${verifyProgress.total} checked` :
                       isSkipVerifyStep ? "Not required" :
                       isAmazonCategorize ? "Not required for Amazon" :
                       step.desc}
                    </p>
                  </div>
                </button>
                {idx < STEPS.length - 1 && (
                  <ChevronRight className="w-4 h-4 text-muted-foreground mx-1 shrink-0" />
                )}
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {/* Step content — wrapped in a section card so each step reads as one
          structured block rather than loose floating elements. The step
          components already supply their own inner p-4/sm:p-8 padding.
          Scrolls with the page (the root is the scroll container now).
          lg:pr-52 re-insets to match the header/stepper rows. */}
      <div className="relative z-10 pb-6 lg:pr-52">
        <div className="mx-auto max-w-6xl px-4 sm:px-8">
          <div className="rounded-3xl bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] overflow-hidden">
        {activeStep === 0 && (
          <ProductsTable
            products={products}
            onNext={() => setActiveStep(skipVerify ? 2 : 1)}
            onRunVerify={runVerify}
            loading={loading}
            projectStatus={project.status}
            skipVerify={skipVerify}
          />
        )}
        {activeStep === 1 && (
          <VerifyStep
            projectId={project.id}
            projectName={project.name}
            products={products}
            verifiedCount={verifiedCount}
            warningCount={warningCount}
            mismatchCount={mismatchCount}
            notFoundCount={notFoundCount}
            discontinuedCount={discontinuedCount}
            loading={loading}
            projectStatus={project.status}
            onRunVerify={runVerify}
            onApproveProduct={handleApproveProduct}
            onMarkDiscontinued={handleMarkDiscontinued}
            onReverifyProduct={handleReverifyProduct}
            marketplace={project.marketplace}
            elapsedMs={project.verifyMs ?? null}
            completedAt={project.verifyCompletedAt ?? null}
            verifyTotal={verifyProgress?.total ?? null}
            verifyDone={verifyProgress?.done ?? null}
            onNext={() => setActiveStep(project.marketplace === "amazon_us" ? 3 : 2)}
          />
        )}
        {activeStep === 2 && (
          <CategorizeStep
            projectId={project.id}
            projectName={project.name}
            products={products}
            categorizedCount={categorizedCount}
            loading={loading}
            projectStatus={project.status}
            marketplace={project.marketplace}
            elapsedMs={project.categorizeMs ?? null}
            completedAt={project.categorizeCompletedAt ?? null}
            phase={categorizePhase}
            onRunCategorize={runCategorize}
            onNext={() => setActiveStep(3)}
          />
        )}
        {activeStep === 3 && (
          <ExportStep
            projectId={project.id}
            projectName={project.name}
            marketplace={project.marketplace}
            products={products}
            verifiedCount={exportCount}
            projectStatus={project.status}
            isNewListing={!!project.isNewListing}
          />
        )}
          </div>
        </div>
      </div>
    </div>
  );
}
