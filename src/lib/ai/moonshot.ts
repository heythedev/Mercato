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

// moonshot-v1-auto picks the 8k/32k/128k tier per request, so prompts of any
// size fit and are billed at the smallest tier that holds them.
export const MOONSHOT_TEXT_MODEL = process.env.MOONSHOT_MODEL ?? "moonshot-v1-auto";
export const MOONSHOT_VISION_MODEL =
  process.env.MOONSHOT_VISION_MODEL ?? "moonshot-v1-32k-vision-preview";
