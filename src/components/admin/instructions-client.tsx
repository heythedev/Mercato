"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
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
export function InstructionsClient({
  marketplaces,
  maxChars,
  canEditGlobal,
  teamId,
  instructions,
  corrections,
}: {
  marketplaces: string[];
  maxChars: number;
  canEditGlobal: boolean;
  teamId: string | null;
  instructions: InstructionRow[];
  corrections: CorrectionRow[];
}) {
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
