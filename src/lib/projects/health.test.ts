import { describe, expect, it } from "vitest";
import { EMPTY_HEALTH, healthBadges, pipelineSteps } from "./health";

describe("health badges on a project card", () => {
  it("flags shared UPCs first, whatever step the project is on", () => {
    const badges = healthBadges({ ...EMPTY_HEALTH, sharedUpc: 143, uncategorized: 2 }, "categorized", true);
    expect(badges[0]).toMatchObject({ tone: "critical", label: "143 products share a UPC" });
    expect(badges[1]).toMatchObject({ tone: "warning", label: "2 need a category" });
  });

  it("says nothing about categories before categorisation has run", () => {
    expect(healthBadges({ ...EMPTY_HEALTH, uncategorized: 159 }, "uploaded", true)).toEqual([]);
  });

  it("does not judge a project that is still running", () => {
    expect(healthBadges({ ...EMPTY_HEALTH, sharedUpc: 5 }, "categorizing", true)).toEqual([]);
  });

  it("only reports verify failures where the marketplace verifies", () => {
    const h = { ...EMPTY_HEALTH, verifyIssues: 3 };
    expect(healthBadges(h, "verified", false)[0]?.label).toBe("3 failed verify");
    expect(healthBadges(h, "categorized", true)[0]?.label).toBe("Ready to export");
  });

  it("calls a clean categorised project ready to export", () => {
    expect(healthBadges(EMPTY_HEALTH, "categorized", false)).toEqual([
      expect.objectContaining({ tone: "good", label: "Ready to export" }),
    ]);
  });

  it("shows at most two, and uses the singular for one", () => {
    const all = { uncategorized: 1, verifyIssues: 1, missingImage: 1, sharedUpc: 2 };
    const badges = healthBadges(all, "done", false);
    expect(badges).toHaveLength(2);
    expect(healthBadges({ ...EMPTY_HEALTH, missingImage: 1 }, "done", false)[0]?.label).toBe("1 has no photo");
  });
});

describe("the step bar", () => {
  it("has four steps where the marketplace verifies, three where it does not", () => {
    expect(pipelineSteps("uploaded", false).map((s) => s.name)).toEqual(["Upload", "Verify", "Categorize", "Export"]);
    expect(pipelineSteps("uploaded", true).map((s) => s.name)).toEqual(["Upload", "Categorize", "Export"]);
  });

  it("marks finished, running and next steps", () => {
    expect(pipelineSteps("categorizing", false).map((s) => s.state)).toEqual(["done", "done", "running", "todo"]);
    expect(pipelineSteps("categorized", true).map((s) => s.state)).toEqual(["done", "done", "current"]);
    expect(pipelineSteps("done", true).map((s) => s.state)).toEqual(["done", "done", "done"]);
  });
});
