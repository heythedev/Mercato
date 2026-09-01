import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";

/**
 * Moonshot AI (Kimi) — the single provider for every AI feature.
 *
 * Key: MOONSHOT_KEY (global platform, https://platform.moonshot.ai). KIMI_API_KEY
 * is accepted as a fallback for environments that still set the old name.
 */
const apiKey = process.env.MOONSHOT_KEY ?? process.env.KIMI_API_KEY ?? "";

const provider = createOpenAI({
  apiKey,
  baseURL: process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1",
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
    const base = process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";
    const res = await fetch(`${base}/users/me/balance`, {
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
