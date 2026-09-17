import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which feature is spending the AI balance, and on whose behalf.
 *
 * Every Moonshot call in the app funnels through recordUsage() in moonshot.ts,
 * which sees the model and the token counts but has no idea WHY the call
 * happened — and "why" is the whole question when a balance drains. The route
 * handler knows; the model wrapper does not. AsyncLocalStorage carries that
 * knowledge down without threading a parameter through every call site.
 *
 * Routes set the project/user once (withAiContext) and individual call sites
 * narrow the feature (withAiFeature) where one route spends on several paths —
 * verification, for instance, makes both an image call and a title call per
 * product, and they cost very different amounts.
 */
export type AiFeature =
  | "categorize"
  | "spec_product_type"
  | "verify_image"
  | "verify_title"
  | "export_dropdown"
  | "export_mandatory"
  | "generate_title"
  | "template_detect"
  | "compare_images"
  | "unknown";

export type AiContext = {
  feature: AiFeature;
  projectId?: string;
  userId?: string;
};

const store = new AsyncLocalStorage<AiContext>();

/** Run `fn` with the given attribution attached to every AI call it makes. */
export function withAiContext<T>(ctx: AiContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

/**
 * Attach attribution to the rest of the current request without wrapping its
 * body in a closure. Route handlers call this once, right after the auth guard;
 * every AI call they go on to make inherits it.
 */
export function enterAiContext(ctx: AiContext): void {
  store.enterWith(ctx);
}

/** Narrow just the feature, keeping the surrounding project/user attribution. */
export function withAiFeature<T>(feature: AiFeature, fn: () => Promise<T>): Promise<T> {
  const current = store.getStore();
  return store.run({ ...current, feature }, fn);
}

/**
 * Narrow the feature for the rest of the current async flow, keeping whatever
 * project/user the route established. Library entry points call this so a
 * feature is attributed correctly however it was reached — including from the
 * one-off scripts in scripts/, which have no route to set a context at all.
 */
export function enterAiFeature(feature: AiFeature): void {
  store.enterWith({ ...currentAiContext(), feature });
}

/** Attribution for the call being made right now; "unknown" outside any context. */
export function currentAiContext(): AiContext {
  return store.getStore() ?? { feature: "unknown" };
}
