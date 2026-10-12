import { Skeleton } from "@/components/ui/primitives";

// Streamed instantly while the projects list loads. Mirrors ProjectsView —
// header card, filter row, a 3-up grid of cards with their badge row and step
// bar — so nothing shifts when the real list lands.
export default function ProjectsLoading() {
  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto" aria-busy="true" aria-label="Loading projects">
      <div className="mb-6 flex items-center justify-between rounded-xl border border-border bg-card px-5 py-4 sm:px-6">
        <div className="space-y-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-3.5 w-20" />
        </div>
        <Skeleton className="h-9 w-32 rounded-full" />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full max-w-xs rounded-full lg:w-[calc((100%-2rem)/3)] lg:max-w-none" />
        <Skeleton className="h-9 w-40 rounded-full" />
        <Skeleton className="h-9 w-44 rounded-full" />
        <Skeleton className="h-9 w-40 rounded-full" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-4 rounded-2xl border bg-card p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 space-y-2 pl-5">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <div className="flex gap-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-5 w-36 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton className="h-2.5 w-16" />
              <div className="flex gap-1">
                {Array.from({ length: 4 }).map((__, j) => (
                  <Skeleton key={j} className="h-1.5 flex-1 rounded-full" />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
