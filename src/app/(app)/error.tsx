"use client";

// Error boundary for the authenticated app. Any page under (app) that throws —
// most importantly a database outage while loading data — renders this instead
// of a bare 500/503. The shell (sidebar, nav) still comes from the layout, so
// the app stays navigable and the user sees a clear message + retry rather than
// a dead screen.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h2 className="text-lg font-semibold">Couldn’t load this page</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        We’re having trouble reaching the server right now. This is usually
        temporary — please try again in a moment.
      </p>
      <button
        onClick={reset}
        className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
      >
        Try again
      </button>
    </div>
  );
}
