"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Coins } from "lucide-react";
import { cn } from "@/lib/utils";

type Balance = {
  configured: boolean;
  tokensLeft?: number;
  refillRate?: number;
  error?: string;
};

/** Live Keepa token balance with a manual refresh button. Fetches once on
 *  mount and again whenever the refresh button is clicked. */
export function KeepaBalance() {
  const [data, setData] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/keepa/balance", { cache: "no-store" });
      setData(await res.json());
    } catch {
      setData({ configured: true, error: "Failed to load" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Not configured on this environment — hide entirely rather than show an error.
  if (data && !data.configured) return null;

  const tokens = data?.tokensLeft;

  return (
    <div className="mt-auto border-t border-border/50 p-3">
      <div className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
        <Coins className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] leading-tight text-muted-foreground">Keepa balance</p>
          <p className="truncate text-sm font-semibold tabular-nums">
            {data?.error
              ? "—"
              : tokens != null
                ? tokens.toLocaleString()
                : loading
                  ? "…"
                  : "—"}
            {data?.refillRate ? (
              <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                +{data.refillRate}/min
              </span>
            ) : null}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          title="Refresh balance"
          aria-label="Refresh Keepa balance"
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
    </div>
  );
}
