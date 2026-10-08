import { headers } from "next/headers";
import { requireUser } from "@/lib/auth-helpers";
import { HelpClient } from "@/components/help/help-client";
import {
  CATEGORIZE_BATCH,
  CATEGORIZE_BATCH_MAX,
  DOWNLOAD_TICKET_TTL_MS,
  EXPORT_GAPS_BATCH,
  EXPORT_GAPS_BATCH_MAX,
  MAX_INLINE_UPLOAD_BYTES,
  MAX_ROWS,
  MAX_WRITE,
  RUNS_PER_DAY,
} from "@/lib/mcp/limits";

export const dynamic = "force-dynamic";

/**
 * Help, for everyone signed in.
 *
 * The numbers come from the module the tools enforce them with, not from
 * prose written here. A Help page is read by someone who does not know the
 * answer and therefore cannot catch it being wrong, which makes a stale
 * number worse on this page than on any other.
 *
 * The connector URL is resolved from the request for the same reason the
 * Connect to Claude page does it: right on localhost, right on a preview
 * deployment, right in production, with no constant to keep in step.
 */
export default async function HelpPage() {
  await requireUser();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");

  return (
    <HelpClient
      mcpUrl={`${proto}://${host}/api/mcp`}
      limits={{
        runsPerDay: RUNS_PER_DAY,
        maxRows: MAX_ROWS,
        maxWrite: MAX_WRITE,
        categorizeBatch: CATEGORIZE_BATCH,
        categorizeBatchMax: CATEGORIZE_BATCH_MAX,
        gapsBatch: EXPORT_GAPS_BATCH,
        gapsBatchMax: EXPORT_GAPS_BATCH_MAX,
        uploadMb: Math.round(MAX_INLINE_UPLOAD_BYTES / (1024 * 1024)),
        downloadMinutes: Math.round(DOWNLOAD_TICKET_TTL_MS / 60_000),
      }}
    />
  );
}
