"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Download, FileText } from "lucide-react";
import { UsageReportDoc, type ReportData } from "./usage-report-pdf";

/**
 * The usage report, delivered as a PDF.
 *
 * The Usage & credits screen answers "what is happening right now"; this
 * answers "what did this cost and why", for someone who was not watching.
 *
 * It used to be an HTML page with a Print button, which made the browser's
 * print dialog the delivery mechanism — so what someone ended up with was a web
 * page with print furniture on it, and only if they remembered to choose "Save
 * as PDF" over an actual printer. Now the document itself is the artefact:
 * opened in the viewer, downloadable as one file, identical everywhere.
 *
 * The renderer is a large client-only bundle and this is a rarely-visited admin
 * route, so it is loaded on demand rather than shipped to everyone.
 */

const PDFViewer = dynamic(
  () => import("@react-pdf/renderer").then((m) => m.PDFViewer),
  {
    ssr: false,
    loading: () => <Placeholder>Preparing the document…</Placeholder>,
  },
);

const PDFDownloadLink = dynamic(
  () => import("@react-pdf/renderer").then((m) => m.PDFDownloadLink),
  { ssr: false, loading: () => null },
);

const RANGES = [1, 2, 3, 7, 30, 90] as const;
const rangeLabel = (r: number): string => (r === 1 ? "24h" : `${r}d`);

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[70vh] items-center justify-center text-sm text-neutral-500">
      {children}
    </div>
  );
}

export function UsageReport({ days }: { days: number }) {
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/usage?days=${days}`, { cache: "no-store" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the report");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const fileName = `mercato-usage-${days}d-${new Date().toISOString().slice(0, 10)}.pdf`;

  return (
    <div className="mx-auto flex h-screen max-w-[1100px] flex-col px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center gap-3 border-b pb-4">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-neutral-900">
          <FileText className="h-4 w-4" />
          Usage &amp; spend report
        </span>

        {/* The window chips live here too: changing the period is the one thing
            someone does on this page, and it should not mean going back. */}
        <div className="flex overflow-hidden rounded-lg border">
          {RANGES.map((r) => (
            <a
              key={r}
              href={`/admin/usage/report?days=${r}`}
              className={`px-2.5 py-1.5 text-xs transition-colors ${
                r === days ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"
              }`}
            >
              {rangeLabel(r)}
            </a>
          ))}
        </div>

        {data && (
          <PDFDownloadLink
            document={<UsageReportDoc data={data} />}
            fileName={fileName}
            className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
          >
            <Download className="h-4 w-4" />
            Download PDF
          </PDFDownloadLink>
        )}

        <span className="ml-auto text-xs text-neutral-500">A4 · days are IST</span>
      </div>

      {error ? (
        <Placeholder>
          <span className="text-red-700">{error}</span>
        </Placeholder>
      ) : !data ? (
        <Placeholder>Loading figures…</Placeholder>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
          {/* showToolbar keeps the viewer's own print and save controls, which
              are the ones people already know. */}
          <PDFViewer width="100%" height="100%" showToolbar style={{ border: "none" }}>
            <UsageReportDoc data={data} />
          </PDFViewer>
        </div>
      )}
    </div>
  );
}
