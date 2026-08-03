"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, FileSpreadsheet, X, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LottieLoader } from "@/components/ui/lottie-loader";

// Top-level tiles; Amazon expands to a US/International sub-toggle
const MARKETPLACE_TILES = [
  { id: "amazon", label: "Amazon", domain: "amazon.com" },
  { id: "walmart", label: "Walmart", domain: "walmart.com" },
  { id: "bestbuy", label: "Best Buy", domain: "bestbuy.com" },
  { id: "temu", label: "Temu", domain: "temu.com" },
  { id: "mathis", label: "Mathis", domain: "mathishome.com" },
  { id: "sears", label: "Sears", domain: "sears.com" },
  // { id: "wayfair", label: "Wayfair", domain: "wayfair.com" },
] as const;

function MarketplaceLogo({ domain, className }: { domain: string; className?: string }) {
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      className={cn("shrink-0 rounded-sm", className)}
    />
  );
}

const AMAZON_VARIANTS = [
  { id: "amazon_us", label: "US" },
  { id: "amazon", label: "International" },
] as const;

export function NewProjectForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [amazonGroup, setAmazonGroup] = useState(false); // true when Amazon tile is selected
  const [isNewListing, setIsNewListing] = useState(false); // Walmart only: skip verification
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);

  function handleFile(f: File) {
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (!["csv", "xlsx", "xls"].includes(ext ?? "")) {
      toast.error("Only CSV or Excel files are supported");
      return;
    }
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { toast.error("Please upload a vendor file"); return; }
    if (!marketplace) { toast.error("Please select a marketplace"); return; }
    if (!name.trim()) { toast.error("Please enter a project name"); return; }

    setLoading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("name", name.trim());
    form.append("marketplace", marketplace);
    // Only sent (and only honoured server-side) for Walmart.
    if (marketplace === "walmart" && isNewListing) form.append("isNewListing", "true");

    try {
      const res = await fetch("/api/projects", { method: "POST", body: form });
      // A dropped server connection mid-upload returns an empty/invalid body — parse
      // defensively so the form reports the failure instead of crashing on res.json().
      const data = await res.json().catch(() => ({} as { error?: string; count?: number; id?: string }));

      if (!res.ok) {
        toast.error(data.error ?? "Upload failed — the server did not return a valid response. Please try again.");
      } else {
        toast.success(`Project created — ${data.count} products imported`);
        router.push(`/projects/${data.id}`);
      }
    } catch {
      toast.error("Upload failed — could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Project name */}
      <div>
        <label className="block text-sm font-medium mb-1.5">Project name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Summer Vendor List 2026"
          className="w-full h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring transition"
        />
      </div>

      {/* File upload */}
      <div>
        <label className="block text-sm font-medium mb-1.5">Vendor file</label>
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-accent/50",
            file && "border-green-500 bg-green-50"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          {file ? (
            <>
              <CheckCircle2 className="w-8 h-8 text-green-600" />
              <div className="text-center">
                <p className="text-sm font-medium text-green-700">{file.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {(file.size / 1024).toFixed(0)} KB
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setFile(null); }}
                className="absolute top-3 right-3 text-muted-foreground hover:text-destructive transition"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center">
                <FileSpreadsheet className="w-6 h-6 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Drop your file here or <span className="text-primary underline">browse</span></p>
                <p className="text-xs text-muted-foreground mt-1">CSV, XLSX or XLS · Max 50MB</p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Marketplace */}
      <div>
        <label className="block text-sm font-medium mb-2">Marketplace</label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {MARKETPLACE_TILES.map((m) => {
            const isAmazon = m.id === "amazon";
            const isActive = isAmazon ? amazonGroup : marketplace === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  if (isAmazon) {
                    setAmazonGroup(true);
                    if (!marketplace.startsWith("amazon")) setMarketplace("amazon_us");
                  } else {
                    setAmazonGroup(false);
                    setMarketplace(m.id);
                  }
                }}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-all text-sm",
                  isActive
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:border-primary/40 hover:bg-accent"
                )}
              >
                <MarketplaceLogo domain={m.domain} className="w-5 h-5" />
                <p className="font-medium">{m.label}</p>
              </button>
            );
          })}
        </div>

        {/* Amazon sub-variant toggle */}
        {amazonGroup && (
          <div className="mt-2 flex items-center gap-2 p-3 rounded-xl border bg-muted/40">
            <span className="text-xs text-muted-foreground mr-1">Region:</span>
            {AMAZON_VARIANTS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setMarketplace(v.id)}
                className={cn(
                  "px-3 py-1 rounded-lg text-xs font-medium transition-all border",
                  marketplace === v.id
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:border-primary/40 hover:bg-accent"
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* New-listing option — Walmart only. Skips the Verify step, which has no
          live marketplace page to check a brand-new listing against. */}
      {marketplace === "walmart" && (
        <label className="flex items-start gap-3 p-3 rounded-xl border cursor-pointer hover:bg-accent transition-colors">
          <input
            type="checkbox"
            checked={isNewListing}
            onChange={(e) => setIsNewListing(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
          />
          <span className="text-sm">
            <span className="font-medium">New listing</span>
            <span className="block text-xs text-muted-foreground">
              These products aren&apos;t live on Walmart yet — skip verification and go straight to categorization.
            </span>
          </span>
        </label>
      )}

      <button
        type="submit"
        disabled={loading || !file || !marketplace}
        className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 transition disabled:opacity-50"
      >
        {loading ? <LottieLoader size={20} onDark className="-my-2" /> : <Upload className="w-4 h-4" />}
        {loading ? "Creating project…" : "Create project"}
      </button>
    </form>
  );
}
