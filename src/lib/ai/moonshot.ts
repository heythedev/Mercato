import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";

/**
 * Moonshot AI (Kimi) — the single provider for every AI feature.
 *
 * Key: MOONSHOT_KEY (global platform, https://platform.moonshot.ai). KIMI_API_KEY
 * is accepted as a fallback for environments that still set the old name.
 */
const apiKey = process.env.MOONSHOT_KEY ?? process.env.KIMI_API_KEY ?? "";
const baseURL = process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";

// ── AI availability guard ─────────────────────────────────────────────────────
// Every AI feature spends ONE Moonshot balance. When it drains, the platform
// suspends the organization and answers every call with HTTP 429
// `exceeded_current_quota_error` — the same status code as a rate limit, so the
// AI SDK retried each call twice and the callers treated the failure as a
// transient hiccup, retried it three more times, and then wrote "Needs manual
// review" into the database for thousands of products that were never looked
// at. This guard makes such failures FATAL and FAST instead:
//
//   • classifyAiError() tells callers whether a failure is fatal (no balance,
//     bad key, model gone) — a fatal failure must never be recorded as a verdict.
//   • The provider's fetch rewrites a quota 429 into a non-retryable 402, and
//     records an outage so every subsequent call in this instance short-circuits
//     (no image downloads, no retries) until the outage window expires or a
//     fresh balance probe shows money again.
//   • checkAiAvailable() is the preflight the routes call before starting any
//     AI work, so a drained balance is reported up front, like Keepa tokens.

/** Thrown (and returned as a classified reason) when the AI provider cannot
 *  serve ANY request: exhausted balance, rejected key, retired model. */
export class AiUnavailableError extends Error {
  readonly code = "AI_UNAVAILABLE";
  constructor(readonly reason: string) {
    super(`AI unavailable — ${reason}`);
    this.name = "AiUnavailableError";
  }
  static isInstance(e: unknown): e is AiUnavailableError {
    return !!e && typeof e === "object" && (e as { code?: unknown }).code === "AI_UNAVAILABLE";
  }
}

/** How long a detected outage keeps short-circuiting calls. Long enough to
 *  stop a sweep from probing a dead account every chunk, short enough that a
 *  top-up is picked up within a couple of minutes without a redeploy. A fresh
 *  balance probe (checkAiAvailable({ fresh: true })) clears it immediately. */
const AI_OUTAGE_TTL_MS = 2 * 60_000;

let outage: { reason: string; at: number } | null = null;

export function noteAiOutage(reason: string): void {
  if (!outage) console.error(`[kimi] AI provider unavailable — ${reason}`);
  outage = { reason, at: Date.now() };
}

/** The active outage, or null when none was seen within the TTL. */
export function getAiOutage(): { reason: string; at: number } | null {
  if (outage && Date.now() - outage.at > AI_OUTAGE_TTL_MS) outage = null;
  return outage;
}

export function clearAiOutage(): void {
  outage = null;
}

// Moonshot's wording for a drained/suspended organization. A rate-limit 429
// says "rate limit" / "too many requests" and matches none of these.
const QUOTA_RE =
  /exceeded_current_quota|insufficient[ _]balance|is suspended|recharge your account|out of credit|current quota/i;
// A retired or mistyped model id — every call fails identically until the env
// var is fixed, so it is as fatal as a missing balance.
const MODEL_MISSING_RE = /not found the model|model[^.]*(not found|does not exist|permission denied)/i;

export type AiErrorInfo = {
  /** True when no retry can succeed: balance, auth, or model problem. */
  fatal: boolean;
  statusCode?: number;
  /** Short human-readable cause for notes, toasts and logs. */
  reason: string;
};

function compactReason(statusCode: number | undefined, text: string): string {
  const short = text.replace(/\s+/g, " ").trim().slice(0, 160);
  return `${statusCode ? `HTTP ${statusCode}: ` : ""}${short || "unknown error"}`;
}

/**
 * Classify a failed AI call. Unwraps the AI SDK's RetryError to the last real
 * API error, then decides whether the failure is fatal for the whole account.
 */
export function classifyAiError(err: unknown): AiErrorInfo {
  if (AiUnavailableError.isInstance(err)) return { fatal: true, reason: err.reason };

  type Shape = {
    statusCode?: number;
    status?: number;
    message?: string;
    responseBody?: string;
    lastError?: unknown;
    errors?: unknown[];
    data?: { error?: { type?: string; message?: string } };
  };
  let e = (err ?? {}) as Shape;
  // RetryError: "Failed after 3 attempts. Last error: …" — the real cause is the
  // last underlying APICallError.
  if (e.lastError) e = e.lastError as Shape;
  else if (Array.isArray(e.errors) && e.errors.length) e = e.errors[e.errors.length - 1] as Shape;
  if (AiUnavailableError.isInstance(e)) return { fatal: true, reason: e.reason };

  const statusCode = e.statusCode ?? e.status;
  const message = String(e.message ?? e.data?.error?.message ?? err ?? "");
  const body = String(e.responseBody ?? "");
  const haystack = `${message} ${body} ${e.data?.error?.type ?? ""}`;
  const reason = compactReason(statusCode, message || body);

  if (statusCode === 401 || statusCode === 402 || statusCode === 403) return { fatal: true, statusCode, reason };
  if (statusCode === 404 && /model/i.test(haystack)) return { fatal: true, statusCode, reason };
  if (QUOTA_RE.test(haystack)) return { fatal: true, statusCode, reason };
  if (MODEL_MISSING_RE.test(haystack)) return { fatal: true, statusCode, reason };
  return { fatal: false, statusCode, reason };
}

/** Request header the provider fetch turns into Moonshot's `thinking` body
 *  field (the AI SDK's OpenAI provider drops unknown providerOptions, so the
 *  flag travels as a header and is stripped before the request leaves). */
export const THINKING_HEADER = "x-mercato-thinking";

/**
 * Headers that switch hidden reasoning OFF for a call. Only kimi-k2.6 supports
 * non-thinking mode (k3 and k2.7-code reject the flag), so other models get no
 * header. Use it for short-answer calls such as the image MATCH/MISMATCH
 * verdict: with thinking on, that call burned its whole output budget on
 * reasoning and returned EMPTY text for more than half of the products
 * — billed at full output price, recorded as "No reason given".
 */
export function noThinkingHeaders(modelId: string): Record<string, string> {
  return /^kimi-k2\.6/.test(modelId) ? { [THINKING_HEADER]: "disabled" } : {};
}

/**
 * Provider fetch: outage short-circuit, thinking flag injection, and the
 * quota-429 → 402 rewrite that stops the AI SDK from retrying a dead account.
 * Exported for tests; the provider below is built with it.
 */
export function createMoonshotFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const active = getAiOutage();
    if (active) throw new AiUnavailableError(active.reason);

    let request = init;
    const headers = new Headers();
    const raw = init?.headers;
    if (raw instanceof Headers) raw.forEach((v, k) => headers.set(k, v));
    else if (Array.isArray(raw)) for (const [k, v] of raw) headers.set(k, v);
    else if (raw) for (const [k, v] of Object.entries(raw)) if (v != null) headers.set(k, String(v));

    const thinking = headers.get(THINKING_HEADER);
    if (thinking) {
      headers.delete(THINKING_HEADER);
      request = { ...init, headers };
      if (typeof init?.body === "string") {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          body.thinking = { type: thinking };
          request = { ...request, body: JSON.stringify(body) };
        } catch {
          /* not JSON — send unchanged */
        }
      }
    }

    const res = await base(input, request);
    if (res.status !== 429 && res.status !== 401 && res.status !== 403 && res.status !== 404) return res;

    // Read the error body once so it can be both classified and re-served.
    const text = await res.text().catch(() => "");
    const fatal =
      res.status === 429 ? QUOTA_RE.test(text)
      : res.status === 404 ? MODEL_MISSING_RE.test(text)
      : true; // 401 / 403
    if (fatal) noteAiOutage(compactReason(res.status, text));
    // A quota 429 is not a rate limit: re-serve it as 402 so the SDK's retry
    // logic (which retries every 429) gives up immediately.
    const status = res.status === 429 && fatal ? 402 : res.status;
    return new Response(text, {
      status,
      statusText: status === 402 ? "Payment Required" : res.statusText,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  };
}

const provider = createOpenAI({
  apiKey,
  baseURL,
  fetch: createMoonshotFetch(),
});

// ── Usage tracking ────────────────────────────────────────────────────────────
// Every AI feature funds itself from one Moonshot balance; when it drains, the
// failures surface as scattered "AI … failed" notes with no common cause. Each
// call's token usage is recorded here (per serverless instance) and logged, and
// the balance endpoint below serves the authoritative remaining money.

export type MoonshotUsage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  /** Epoch ms when this instance started counting. */
  since: number;
};

const usage: MoonshotUsage = { calls: 0, inputTokens: 0, outputTokens: 0, byModel: {}, since: Date.now() };

/** This instance's accumulated usage (serverless: per-instance, resets on cold start). */
export function getMoonshotUsage(): MoonshotUsage {
  return usage;
}

function recordUsage(modelId: string, u: unknown): void {
  const raw = (u ?? {}) as Record<string, unknown>;
  // v5+ names first, legacy names as fallback.
  const inp = Number(raw.inputTokens ?? raw.promptTokens ?? 0) || 0;
  const out = Number(raw.outputTokens ?? raw.completionTokens ?? 0) || 0;
  usage.calls++;
  usage.inputTokens += inp;
  usage.outputTokens += out;
  const m = (usage.byModel[modelId] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
  m.calls++;
  m.inputTokens += inp;
  m.outputTokens += out;
  console.log(
    `[kimi] ${modelId}: in=${inp} out=${out} tokens ` +
      `(instance total: ${usage.calls} calls, ${usage.inputTokens} in / ${usage.outputTokens} out)`,
  );
}

// Moonshot only implements the Chat Completions endpoint. The provider's default
// callable (provider(model)) targets the OpenAI Responses API and 404s against
// Moonshot, so every model MUST be created through .chat(). Wrapped with the
// usage recorder so every call in the app is tracked without touching callers.
export const moonshot = (modelId: string) =>
  wrapLanguageModel({
    model: provider.chat(modelId),
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        recordUsage(modelId, result.usage);
        return result;
      },
    },
  });

export const moonshotConfigured = (): boolean => Boolean(apiKey);

// ── Account balance ───────────────────────────────────────────────────────────

export type MoonshotBalance = {
  /** USD available to spend (cash + vouchers). 0 or negative = calls fail. */
  availableBalance: number | null;
  cashBalance: number | null;
  voucherBalance: number | null;
  timestamp: number;
};

let lastBalance: MoonshotBalance | null = null;

export function getLastMoonshotBalance(): MoonshotBalance | null {
  return lastBalance;
}

/** GET /users/me/balance on the platform. Free, small; failures return the last
 *  known snapshot rather than throwing (the sidebar must never break). */
export async function fetchMoonshotBalance(): Promise<MoonshotBalance | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${baseURL}/users/me/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return lastBalance;
    const json = (await res.json()) as {
      data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number };
    };
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    lastBalance = {
      availableBalance: num(json.data?.available_balance),
      cashBalance: num(json.data?.cash_balance),
      voucherBalance: num(json.data?.voucher_balance),
      timestamp: Date.now(),
    };
    return lastBalance;
  } catch {
    return lastBalance;
  }
}

export type AiAvailability = { ok: true } | { ok: false; reason: string };

/**
 * Preflight for any AI work: is the provider able to answer right now?
 *
 * Refuses when an outage was recorded recently or the balance is at or below
 * zero. The balance snapshot is reused for `maxAgeMs` (default 60 s) so a sweep
 * calling this every chunk costs one probe a minute; `fresh: true` forces a
 * live probe and lifts the outage marker when the account has money again
 * (the "Retry" button after a top-up). A failed probe does not block — the
 * per-call classification catches a real outage on the first request.
 */
export async function checkAiAvailable(opts?: { maxAgeMs?: number; fresh?: boolean }): Promise<AiAvailability> {
  if (!apiKey) return { ok: false, reason: "MOONSHOT_KEY is not configured" };
  const fresh = opts?.fresh ?? false;
  const maxAgeMs = opts?.maxAgeMs ?? 60_000;

  const active = getAiOutage();
  if (active && !fresh) return { ok: false, reason: active.reason };

  let bal = getLastMoonshotBalance();
  if (fresh || !bal || Date.now() - bal.timestamp > maxAgeMs) bal = await fetchMoonshotBalance();

  if (bal?.availableBalance != null && bal.availableBalance <= 0) {
    const reason =
      `Kimi (AI) balance is $${bal.availableBalance.toFixed(2)} — the Moonshot account is out of credit. ` +
      `Top up at platform.moonshot.ai and retry.`;
    noteAiOutage(reason);
    return { ok: false, reason };
  }
  if (bal?.availableBalance != null && bal.availableBalance > 0 && fresh) clearAiOutage();
  else if (active) return { ok: false, reason: active.reason };
  return { ok: true };
}

/**
 * Clamp a requested temperature to what the given model actually accepts.
 *
 * The newer Kimi models (kimi-k2.*, kimi-k3) reject anything other than
 * temperature 1 with `invalid temperature: only 1 is allowed for this model`,
 * while the moonshot-v1 line takes the usual 0-1 range. Callers ask for the
 * temperature the task wants; this makes that request safe regardless of which
 * model is configured, so swapping CATEGORIZE_MODEL can never turn every AI
 * call into a hard error.
 */
export function moonshotTemperature(modelId: string, desired: number): number {
  return /^kimi-k[23]/.test(modelId) ? 1 : desired;
}

// The moonshot-v1 line (moonshot-v1-auto, moonshot-v1-32k-vision-preview, …)
// was RETIRED from this account (~2026-08-28): every call 404s with "Not found
// the model … or Permission denied". The platform now serves the kimi-k line
// only (kimi-k2.6 / kimi-k3 / k2.7-code, per GET /models), and both k2.6 and
// k3 accept image input, so one general model covers text AND vision.
// kimi-k2.6 is the default (k3 is the pricier flagship — categorization pins
// it via CATEGORIZE_MODEL where the accuracy is worth it). Note these models
// only accept temperature 1 — callers go through moonshotTemperature().
export const MOONSHOT_TEXT_MODEL = process.env.MOONSHOT_MODEL ?? "kimi-k2.6";
export const MOONSHOT_VISION_MODEL =
  process.env.MOONSHOT_VISION_MODEL ?? "kimi-k2.6";
