"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
};

type ConfirmState = ConfirmOptions & {
  resolve: (value: boolean) => void;
};

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...options, resolve });
    });
  }, []);

  function close(result: boolean) {
    if (!state) return;
    state.resolve(result);
    setState(null);
    setPending(false);
  }

  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close(false);
          }}
        >
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            className="w-full max-w-sm rounded-2xl border bg-card p-5 shadow-xl"
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                  state.variant === "default" ? "bg-muted text-foreground" : "bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400"
                )}
              >
                <AlertTriangle className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0 pt-0.5">
                <h2 id="confirm-dialog-title" className="text-sm font-semibold">
                  {state.title}
                </h2>
                {state.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{state.description}</p>
                )}
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => close(false)}
                disabled={pending}
                className="h-9 rounded-lg border px-4 text-sm font-medium hover:bg-muted transition disabled:opacity-50"
              >
                {state.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                autoFocus
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  close(true);
                }}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-sm font-medium transition disabled:opacity-50",
                  state.variant === "default"
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-red-600 text-white hover:bg-red-700"
                )}
              >
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {state.confirmLabel ?? "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}
