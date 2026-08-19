"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Coins } from "lucide-react";
import { cn } from "@/lib/utils";

type SyncBalance = { remaining: number | null; limit: number | null };
type KeepaBal = { tokensLeft?: number; refillRate?: number; error?: string };

/** Data-source balances for the sidebar. Amazon verification draws on BOTH
 *  sources in one run (Synccentric leads or backfills, Keepa covers the rest),
 *  so the widget shows each configured source's budget rather than picking
 *  one. Fetches once on mount; the refresh button forces a live probe. */
export function KeepaBalance() {
  const [sync, setSync] = useState<SyncBalance | null>(null);
  const [keepa, setKeepa] = useState<KeepaBal | null>(null);
  // null until the first load answers — render a single loading row until then.
  const [configured, setConfigured] = useState<{ sync: boolean; keepa: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (fresh: boolean) => {
    setLoading(true);
    try {
      // Independent sources — one failing must not blank the other.
      const [scRes, kpRes] = await Promise.allSettled([
        fetch(`/api/synccentric/balance${fresh ? "?fresh=1" : ""}`, { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/keepa/balance", { cache: "no-store" }).then((r) => r.json()),
      ]);
      const sc = scRes.status === "fulfilled" ? scRes.value : null;
      const kp = kpRes.status === "fulfilled" ? kpRes.value : null;
      setConfigured({ sync: !!sc?.configured, keepa: !!kp?.configured });
      setSync(sc?.configured ? { remaining: sc.remaining ?? null, limit: sc.limit ?? null } : null);
      setKeepa(kp?.configured ? { tokensLeft: kp.tokensLeft, refillRate: kp.refillRate, error: kp.error } : null);
    } catch {
      setKeepa({ error: "Failed to load" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Neither source configured on this environment — hide entirely.
  if (configured && !configured.sync && !configured.keepa) return null;

  const rows: { label: string; value: string; detail: string | null }[] = [];
  if (!configured) {
    rows.push({ label: "Data sources", value: "…", detail: null });
  } else {
    if (configured.sync) {
      // The API relays Synccentric's own header, which goes negative once the
      // day's quota is overrun — clamp for display; "0 left" is the message.
      const remaining = sync?.remaining != null ? Math.max(0, sync.remaining) : null;
      rows.push({
        label: "Synccentric searches",
        value: loading && remaining == null ? "…" : remaining != null ? remaining.toLocaleString() : "—",
        detail: sync?.limit != null ? `of ${sync.limit.toLocaleString()} today` : null,
      });
    }
    if (configured.keepa) {
      rows.push({
        label: "Keepa tokens",
        value: loading && keepa?.tokensLeft == null ? "…"
          : keepa?.tokensLeft != null ? keepa.tokensLeft.toLocaleString() : "—",
        detail: keepa?.refillRate ? `+${keepa.refillRate}/min` : null,
      });
    }
  }

  return (
    <div className="mt-auto border-t border-border/50 p-3">
      <div className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
        <Coins className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          {rows.map((r) => (
            <div key={r.label}>
              <p className="text-[11px] leading-tight text-muted-foreground">{r.label}</p>
              <p className="truncate text-sm font-semibold tabular-nums">
                {r.value}
                {r.detail ? (
                  <span className="ml-1 text-[11px] font-normal text-muted-foreground">{r.detail}</span>
                ) : null}
              </p>
            </div>
          ))}
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading}
          title="Refresh balances"
          aria-label="Refresh data-source balances"
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
    </div>
  );
}
