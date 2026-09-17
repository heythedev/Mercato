/**
 * Token prices, used to turn recorded tokens into an estimated dollar figure.
 *
 * These are NOT authoritative. Moonshot publishes rates on the platform and
 * changes them; the tokens in AiUsage are the measured fact, the dollars here
 * are the measured fact multiplied by whatever rate is configured. Set the real
 * numbers from the billing page via env and every figure in the admin report
 * becomes exact:
 *
 *   KIMI_PRICE_INPUT_PER_M=0.60
 *   KIMI_PRICE_OUTPUT_PER_M=2.50
 *   KIMI_PRICE_VISION_INPUT_PER_M=1.20   # optional, vision models bill separately
 *
 * The defaults below are order-of-magnitude placeholders so the column is never
 * blank; the admin page says so on the page itself rather than presenting them
 * as fact.
 */

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const INPUT_PER_M = num(process.env.KIMI_PRICE_INPUT_PER_M, 0.6);
const OUTPUT_PER_M = num(process.env.KIMI_PRICE_OUTPUT_PER_M, 2.5);
const VISION_INPUT_PER_M = num(process.env.KIMI_PRICE_VISION_INPUT_PER_M, INPUT_PER_M);

/** True when rates came from the environment rather than the placeholders. */
export const pricesConfigured = Boolean(
  process.env.KIMI_PRICE_INPUT_PER_M && process.env.KIMI_PRICE_OUTPUT_PER_M,
);

export function pricePerMillion(model: string): { input: number; output: number } {
  const isVision = /vision|vl\b/i.test(model);
  return { input: isVision ? VISION_INPUT_PER_M : INPUT_PER_M, output: OUTPUT_PER_M };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const { input, output } = pricePerMillion(model);
  return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
}
