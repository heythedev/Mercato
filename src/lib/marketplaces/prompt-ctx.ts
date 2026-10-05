/**
 * What the prompt text may vary on, besides the marketplace itself.
 *
 * Its own module so prompt-registry.ts stays free of imports from the
 * categoriser, which would otherwise be a cycle.
 */
export type PromptCtx = {
  /**
   * Walmart runs in two modes. RICH when walmart_taxonomy_raw.json is present
   * and real "Category > Product Type Group" paths are available; FLAT when it
   * falls back to the 75 values the listing template's dropdown accepts. The
   * wording differs because the shape of a valid answer differs.
   */
  walmartRichMode: boolean;
};
