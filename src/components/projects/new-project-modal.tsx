"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { NewProjectForm } from "./new-project-form";

export function NewProjectModal({
  open,
  onClose,
  allowedTiles,
}: {
  open: boolean;
  onClose: () => void;
  allowedTiles: string[];
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    // Prevent the page behind the modal from scrolling
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        className="my-auto w-full max-w-2xl rounded-2xl border bg-card p-6 shadow-xl sm:p-8"
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 id="new-project-title" className="text-xl font-bold tracking-tight">
              New Project
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload a vendor file and select a marketplace to get started.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <NewProjectForm allowedTiles={allowedTiles} />
      </div>
    </div>
  );
}
