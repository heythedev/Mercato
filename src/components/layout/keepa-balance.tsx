"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Coins } from "lucide-react";
import { cn } from "@/lib/utils";

type SourceBalance =
  | { source: "synccentric"; remaining: number | null; limit: number | null }
  | { source: "keepa"; tokensLeft?: number; refillRate?: number; error?: string }
  | { source: "none" };

/** Data-source balance for the sidebar. Shows the Synccentric daily search
 *  quota when a token is configured (Synccentric is the client-facing source
 *  now); falls back to the Keepa token balance otherwise. Fetches once on
 *  mount; the refresh button forces a live probe. */
export function KeepaBalance() {
  const [data, setData] = useState<SourceBalance | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (fresh: boolean) => {
    setLoading(true);
    try {
      const sc = await fetch(`/api/synccentric/balance${fresh ? "?fresh=1" : ""}`, {
        cache: "no-store",
      }).then((r) => r.json());
      if (sc.configured) {
        setData({ source: "synccentric", remaining: sc.remaining ?? null, limit: sc.limit ?? null });
        return;
      }
      const kp = await fetch("/api/keepa/balance", { cache: "no-store" }).then((r) => r.json());
      setData(kp.configured ? { source: "keepa", ...kp } : { source: "none" });
    } catch {
      setData({ source: "keepa", error: "Failed to load" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Neither source configured on this environment — hide entirely.
  if (data && data.source === "none") return null;

  const isSync = data?.source === "synccentric";
  const label = isSync ? "Synccentric searches" : "Keepa balance";

  let value = loading || !data ? "…" : "—";
  let detail: string | null = null;
  if (data?.source === "synccentric") {
    if (data.remaining != null) value = data.remaining.toLocaleString();
    detail = data.limit != null ? `of ${data.limit.toLocaleString()} today` : null;
  } else if (data?.source === "keepa" && !data.error) {
    if (data.tokensLeft != null) value = data.tokensLeft.toLocaleString();
    detail = data.refillRate ? `+${data.refillRate}/min` : null;
  }

  return (
    <div className="mt-auto border-t border-border/50 p-3">
      <div className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
        <Coins className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] leading-tight text-muted-foreground">{label}</p>
          <p className="truncate text-sm font-semibold tabular-nums">
            {value}
            {detail ? (
              <span className="ml-1 text-[11px] font-normal text-muted-foreground">{detail}</span>
            ) : null}
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading}
          title="Refresh balance"
          aria-label={`Refresh ${label}`}
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
    </div>
  );
}
