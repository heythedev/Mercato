import { createOpenAI } from "@ai-sdk/openai";

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

// Moonshot only implements the Chat Completions endpoint. The provider's default
// callable (provider(model)) targets the OpenAI Responses API and 404s against
// Moonshot, so every model MUST be created through .chat().
export const moonshot = (modelId: string) => provider.chat(modelId);

export const moonshotConfigured = (): boolean => Boolean(apiKey);

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
