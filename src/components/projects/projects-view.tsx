"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus, FolderOpen, Package, Clock, CheckCircle2, Loader2, Trash2,
  Search, ChevronLeft, ChevronRight, X, ChevronDown, Check, Square, CheckSquare,
  CalendarDays,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SKIP_VERIFY_MARKETPLACES } from "@/lib/projects/marketplace-flow";
import { toTileId } from "@/lib/marketplaces/catalog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { NewProjectModal } from "@/components/projects/new-project-modal";

const PAGE_SIZE = 12;

type Project = {
  id: string;
  name: string;
  marketplace: string;
  marketplaceLabel: string;
  status: string;
  productCount: number;
  createdAt: string;
  updatedAt: string;
};

type FilterOption = {
  value: string;
  label: string;
  logoDomain?: string;
};

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  uploaded:    { label: "Uploaded",    color: "bg-blue-100 text-blue-700",    icon: Clock },
  verifying:   { label: "Verifying",   color: "bg-yellow-100 text-yellow-700", icon: Loader2 },
  verified:    { label: "Verified",    color: "bg-green-100 text-green-700",   icon: CheckCircle2 },
  categorizing:{ label: "Categorizing",color: "bg-purple-100 text-purple-700", icon: Loader2 },
  categorized: { label: "Categorized", color: "bg-purple-100 text-purple-700", icon: CheckCircle2 },
  exporting:   { label: "Exporting",   color: "bg-orange-100 text-orange-700", icon: Loader2 },
  done:        { label: "Done",        color: "bg-emerald-100 text-emerald-700",icon: CheckCircle2 },
};

const STATUS_OPTIONS: FilterOption[] = Object.entries(STATUS_CONFIG).map(([value, { label }]) => ({ value, label }));

const MARKETPLACE_DOMAIN: Record<string, string> = {
  amazon: "amazon.com",
  amazon_us: "amazon.com",
  bestbuy: "bestbuy.com",
  walmart: "walmart.com",
  temu: "temu.com",
  mathis: "mathishome.com",
  sears: "sears.com",
  wayfair: "wayfair.com",
};

const MARKETPLACE_LABELS: Record<string, string> = {
  amazon: "Amazon",
  amazon_us: "Amazon US",
  bestbuy: "Best Buy",
  walmart: "Walmart",
  temu: "Temu",
  mathis: "Mathis",
  sears: "Sears",
  wayfair: "Wayfair",
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

const PROGRESS: Record<string, number> = {
  uploaded: 14, verifying: 28, verified: 42,
  categorizing: 57, categorized: 71, exporting: 85, done: 100,
};

const fieldClass =
  "h-9 rounded-full border border-border bg-background px-3 text-sm text-foreground transition " +
  "hover:border-foreground/20 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40";

function useDismissible(open: boolean, onClose: () => void, rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, rootRef]);
}

function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  placeholder: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  useDismissible(open, () => setOpen(false), rootRef);

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          fieldClass,
          "w-full inline-flex items-center gap-2 text-left",
          open && "ring-2 ring-primary/20 border-primary/40",
          !selected && "text-muted-foreground"
        )}
      >
        {selected?.logoDomain && <MarketplaceLogo marketplace={selected.value} className="w-4 h-4" />}
        <span className="flex-1 truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-30 mt-1.5 w-full min-w-44 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-lg"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onClick={() => { onChange(""); setOpen(false); }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-muted",
                !value && "bg-muted font-medium"
              )}
            >
              <span className="w-4 shrink-0 flex justify-center">
                {!value && <Check className="w-3.5 h-3.5" />}
              </span>
              <span className="truncate">{placeholder}</span>
            </button>
          </li>
          {options.map((o) => {
            const active = o.value === value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-muted",
                    active && "bg-muted font-medium"
                  )}
                >
                  <span className="w-4 shrink-0 flex justify-center">
                    {active && <Check className="w-3.5 h-3.5" />}
                  </span>
                  {o.logoDomain && <MarketplaceLogo marketplace={o.value} className="w-4 h-4" />}
                  <span className="truncate">{o.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Date range helpers ────────────────────────────────────────────────────────

type DatePreset = { label: string; days: number | null };

const DATE_PRESETS: DatePreset[] = [
  { label: "Today",          days: 0 },
  { label: "Last 7 days",    days: 7 },
  { label: "Last 30 days",   days: 30 },
  { label: "Last 3 months",  days: 90 },
  { label: "This year",      days: 365 },
  { label: "Custom range",   days: null },
];

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function presetRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { from: toDateStr(from), to: toDateStr(to) };
}

function formatDateLabel(from: string, to: string): string {
  const fmt = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
}

function DateRangeFilter({
  from,
  to,
  onChange,
  className,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissible(open, () => { setOpen(false); setShowCustom(false); }, rootRef);

  const hasValue = !!(from && to);

  const activePreset = !showCustom && hasValue
    ? DATE_PRESETS.find((p) => {
        if (p.days == null) return false;
        const r = presetRange(p.days);
        return r.from === from && r.to === to;
      }) ?? null
    : null;

  function applyPreset(p: DatePreset) {
    if (p.days == null) {
      setShowCustom(true);
      setCustomFrom(from || toDateStr(new Date()));
      setCustomTo(to || toDateStr(new Date()));
      return;
    }
    setShowCustom(false);
    const r = presetRange(p.days);
    onChange(r.from, r.to);
    setOpen(false);
  }

  function applyCustom() {
    if (customFrom && customTo) {
      const f = customFrom <= customTo ? customFrom : customTo;
      const t = customFrom <= customTo ? customTo : customFrom;
      onChange(f, t);
      setOpen(false);
      setShowCustom(false);
    }
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange("", "");
    setShowCustom(false);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          fieldClass,
          "inline-flex items-center gap-2 text-left",
          open && "ring-2 ring-primary/20 border-primary/40",
          !hasValue && "text-muted-foreground"
        )}
      >
        <CalendarDays className="w-4 h-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">
          {hasValue
            ? activePreset
              ? activePreset.label
              : formatDateLabel(from, to)
            : "Any date"}
        </span>
        {hasValue
          ? <span
              role="button"
              onClick={clear}
              className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition"
            >
              <X className="w-3 h-3" />
            </span>
          : <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        }
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-64 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
          {/* Preset list */}
          <div className="py-1">
            {DATE_PRESETS.map((p) => {
              const isActive = p.days == null ? showCustom : p === activePreset;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-muted",
                    isActive && "bg-muted font-medium"
                  )}
                >
                  <span className="w-4 shrink-0 flex justify-center">
                    {isActive && <Check className="w-3.5 h-3.5 text-primary" />}
                  </span>
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* Custom date inputs */}
          {showCustom && (
            <div className="border-t border-border px-3 py-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">From</label>
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className={cn(fieldClass, "w-full text-xs px-2")}
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">To</label>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className={cn(fieldClass, "w-full text-xs px-2")}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={applyCustom}
                disabled={!customFrom || !customTo}
                className="w-full h-8 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition disabled:opacity-40"
              >
                Apply range
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectsView({ projects: initial, allowedTiles }: { projects: Project[]; allowedTiles: string[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [projects, setProjects] = useState(initial);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [marketplaceFilter, setMarketplaceFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const marketplaceOptions = useMemo(() => {
    const allowed = new Set(allowedTiles);
    // Never hide a marketplace the user actually has projects in (e.g. Wayfair,
    // which isn't a grantable tile) — otherwise those projects become unfilterable.
    const owned = new Set(initial.map((p) => toTileId(p.marketplace)));
    return Object.entries(MARKETPLACE_LABELS)
      // Only marketplaces this user may use (admins get all tiles) or already owns.
      // Variants like amazon_us collapse to the "amazon" tile via toTileId.
      .filter(([value]) => allowed.has(toTileId(value)) || owned.has(toTileId(value)))
      .map(([value, label]) => ({
        value,
        label,
        logoDomain: MARKETPLACE_DOMAIN[value],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allowedTiles, initial]);

  const hasActiveFilters = !!(search || statusFilter || marketplaceFilter || dateFrom);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = dateFrom ? new Date(dateFrom + "T00:00:00").getTime() : null;
    const toTs   = dateTo   ? new Date(dateTo   + "T23:59:59").getTime() : null;
    return projects.filter((p) => {
      if (q) {
        const matchesSearch =
          p.name.toLowerCase().includes(q) ||
          p.marketplaceLabel.toLowerCase().includes(q) ||
          p.status.toLowerCase().includes(q);
        if (!matchesSearch) return false;
      }
      if (statusFilter && p.status !== statusFilter) return false;
      if (marketplaceFilter && p.marketplace !== marketplaceFilter) return false;
      if (fromTs !== null || toTs !== null) {
        const created = new Date(p.createdAt).getTime();
        if (fromTs !== null && created < fromTs) return false;
        if (toTs   !== null && created > toTs)   return false;
      }
      return true;
    });
  }, [projects, search, statusFilter, marketplaceFilter, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function resetPage() {
    setPage(1);
  }

  function getPageNumbers(current: number, total: number): (number | "ellipsis")[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = new Set<number>([1, 2, total - 1, total, current - 1, current, current + 1]);
    const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const result: (number | "ellipsis")[] = [];
    let prev = 0;
    for (const n of sorted) {
      if (prev && n - prev > 1) result.push("ellipsis");
      result.push(n);
      prev = n;
    }
    return result;
  }

  function clearFilters() {
    setSearch("");
    setStatusFilter("");
    setMarketplaceFilter("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  }

  function toggleSelect(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === paginated.length && paginated.every((p) => selected.has(p.id))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(paginated.map((p) => p.id)));
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: `Delete "${name}"?`,
      description: "This will permanently delete the project and all its products. This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) { toast.error("Failed to delete project"); return; }
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      toast.success(`"${name}" deleted`);
      router.refresh();
    } catch {
      toast.error("Failed to delete project");
    } finally {
      setDeleting(null);
    }
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    const count = ids.length;
    const ok = await confirm({
      title: `Delete ${count} project${count === 1 ? "" : "s"}?`,
      description: `This will permanently delete ${count === 1 ? "this project" : `all ${count} selected projects`} and their products. This cannot be undone.`,
      confirmLabel: `Delete ${count}`,
    });
    if (!ok) return;
    setBulkDeleting(true);
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) { toast.error("Failed to delete projects"); return; }
      setProjects((prev) => prev.filter((p) => !ids.includes(p.id)));
      setSelected(new Set());
      toast.success(`${count} project${count === 1 ? "" : "s"} deleted`);
      router.refresh();
    } catch {
      toast.error("Failed to delete projects");
    } finally {
      setBulkDeleting(false);
    }
  }

  const allPageSelected = paginated.length > 0 && paginated.every((p) => selected.has(p.id));

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      {/* Header — extra right padding on large screens clears the fixed pill */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {filtered.length} {filtered.length === 1 ? "project" : "projects"}
            {hasActiveFilters && ` (of ${projects.length})`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setNewProjectOpen(true)}
          className="inline-flex items-center gap-2 h-9 px-5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
        >
          <Plus className="w-4 h-4" />
          New project
        </button>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-border bg-muted/60 backdrop-blur-sm">
          <button
            type="button"
            onClick={toggleSelectAll}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition"
          >
            {allPageSelected
              ? <CheckSquare className="w-4 h-4 text-primary" />
              : <Square className="w-4 h-4" />}
            {allPageSelected ? "Deselect all" : "Select all on page"}
          </button>
          <span className="text-sm text-muted-foreground">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border text-sm text-muted-foreground hover:bg-background transition"
          >
            <X className="w-3.5 h-3.5" />
            Clear
          </button>
          <button
            type="button"
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition disabled:opacity-50"
          >
            {bulkDeleting
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Trash2 className="w-3.5 h-3.5" />}
            Delete {selected.size}
          </button>
        </div>
      )}


      {/* Search + filters — single row */}
      {projects.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {/* Match the first card's width: the card grid is 3 columns with a
              1rem gap at lg, so one column = (100% - 2rem)/3. Stays flexible
              below lg where the grid isn't 3-up. */}
          <div className="relative min-w-48 flex-1 basis-48 max-w-xs lg:w-[calc((100%-2rem)/3)] lg:max-w-none lg:flex-none lg:basis-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); resetPage(); }}
              placeholder="Search projects..."
              className={cn(fieldClass, "w-full pl-9 pr-3")}
            />
          </div>

          <FilterSelect
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); resetPage(); }}
            options={STATUS_OPTIONS}
            placeholder="All statuses"
            className="w-42"
          />

          <FilterSelect
            value={marketplaceFilter}
            onChange={(v) => { setMarketplaceFilter(v); resetPage(); }}
            options={marketplaceOptions}
            placeholder="All marketplaces"
            className="w-46"
          />

          <DateRangeFilter
            from={dateFrom}
            to={dateTo}
            onChange={(f, t) => { setDateFrom(f); setDateTo(t); resetPage(); }}
            className="w-44"
          />

          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasActiveFilters}
            className="ml-auto inline-flex items-center gap-1.5 h-9 px-4 rounded-full border border-border text-sm text-muted-foreground transition enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      )}

      {/* Empty state */}
      {projects.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <FolderOpen className="w-7 h-7 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold mb-1">No projects yet</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-xs">
            Upload a vendor file to start sourcing products across any marketplace.
          </p>
          <button
            type="button"
            onClick={() => setNewProjectOpen(true)}
            className="inline-flex items-center gap-2 h-9 px-5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
          >
            <Plus className="w-4 h-4" />
            Create your first project
          </button>
        </div>
      )}

      {/* No filter results */}
      {projects.length > 0 && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
          <p className="text-sm text-muted-foreground">
            No projects match the current filters
            {search ? ` for “${search}”` : ""}
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="text-sm font-medium text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Grid */}
      {paginated.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {paginated.map((p) => {
            // Skip-verify marketplaces (Temu, Best Buy, …) have no Verify step, so
            // "verified" is never a legitimate state for them — an old failed
            // categorization could have left it there. Show it as "uploaded"
            // instead of a misleading green "Verified" badge.
            const displayStatus =
              p.status === "verified" && SKIP_VERIFY_MARKETPLACES.has(p.marketplace.toLowerCase())
                ? "uploaded"
                : p.status;
            const status = STATUS_CONFIG[displayStatus] ?? { label: displayStatus, color: "bg-muted text-muted-foreground", icon: Clock };
            const StatusIcon = status.icon;
            const isDeleting = deleting === p.id;
            const isSelected = selected.has(p.id);

            return (
              <div key={p.id} className="relative group">
                {/* Hover-reveal checkbox — top-left corner */}
                <button
                  type="button"
                  onClick={(e) => toggleSelect(e, p.id)}
                  title={isSelected ? "Deselect" : "Select"}
                  className={cn(
                    "absolute top-3.5 left-3.5 z-10 w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-all duration-150 shadow-sm",
                    isSelected
                      ? "opacity-100 bg-primary border-primary text-white"
                      : "opacity-0 group-hover:opacity-100 bg-white border-gray-400 hover:border-primary"
                  )}
                >
                  {isSelected && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                </button>

                <Link
                  href={`/projects/${p.id}`}
                  className={cn(
                    "flex flex-col gap-4 p-5 rounded-2xl border bg-card transition-all duration-150",
                    "hover:shadow-md hover:border-primary/30",
                    isSelected && "border-primary/40 bg-primary/[0.02] shadow-sm"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 pl-5">
                      <p className="font-semibold text-sm truncate group-hover:text-primary transition-colors">
                        {p.name}
                      </p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                        <MarketplaceLogo marketplace={p.marketplace} className="w-3.5 h-3.5" />
                        {MARKETPLACE_LABELS[p.marketplace] ?? p.marketplaceLabel}
                      </p>
                    </div>
                    {/* Chip sits flush right; on card hover the delete button
                        expands from 0-width, pushing the chip smoothly left. */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={cn("inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full shrink-0", status.color)}>
                        <StatusIcon className={cn("w-3 h-3", ["verifying","categorizing","exporting"].includes(p.status) && "animate-spin")} />
                        {status.label}
                      </span>
                      <button
                        onClick={(e) => handleDelete(e, p.id, p.name)}
                        disabled={isDeleting}
                        title="Delete project"
                        aria-label="Delete project"
                        className={cn(
                          "shrink-0 flex items-center justify-center overflow-hidden rounded-lg text-gray-500",
                          "border border-gray-200 bg-white shadow-sm",
                          "hover:border-red-300 hover:bg-red-50 hover:text-red-600 hover:shadow-none",
                          "transition-[width,opacity,margin] duration-200 ease-out",
                          // Collapsed by default; expands on card hover. -ml-2
                          // cancels the flex gap so there's truly zero footprint
                          // when hidden.
                          "w-0 h-7 opacity-0 -ml-2 group-hover:w-7 group-hover:opacity-100 group-hover:ml-0",
                          "disabled:opacity-30"
                        )}
                      >
                        {isDeleting
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                          : <Trash2 className="w-3.5 h-3.5 shrink-0" />
                        }
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Package className="w-3.5 h-3.5" />
                      {p.productCount} products
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {new Date(p.updatedAt).toLocaleString("en-IN", {
                        year: "numeric",
                        month: "numeric",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        hour12: true,
                        timeZone: "Asia/Kolkata",
                      })}
                    </span>
                  </div>

                  <div className="w-full bg-muted rounded-full h-1">
                    <div
                      className="bg-primary h-1 rounded-full transition-all"
                      style={{ width: `${PROGRESS[displayStatus] ?? 0}%` }}
                    />
                  </div>
                </Link>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {filtered.length > PAGE_SIZE && (
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
          <p className="shrink-0 text-xs text-muted-foreground">
            Page {currentPage} of {totalPages}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="inline-flex items-center gap-1 h-8 px-2 sm:px-3 rounded-full border text-sm font-medium hover:bg-muted transition disabled:opacity-40 disabled:pointer-events-none"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Prev</span>
            </button>

            {getPageNumbers(currentPage, totalPages).map((n, i) =>
              n === "ellipsis" ? (
                <span key={`e-${i}`} className="px-1 text-sm text-muted-foreground">
                  …
                </span>
              ) : (
                <button
                  key={n}
                  onClick={() => setPage(n)}
                  aria-current={n === currentPage ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center justify-center h-8 min-w-8 px-2 rounded-full border text-sm font-medium transition",
                    n === currentPage
                      ? "bg-primary text-primary-foreground border-primary"
                      : "hover:bg-muted"
                  )}
                >
                  {n}
                </button>
              )
            )}

            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="inline-flex items-center gap-1 h-8 px-2 sm:px-3 rounded-full border text-sm font-medium hover:bg-muted transition disabled:opacity-40 disabled:pointer-events-none"
              aria-label="Next page"
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} allowedTiles={allowedTiles} />
    </div>
  );
}
