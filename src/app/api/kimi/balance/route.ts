import { NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import {
  fetchMoonshotBalance,
  getLastMoonshotBalance,
  getMoonshotUsage,
  moonshotConfigured,
} from "@/lib/ai/moonshot";

export const dynamic = "force-dynamic";

/** Kimi (Moonshot) account balance + this instance's usage counters for the
 *  sidebar widget. Serves a snapshot when fresh; `?fresh=1` (the widget's
 *  refresh button) always re-probes. Every AI feature — categorization, spec
 *  types, dropdown fills, vision checks, title generation — spends this one
 *  balance, so a $0 here is the single explanation for all of them failing. */
export async function GET(req: Request) {
  const { response } = await authGuard();
  if (response) return response;

  if (!moonshotConfigured()) {
    return NextResponse.json({ configured: false });
  }

  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const MAX_AGE_MS = 5 * 60 * 1000;
  let balance = getLastMoonshotBalance();
  if (fresh || !balance || Date.now() - balance.timestamp > MAX_AGE_MS) {
    balance = await fetchMoonshotBalance();
  }

  const usage = getMoonshotUsage();
  return NextResponse.json({
    configured: true,
    availableBalance: balance?.availableBalance ?? null,
    cashBalance: balance?.cashBalance ?? null,
    voucherBalance: balance?.voucherBalance ?? null,
    // Per-instance counters — indicative (serverless instances each count their
    // own), the balance above is the authoritative spend measure.
    usage: {
      calls: usage.calls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      byModel: usage.byModel,
      since: usage.since,
    },
  });
}
