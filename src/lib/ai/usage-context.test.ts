import { describe, it, expect } from "vitest";
import {
  currentAiContext,
  enterAiFeature,
  withAiContext,
  withAiFeature,
} from "./usage-context";

describe("AI usage attribution", () => {
  it("reports 'unknown' outside any context, so rows are never silently mis-attributed", () => {
    expect(currentAiContext().feature).toBe("unknown");
  });

  it("carries project and user down to nested async calls", async () => {
    await withAiContext({ feature: "categorize", projectId: "p1", userId: "u1" }, async () => {
      await Promise.resolve();
      const ctx = currentAiContext();
      expect(ctx).toEqual({ feature: "categorize", projectId: "p1", userId: "u1" });
    });
  });

  it("narrows the feature while keeping the surrounding attribution", async () => {
    await withAiContext({ feature: "verify_title", projectId: "p1", userId: "u1" }, async () => {
      await withAiFeature("verify_image", async () => {
        const ctx = currentAiContext();
        expect(ctx.feature).toBe("verify_image");
        // The whole point: an image call still has to be billed to its project.
        expect(ctx.projectId).toBe("p1");
        expect(ctx.userId).toBe("u1");
      });
      // …and the narrowing does not leak back out to the caller.
      expect(currentAiContext().feature).toBe("verify_title");
    });
  });

  it("keeps sibling contexts separate when runs overlap", async () => {
    // Two projects categorizing at once is the normal case (the run queue is
    // multi-project); their rows must not cross-contaminate.
    const seen: string[] = [];
    await Promise.all([
      withAiContext({ feature: "categorize", projectId: "a" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(currentAiContext().projectId!);
      }),
      withAiContext({ feature: "categorize", projectId: "b" }, async () => {
        seen.push(currentAiContext().projectId!);
      }),
    ]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("enterAiFeature narrows without a wrapping closure", async () => {
    await withAiContext({ feature: "export_dropdown", projectId: "p9" }, async () => {
      await (async () => {
        enterAiFeature("export_mandatory");
        expect(currentAiContext()).toMatchObject({ feature: "export_mandatory", projectId: "p9" });
      })();
    });
  });
});
