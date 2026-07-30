// Streamed instantly on navigation while the project page's data loads.
// Mirrors the real layout (tinted full-bleed bg → header card → stepper card →
// step-content card) so the transition doesn't shift once the data arrives.

function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export default function ProjectLoading() {
  return (
    // Mirrors ProjectDetail: window-scrolled page (min-h-screen, no inner
    // overflow so sticky works), bg-muted/30 with -mr-52 to fill edge-to-edge,
    // sticky header card, the rest scrolls under it.
    <div className="relative flex flex-col min-h-screen bg-muted/30 lg:-mr-52">
      {/* Header card — sticky (matches the real layout). */}
      <div className="sticky top-14 lg:top-0 z-20 pt-5 pb-2 shrink-0 bg-background lg:pr-52">
        <div className="pointer-events-none absolute inset-0 bg-muted/30" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-8">
          <div className="flex items-center gap-3 sm:gap-4 rounded-3xl bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] px-4 py-3 sm:px-5">
            <Shimmer className="h-9 w-9 shrink-0 rounded-lg" />
            <div className="flex-1 min-w-0 space-y-2">
              <Shimmer className="h-5 w-48 max-w-full" />
              <Shimmer className="h-3 w-24" />
            </div>
            <Shimmer className="h-8 w-8 shrink-0 rounded-lg" />
          </div>
        </div>
      </div>

      {/* Stepper card */}
      <div className="relative z-10 py-4 shrink-0 lg:pr-52">
        <div className="mx-auto max-w-6xl px-4 sm:px-8">
          <div className="flex items-center gap-0 overflow-x-auto rounded-3xl bg-muted/30 p-2 sm:p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center flex-1 last:flex-none">
                <div className="flex items-center gap-3 px-3 py-2">
                  <Shimmer className="h-8 w-8 shrink-0 rounded-full" />
                  <div className="hidden lg:block space-y-1.5">
                    <Shimmer className="h-3 w-20" />
                    <Shimmer className="h-2.5 w-28" />
                  </div>
                </div>
                {i < 3 && <Shimmer className="mx-1 h-4 w-4 shrink-0" />}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Step content card */}
      <div className="relative z-10 pb-6 lg:pr-52">
        <div className="mx-auto max-w-6xl px-4 sm:px-8">
          <div className="rounded-3xl bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] overflow-hidden">
            <div className="p-4 sm:p-8">
              {/* Title row + actions */}
              <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-2">
                  <Shimmer className="h-5 w-44" />
                  <Shimmer className="h-3.5 w-64 max-w-full" />
                </div>
                <Shimmer className="h-9 w-36 shrink-0 rounded-lg" />
              </div>

              {/* Stat cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="rounded-2xl bg-muted/30 p-5 space-y-2">
                    <Shimmer className="h-7 w-10" />
                    <Shimmer className="h-3.5 w-24" />
                  </div>
                ))}
              </div>

              {/* Table */}
              <div className="overflow-hidden rounded-2xl bg-muted/20">
                <div className="flex gap-4 bg-muted/40 px-4 py-3">
                  <Shimmer className="h-3.5 flex-1" />
                  <Shimmer className="hidden h-3.5 w-24 sm:block" />
                  <Shimmer className="hidden h-3.5 w-24 sm:block" />
                  <Shimmer className="hidden h-3.5 w-16 md:block" />
                </div>
                <div className="divide-y divide-border/40">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-4 px-4 py-3">
                      <div className="flex-1 space-y-1.5">
                        <Shimmer className="h-3.5 w-3/4 max-w-sm" />
                        <Shimmer className="h-2.5 w-24" />
                      </div>
                      <Shimmer className="hidden h-3.5 w-24 sm:block" />
                      <Shimmer className="hidden h-3.5 w-24 sm:block" />
                      <Shimmer className="hidden h-5 w-12 rounded-full md:block" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
