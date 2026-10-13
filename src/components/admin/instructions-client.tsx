"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Card, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { marketplaceLabel } from "@/lib/marketplaces/catalog";
import { cn } from "@/lib/utils";

export type InstructionRow = {
  marketplace: string;
  text: string;
  teamId: string | null;
  updatedAt: string | Date;
  updatedBy: string | null;
};

export type ColumnRuleRow = {
  id: string;
  marketplace: string;
  teamId: string | null;
  column: string;
  action: string;
  find: string | null;
  value: string | null;
  note: string | null;
};

export type CorrectionRow = {
  marketplace: string;
  attribute: string;
  count: number;
  mostCommon: { value: string; count: number } | null;
};

/**
 * The two ends of the same loop, on one screen.
 *
 * What a person told the system to do, and what people keep having to undo.
 * They are together because reading the second is how you decide what to put
 * in the first — a column corrected two hundred times with the same
 * replacement is a rule somebody should write down, and a column corrected
 * twice is noise.
 */
/**
 * One stated change, and the form for adding another.
 *
 * Separate from the free-text rule above it because the two are answered by
 * different things: that one is read by a model and interpreted per product,
 * this one is applied by the exporter to every row without asking anybody.
 */
function ColumnRules({
  marketplace,
  rules,
  onChanged,
}: {
  marketplace: string;
  rules: ColumnRuleRow[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ column: "", action: "replace", find: "", value: "", note: "" });

  const field =
    "rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-foreground/30";

  async function add() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/column-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketplace, ...form }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not add");
      toast.success("Rule added — every export applies it from now on");
      setForm({ column: "", action: "replace", find: "", value: "", note: "" });
      setAdding(false);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/column-rules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Could not remove");
      }
      toast.success("Rule removed");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Read back as a sentence rather than as its stored fields. A rule somebody
  // wrote months ago has to be judgeable without knowing the schema.
  const describe = (r: ColumnRuleRow) => {
    const where = r.column === "*" ? "every text column" : r.column;
    if (r.action === "blank") return `${where} always ships empty`;
    if (r.action === "append") return `add “${r.value}” to the end of ${where}`;
    return r.value
      ? `in ${where}, replace “${r.find}” with “${r.value}”`
      : `in ${where}, remove “${r.find}”`;
  };

  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      {rules.map((r) => (
        <div key={r.id} className="flex items-start justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[13px] text-foreground">{describe(r)}</p>
            {r.note ? <p className="text-[12px] text-muted-foreground">{r.note}</p> : null}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => remove(r.id)}
            aria-label="Remove rule"
            className="shrink-0 text-muted-foreground transition hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {adding ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={form.column}
              onChange={(e) => setForm((f) => ({ ...f, column: e.target.value }))}
              placeholder="Column, e.g. Product Description"
              className={cn(field, "min-w-48 flex-1")}
            />
            <select
              value={form.action}
              onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}
              className={field}
            >
              <option value="replace">replace / remove</option>
              <option value="append">add to the end</option>
              <option value="blank">always leave empty</option>
            </select>
          </div>

          {form.action === "replace" ? (
            <div className="flex flex-wrap gap-2">
              <input
                value={form.find}
                onChange={(e) => setForm((f) => ({ ...f, find: e.target.value }))}
                placeholder="Find this word"
                className={cn(field, "min-w-40 flex-1")}
              />
              <input
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                placeholder="Replace with — leave empty to remove"
                className={cn(field, "min-w-40 flex-1")}
              />
            </div>
          ) : null}

          {form.action === "append" ? (
            <input
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              placeholder="Text to add at the end"
              className={cn(field, "w-full")}
            />
          ) : null}

          <input
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            placeholder="Why — so a rule nobody remembers writing can still be judged"
            className={cn(field, "w-full")}
          />

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !form.column.trim()}
              onClick={add}
              className="rounded-full bg-foreground px-4 py-1.5 text-[13px] font-medium text-background disabled:bg-muted disabled:text-muted-foreground"
            >
              {busy ? "Adding…" : "Add rule"}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded-full px-4 py-1.5 text-[13px] text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          Add a rule the exporter applies itself
        </button>
      )}
    </div>
  );
}

export function InstructionsClient({
  marketplaces,
  maxChars,
  canEditGlobal,
  teamId,
  instructions,
  corrections,
  columnRules,
}: {
  marketplaces: string[];
  maxChars: number;
  canEditGlobal: boolean;
  teamId: string | null;
  instructions: InstructionRow[];
  corrections: CorrectionRow[];
  columnRules: ColumnRuleRow[];
}) {
  const router = useRouter();
  const mine = (mp: string) =>
    instructions.find((i) => i.marketplace === mp && (canEditGlobal ? !i.teamId : i.teamId === teamId));

  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(marketplaces.map((mp) => [mp, mine(mp)?.text ?? ""])),
  );
  const [saving, setSaving] = useState<string | null>(null);

  async function save(marketplace: string) {
    setSaving(marketplace);
    try {
      const res = await fetch("/api/admin/instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketplace, text: draft[marketplace] ?? "" }),
      });
      const data = (await res.json()) as { error?: string; cleared?: boolean };
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      toast.success(
        data.cleared
          ? `${marketplaceLabel(marketplace)} rule removed`
          : `${marketplaceLabel(marketplace)} rule saved — every run uses it from now on`,
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <PageHeader
        title="Marketplace rules"
        subtitle="Written once, read by every run — Mercato's own and Claude's alike."
      />

      <Notice tone="info" title="This is not a value, it is a rule">
        A column that holds the same value on every product belongs in <strong>Export defaults</strong>,
        which writes it straight into the cell. This is for guidance a model has to apply per
        product — how a description should read, which wording to avoid.
        {canEditGlobal ? null : " Your team's rule, which overrides the global one."}
      </Notice>

      <div className="space-y-4">
        {marketplaces.map((mp) => {
          const current = mine(mp);
          const global = instructions.find((i) => i.marketplace === mp && !i.teamId);
          const dirty = (draft[mp] ?? "") !== (current?.text ?? "");
          return (
            <Card key={mp} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">{marketplaceLabel(mp)}</h2>
                <span className="text-[12px] text-muted-foreground">
                  {(draft[mp] ?? "").length}/{maxChars}
                </span>
              </div>

              {!canEditGlobal && global ? (
                <p className="rounded-lg border border-border/60 bg-muted/30 p-3 text-[13px] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Global rule: </span>
                  {global.text}
                </p>
              ) : null}

              <textarea
                value={draft[mp] ?? ""}
                maxLength={maxChars}
                rows={3}
                onChange={(e) => setDraft((d) => ({ ...d, [mp]: e.target.value }))}
                placeholder={`No rule set for ${marketplaceLabel(mp)}.`}
                className="w-full resize-y rounded-lg border border-border bg-background p-3 text-[13px] leading-relaxed text-foreground outline-none focus:border-foreground/30"
              />

              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-muted-foreground">
                  {current?.updatedAt
                    ? `Last changed ${new Date(current.updatedAt).toLocaleDateString()}`
                    : "Never set"}
                </span>
                <button
                  type="button"
                  disabled={!dirty || saving === mp}
                  onClick={() => save(mp)}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[13px] font-medium transition",
                    dirty && saving !== mp
                      ? "bg-foreground text-background"
                      : "cursor-not-allowed bg-muted text-muted-foreground",
                  )}
                >
                  {saving === mp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {(draft[mp] ?? "").trim() ? "Save" : "Clear"}
                </button>
              </div>

              <ColumnRules
                marketplace={mp}
                rules={columnRules.filter((r) => r.marketplace === mp)}
                onChanged={() => router.refresh()}
              />
            </Card>
          );
        })}
      </div>

      <Card className="space-y-4">
        <PageHeader
          as="section"
          title="What people keep correcting"
          subtitle="Values a person changed after a model or a catalogue lookup produced them."
          className="mb-0"
        />
        {corrections.length === 0 ? (
          <EmptyState title="Nothing recorded yet">
            Corrections are kept from now on. A column that keeps being corrected the same way is a
            rule worth writing above.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/60 text-left text-[12px] text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Marketplace</th>
                  <th className="pb-2 pr-4 font-medium">Column</th>
                  <th className="pb-2 pr-4 font-medium">Corrected</th>
                  <th className="pb-2 font-medium">Most often to</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {corrections.map((c) => (
                  <tr key={`${c.marketplace}-${c.attribute}`}>
                    <td className="py-2 pr-4 text-muted-foreground">{marketplaceLabel(c.marketplace)}</td>
                    <td className="py-2 pr-4 text-foreground">{c.attribute}</td>
                    <td className="py-2 pr-4 font-medium text-foreground">{c.count}×</td>
                    <td className="py-2 text-muted-foreground">
                      {c.mostCommon ? `${c.mostCommon.value} (${c.mostCommon.count}×)` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
