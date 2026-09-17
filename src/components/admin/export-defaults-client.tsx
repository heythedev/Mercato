"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { MARKETPLACE_TILES } from "@/lib/marketplaces/catalog";

type Row = {
  id: string;
  marketplace: string;
  attribute: string;
  label: string | null;
  value: string;
  updatedAt: string;
  updatedBy: string | null;
};

/**
 * The columns worth suggesting: measured on the live Best Buy project as the
 * required cells no source can answer, biggest group first. Picking one fills
 * in the attribute and label so an admin does not have to know Mirakl codes.
 */
const SUGGESTIONS: { marketplace: string; attribute: string; label: string; rows: number; hint: string }[] = [
  {
    marketplace: "bestbuy",
    attribute: "californiaProposition65Warning.type",
    label: "California Proposition 65 Warning: Type",
    rows: 41,
    hint: 'The warning category the seller declares, e.g. "No warning applicable".',
  },
  {
    marketplace: "bestbuy",
    attribute: "containsIntentionallyAddedPfas",
    label: "Contains intentionally added PFAS",
    rows: 23,
    hint: 'Usually "No" for non-treated goods — the seller\'s declaration, not a product fact.',
  },
];

export function AdminExportDefaultsClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  /** Set to the fix command when the table has not been created yet. */
  const [setup, setSetup] = useState("");
  /** Reserved settings rows, keyed "<marketplace>:<key>". */
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [settingKeys, setSettingKeys] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ marketplace: "bestbuy", attribute: "", label: "", value: "" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/export-defaults");
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setRows(json.defaults ?? []);
        setSetup(json.setupRequired ? (json.setupCommand ?? "") : "");
        setSettings(json.settings ?? {});
        setSettingKeys(json.settingKeys ?? {});
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load defaults");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const save = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/export-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setForm({ marketplace: form.marketplace, attribute: "", label: "", value: "" });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [form]);

  const remove = useCallback(async (id: string) => {
    setError("");
    try {
      const res = await fetch(`/api/admin/export-defaults?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete");
    }
  }, []);

  /**
   * Flip a reserved setting. Turning it OFF writes "off" rather than deleting
   * the row, so the screen shows an explicit decision instead of an absence —
   * and either way the export reads the same field.
   */
  const toggleSetting = useCallback(async (marketplace: string, key: string, on: boolean) => {
    setError("");
    try {
      const res = await fetch("/api/admin/export-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketplace,
          attribute: key,
          label: "Keep values in not-applicable (grey) cells",
          value: on ? "on" : "off",
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the setting");
    }
  }, []);

  const applySuggestion = (s: (typeof SUGGESTIONS)[number]) =>
    setForm({ marketplace: s.marketplace, attribute: s.attribute, label: s.label, value: "" });

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          These values are written into every row whose category marks the column required and where
          nothing else filled it. They are never guessed and never overwrite real data — compliance
          declarations in particular should come from the client, not from us.
        </span>
      </div>

      {setup && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          <p className="font-medium">Export defaults are not set up yet.</p>
          <p className="mt-1">
            The code is deployed, but its table has not been created. Run this once, from a machine
            with the project checked out:
          </p>
          <code className="mt-2 block rounded bg-amber-100 px-2 py-1 font-mono text-xs">{setup}</code>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {settingKeys.fillNaCells && (
        <div className="rounded-lg border overflow-hidden">
          <div className="border-b bg-muted/40 px-4 py-2 text-sm font-medium">
            Not-applicable (grey) cells
          </div>
          <div className="p-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              A grey cell means the marketplace states that attribute does not apply to that row&apos;s
              category, so the export clears it. Switching this on keeps values we already resolved
              in those cells instead. Nothing extra is asked of the AI, and no cost changes.
            </p>
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2">
              A value in a not-applicable column can cause the marketplace to reject the row. Turn
              this on only if the client has asked for it, and switch it off here to undo — nothing
              else changes.
            </p>
            <div className="flex flex-wrap gap-2">
              {MARKETPLACE_TILES.map((m) => {
                const key = `${m.id}:${settingKeys.fillNaCells}`;
                const on = ["on", "true", "yes", "1"].includes((settings[key] ?? "").toLowerCase());
                return (
                  <button
                    key={m.id}
                    onClick={() => void toggleSetting(m.id, settingKeys.fillNaCells!, !on)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs transition-colors",
                      on ? "bg-foreground text-background" : "hover:bg-muted",
                    )}
                    title={on ? `Keep grey-cell values for ${m.label}` : `Clear grey cells for ${m.label} (default)`}
                  >
                    {m.label}: {on ? "keeping values" : "cleared"}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border overflow-hidden">
        <div className="border-b bg-muted/40 px-4 py-2 text-sm font-medium">Add or update a default</div>
        <div className="p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">Marketplace</span>
              <select
                value={form.marketplace}
                onChange={(e) => setForm({ ...form, marketplace: e.target.value })}
                className="mt-1 w-full rounded-lg border px-3 py-1.5 text-sm bg-background"
              >
                {MARKETPLACE_TILES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="text-xs text-muted-foreground">Column (label or attribute code)</span>
              <input
                value={form.attribute}
                onChange={(e) => setForm({ ...form, attribute: e.target.value })}
                placeholder="californiaProposition65Warning.type"
                className="mt-1 w-full rounded-lg border px-3 py-1.5 text-sm bg-background"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">Value written into the cell</span>
              <input
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                placeholder="No warning applicable"
                className="mt-1 w-full rounded-lg border px-3 py-1.5 text-sm bg-background"
              />
            </label>
          </div>
          <button
            onClick={() => void save()}
            disabled={saving || !form.attribute.trim() || !form.value.trim()}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {saving ? "Saving…" : "Save default"}
          </button>

          <div className="pt-2">
            <div className="text-xs text-muted-foreground mb-2">
              Most common unanswerable columns, measured on the live Best Buy project:
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.attribute}
                  onClick={() => applySuggestion(s)}
                  title={s.hint}
                  className="rounded-full border px-3 py-1 text-xs hover:bg-muted text-left"
                >
                  {s.label} <span className="text-muted-foreground">· {s.rows} rows</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <div className="border-b bg-muted/40 px-4 py-2 text-sm font-medium">
          Current defaults {rows.length > 0 && <span className="text-muted-foreground">({rows.length})</span>}
        </div>
        {loading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            None set. Until a compliance column has a value here, it ships empty and its row is held
            back from the export.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  {["Marketplace", "Column", "Value", "Updated", ""].map((h, i) => (
                    <th key={h} className={cn("px-4 py-2 font-medium", i === 4 ? "text-right" : "text-left")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-4 py-2">{r.marketplace}</td>
                    <td className="px-4 py-2">
                      {r.label ?? r.attribute}
                      <div className="text-xs text-muted-foreground font-mono">{r.attribute}</div>
                    </td>
                    <td className="px-4 py-2 font-medium">{r.value}</td>
                    <td className="px-4 py-2 text-muted-foreground text-xs">
                      {new Date(r.updatedAt).toLocaleDateString()}
                      {r.updatedBy ? ` · ${r.updatedBy}` : ""}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => void remove(r.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-600"
                        title="Remove this default"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
