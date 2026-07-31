"use client";

import { useState, useRef, useCallback } from "react";
import { FileText, Plus, Trash2, X, ChevronDown, ChevronUp, Upload, FileSpreadsheet, Pencil, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";

type Template = {
  id: string;
  name: string;
  marketplace: string;
  category: string | null;
  fileFormat: string;
  columns: unknown;
  createdAt: Date | string;
  userId: string | null;
};

const MARKETPLACES = ["amazon_us", "amazon", "walmart", "bestbuy", "temu", "mathis", "sears"];

// Group keys can be a marketplace id or the fallback "other". Domains drive the
// favicon logos (same source used elsewhere in the app).
const MARKETPLACE_DOMAIN: Record<string, string> = {
  amazon_us: "amazon.com", amazon: "amazon.com", bestbuy: "bestbuy.com", walmart: "walmart.com",
  temu: "temu.com", mathis: "mathishome.com", sears: "sears.com",
};

function MarketplaceLogo({ marketplace, className }: { marketplace: string; className?: string }) {
  const domain = MARKETPLACE_DOMAIN[marketplace];
  if (!domain) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      className={cn("shrink-0 rounded-sm", className)}
    />
  );
}

type ColumnDef = { key: string; label: string };

function parseColumns(raw: unknown): ColumnDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => (typeof c === "object" && c !== null && "key" in c && "label" in c
    ? { key: String((c as { key: unknown }).key), label: String((c as { label: unknown }).label) }
    : { key: String(c), label: String(c) }
  ));
}

type AddMode = "file" | "manual";

export function AdminTemplatesClient({ templates: initial, isAdmin = false }: { templates: Template[]; isAdmin?: boolean }) {
  const confirm = useConfirm();
  const [templates, setTemplates] = useState(initial);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("file");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Accordion state per marketplace group; collapsed by default to keep the
  // long template list scannable.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  function toggleGroup(label: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }
  /** Open the group a template belongs to (e.g. right after adding one). */
  function revealGroup(marketplace: string) {
    const label = MARKETPLACES.includes(marketplace) ? marketplace : "other";
    setOpenGroups((prev) => new Set(prev).add(label));
  }

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", marketplace: "", category: "" });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");

  function startEdit(tpl: Template) {
    setEditingId(tpl.id);
    setEditForm({ name: tpl.name, marketplace: tpl.marketplace, category: tpl.category ?? "" });
    setEditError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError("");
  }

  async function saveEdit(id: string) {
    setEditLoading(true);
    setEditError("");
    try {
      const res = await fetch(`/api/templates?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editForm.name, marketplace: editForm.marketplace, category: editForm.category || null }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed"); }
      const updated = await res.json() as Template;
      setTemplates((prev) => prev.map((t) => t.id === id ? { ...t, ...updated } : t));
      setEditingId(null);
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditLoading(false);
    }
  }

  // File upload mode state
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [fileForm, setFileForm] = useState({ name: "", marketplace: "amazon", category: "" });
  const [detectedCategory, setDetectedCategory] = useState<string | null>(null);

  // Manual mode state
  const [manualForm, setManualForm] = useState({
    name: "", marketplace: "amazon", category: "", fileFormat: "xlsx",
    columnsRaw: "title,brand,price,upc,asin",
  });

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) pickFile(file);
  }

  const pickFile = useCallback(async (file: File) => {
    setUploadFile(file);
    setDetectedCategory(null);
    // Auto-fill name from filename (strip extension)
    const baseName = file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
    setFileForm((f) => ({ ...f, name: f.name || baseName, category: "" }));

    // Detect category from file content in background
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/templates/detect", { method: "POST", body: fd });
      if (res.ok) {
        const data = await res.json() as { category: string | null };
        if (data.category) {
          setDetectedCategory(data.category);
          setFileForm((f) => ({ ...f, category: f.category || data.category || "" }));
        }
      }
    } catch {
      // Detection failed silently — user can type manually
    }
  }, []);

  async function handleFileSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadFile) { setError("Please select a template file"); return; }
    setLoading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("name", fileForm.name);
      fd.append("marketplace", fileForm.marketplace);
      fd.append("category", fileForm.category);

      const res = await fetch("/api/templates", { method: "POST", body: fd });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed"); }
      const tpl = await res.json();
      setTemplates((prev) => [tpl, ...prev]);
      revealGroup(tpl.marketplace);
      setUploadFile(null);
      setFileForm({ name: "", marketplace: "amazon", category: "" });
      setDetectedCategory(null);
      setShowAdd(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function parseFormColumns(): ColumnDef[] {
    return manualForm.columnsRaw
      .split(",").map((s) => s.trim()).filter(Boolean)
      .map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ") }));
  }

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const columns = parseFormColumns();
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: manualForm.name, marketplace: manualForm.marketplace, category: manualForm.category || null, fileFormat: manualForm.fileFormat, columns }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed"); }
      const tpl = await res.json();
      setTemplates((prev) => [tpl, ...prev]);
      revealGroup(tpl.marketplace);
      setManualForm({ name: "", marketplace: "amazon", category: "", fileFormat: "xlsx", columnsRaw: "title,brand,price,upc,asin" });
      setShowAdd(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this template?",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/templates?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const grouped = MARKETPLACES.map((mp) => ({
    label: mp, items: templates.filter((t) => t.marketplace === mp),
  })).filter((g) => g.items.length > 0);

  const ungrouped = templates.filter((t) => !MARKETPLACES.includes(t.marketplace));
  const allGroups = [...grouped, ...(ungrouped.length ? [{ label: "other", items: ungrouped }] : [])];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="w-4 h-4" />
          {templates.length} template{templates.length !== 1 ? "s" : ""}
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition"
        >
          <Plus className="w-3.5 h-3.5" /> Add Template
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="mb-4 rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">New Template</h3>
            <button onClick={() => { setShowAdd(false); setError(""); setUploadFile(null); }} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Mode tabs */}
          <div className="flex gap-1 mb-4 p-1 rounded-lg bg-muted w-fit">
            {(["file", "manual"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setAddMode(m); setError(""); }}
                className={cn("px-3 py-1.5 rounded-md text-sm font-medium transition",
                  addMode === m ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {m === "file" ? "Upload File" : "Manual Entry"}
              </button>
            ))}
          </div>

          {error && <p className="text-destructive text-sm mb-3">{error}</p>}

          {/* File upload mode */}
          {addMode === "file" && (
            <form onSubmit={handleFileSubmit} className="space-y-3">
              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleFileDrop}
                onClick={() => fileRef.current?.click()}
                className={cn(
                  "border-2 border-dashed rounded-xl px-6 py-8 text-center cursor-pointer transition",
                  dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30",
                  uploadFile && "border-green-500/50 bg-green-50"
                )}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.xlsm,.csv,.tsv"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }}
                />
                {uploadFile ? (
                  <div className="flex items-center justify-center gap-3">
                    <FileSpreadsheet className="w-6 h-6 text-green-600" />
                    <div className="text-left">
                      <p className="text-sm font-medium text-green-700">{uploadFile.name}</p>
                      <p className="text-xs text-muted-foreground">{(uploadFile.size / 1024).toFixed(0)} KB — columns will be auto-detected</p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setUploadFile(null); }}
                      className="ml-auto text-muted-foreground hover:text-foreground"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <Upload className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm font-medium">Drop your marketplace template file here</p>
                    <p className="text-xs text-muted-foreground mt-1">Supports .xlsx, .xlsm, .csv, .tsv — columns auto-detected from header row</p>
                  </>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  placeholder="Template name *"
                  required
                  value={fileForm.name}
                  onChange={(e) => setFileForm((f) => ({ ...f, name: e.target.value }))}
                  className="h-9 rounded-lg border bg-background px-3 text-sm"
                />
                <select
                  value={fileForm.marketplace}
                  onChange={(e) => setFileForm((f) => ({ ...f, marketplace: e.target.value }))}
                  className="h-9 rounded-lg border bg-background px-3 text-sm capitalize"
                >
                  {MARKETPLACES.map((mp) => <option key={mp} value={mp} className="capitalize">{mp}</option>)}
                </select>
                <div className="sm:col-span-2">
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Category
                    {detectedCategory && (
                      <span className="ml-2 text-xs font-medium text-primary">auto-detected</span>
                    )}
                  </label>
                  <input
                    placeholder="Auto-detected from file — override if needed"
                    value={fileForm.category || detectedCategory || ""}
                    onChange={(e) => setFileForm((f) => ({ ...f, category: e.target.value }))}
                    className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
                  />
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowAdd(false)} className="h-8 px-3 rounded-lg border text-sm">Cancel</button>
                <button type="submit" disabled={loading || !uploadFile} className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                  {loading ? "Uploading..." : "Create Template"}
                </button>
              </div>
            </form>
          )}

          {/* Manual entry mode */}
          {addMode === "manual" && (
            <form onSubmit={handleManualSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input placeholder="Template name *" required value={manualForm.name}
                onChange={(e) => setManualForm((f) => ({ ...f, name: e.target.value }))}
                className="h-9 rounded-lg border bg-background px-3 text-sm" />
              <select value={manualForm.marketplace}
                onChange={(e) => setManualForm((f) => ({ ...f, marketplace: e.target.value }))}
                className="h-9 rounded-lg border bg-background px-3 text-sm capitalize">
                {MARKETPLACES.map((mp) => <option key={mp} value={mp} className="capitalize">{mp}</option>)}
              </select>
              <input placeholder="Category (optional)" value={manualForm.category}
                onChange={(e) => setManualForm((f) => ({ ...f, category: e.target.value }))}
                className="h-9 rounded-lg border bg-background px-3 text-sm" />
              <select value={manualForm.fileFormat}
                onChange={(e) => setManualForm((f) => ({ ...f, fileFormat: e.target.value }))}
                className="h-9 rounded-lg border bg-background px-3 text-sm">
                <option value="xlsx">XLSX</option>
                <option value="csv">CSV</option>
              </select>
              <div className="sm:col-span-2">
                <label className="text-xs text-muted-foreground mb-1 block">Columns (comma-separated)</label>
                <input placeholder="title, brand, price, upc, asin" required value={manualForm.columnsRaw}
                  onChange={(e) => setManualForm((f) => ({ ...f, columnsRaw: e.target.value }))}
                  className="h-9 w-full rounded-lg border bg-background px-3 text-sm" />
              </div>
              <div className="sm:col-span-2 flex gap-2 justify-end">
                <button type="button" onClick={() => setShowAdd(false)} className="h-8 px-3 rounded-lg border text-sm">Cancel</button>
                <button type="submit" disabled={loading} className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                  {loading ? "Creating..." : "Create Template"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {templates.length === 0 && !showAdd && (
        <div className="rounded-xl border border-dashed px-6 py-12 text-center text-muted-foreground text-sm">
          No templates yet. Upload a marketplace template file to get started.
        </div>
      )}

      {/* Grouped list — each marketplace is an accordion section */}
      <div className="space-y-4">
        {allGroups.map(({ label, items }) => {
          const isGroupOpen = openGroups.has(label);
          return (
          <div key={label} className="rounded-xl border overflow-hidden">
            <button
              type="button"
              onClick={() => toggleGroup(label)}
              aria-expanded={isGroupOpen}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 bg-muted/40 text-left transition-colors hover:bg-muted/60"
            >
              <MarketplaceLogo marketplace={label} className="w-4 h-4" />
              <span className="text-sm font-semibold capitalize">{label}</span>
              <span className="inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
                {items.length}
              </span>
              <ChevronDown
                className={cn(
                  "ml-auto w-4 h-4 text-muted-foreground transition-transform duration-200",
                  isGroupOpen && "rotate-180"
                )}
              />
            </button>
            {isGroupOpen && (
            <div className="divide-y border-t">
              {items.map((tpl) => {
                const cols = parseColumns(tpl.columns);
                const isOpen = expanded === tpl.id;
                const isEditing = editingId === tpl.id;
                const isAdminTemplate = tpl.userId === null;
                const canModify = isAdmin || !isAdminTemplate;
                return (
                  <div key={tpl.id}>
                    {isEditing ? (
                      <div className="px-4 py-3 space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <input
                            value={editForm.name}
                            onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                            placeholder="Template name"
                            className="h-8 rounded-lg border bg-background px-3 text-sm"
                          />
                          <select
                            value={editForm.marketplace}
                            onChange={(e) => setEditForm((f) => ({ ...f, marketplace: e.target.value }))}
                            className="h-8 rounded-lg border bg-background px-3 text-sm capitalize"
                          >
                            {MARKETPLACES.map((mp) => <option key={mp} value={mp}>{mp}</option>)}
                          </select>
                          <input
                            value={editForm.category}
                            onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))}
                            placeholder="Category (optional)"
                            className="h-8 rounded-lg border bg-background px-3 text-sm"
                          />
                        </div>
                        {editError && <p className="text-xs text-destructive">{editError}</p>}
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveEdit(tpl.id)}
                            disabled={editLoading}
                            className="inline-flex items-center gap-1 h-7 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                          >
                            <Check className="w-3 h-3" />
                            {editLoading ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="h-7 px-3 rounded-lg border text-xs text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 px-4 py-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{tpl.name}</span>
                            {isAdminTemplate && (
                              <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-purple-100 text-purple-700">Admin</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            {tpl.category && (
                              <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{tpl.category}</span>
                            )}
                            <span className={cn("text-xs px-1.5 py-0.5 rounded font-medium",
                              tpl.fileFormat === "xlsx" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                            )}>{tpl.fileFormat.toUpperCase()}</span>
                            <span className="text-xs text-muted-foreground">{cols.length} columns</span>
                          </div>
                        </div>
                        <button onClick={() => setExpanded(isOpen ? null : tpl.id)}
                          className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition">
                          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        {canModify && (
                          <button onClick={() => startEdit(tpl)}
                            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition"
                            title="Edit name, marketplace or category">
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                        {canModify && (
                          <button onClick={() => handleDelete(tpl.id)}
                            className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                    {isOpen && !isEditing && (
                      <div className="px-4 pb-3 flex flex-wrap gap-1.5">
                        {cols.map((c) => (
                          <span key={c.key} className="text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground">{c.label}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
