import { requireAnyAdmin } from "@/lib/auth-helpers";
import { UsageReport } from "@/components/admin/usage-report";

export const dynamic = "force-dynamic";

/**
 * The usage report as a document.
 *
 * Deliberately outside the (app) route group, so it inherits the root layout
 * and none of the application chrome — no sidebar, no navbar, no balance
 * widget. The page is a frame around the PDF and nothing else, because the PDF
 * is the artefact someone takes into a meeting.
 *
 * The figures come from the same endpoint the Usage & credits screen reads, so
 * the report and the screen can never disagree.
 */
export default async function UsageReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAnyAdmin();
  const { days } = await searchParams;
  const window = Math.min(Math.max(Number(days ?? 30), 1), 365);

  return <UsageReport days={window} />;
}
