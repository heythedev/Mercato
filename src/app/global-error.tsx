"use client";

// Outermost safety net. Catches errors that escape even the root layout (which
// the per-segment error.tsx boundaries cannot cover). Must render its own
// <html>/<body> because it replaces the whole document on a top-level failure.
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: "1.5rem",
        }}
      >
        <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Something went wrong</h2>
        <p style={{ maxWidth: "28rem", color: "#666", fontSize: "0.875rem" }}>
          The app hit an unexpected error. Please try again in a moment.
        </p>
        <button
          onClick={reset}
          style={{
            border: "1px solid #ccc",
            borderRadius: "0.375rem",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
