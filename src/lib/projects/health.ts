/**
 * What a project card says about the products inside it.
 *
 * The status chip says which step a project is on; it says nothing about
 * whether the work done so far is any good. hahaz sat at "Categorized" with
 * 143 of its 159 products sharing one UPC — Excel had saved the column as a
 * number — and nothing on the projects page hinted at it. These counts are
 * the few problems that are cheap to count across every project at once and
 * that a person would want to know about before opening one.
 *
 * Kept free of React and the database so the rules can be tested as rules.
 */

export type ProjectHealth = {
  /** Products with no category, or the "Uncategorized" placeholder. */
  uncategorized: number;
  /** Products verification could not match (mismatch / not_found). */
  verifyIssues: number;
  /** Products with no image URL. */
  missingImage: number;
  /** Products whose UPC is shared with at least one other product. */
  sharedUpc: number;
};

export const EMPTY_HEALTH: ProjectHealth = { uncategorized: 0, verifyIssues: 0, missingImage: 0, sharedUpc: 0 };

export type HealthBadge = {
  tone: "critical" | "warning" | "good";
  label: string;
  /** A sentence for the tooltip: what it means and what to do about it. */
  hint: string;
};

/** Statuses that mean work is in flight — a running project is not judged. */
const RUNNING = new Set(["uploading", "verifying", "categorizing", "exporting"]);

/** How far through the pipeline a status is, so a check only fires once its step has run. */
const STAGE: Record<string, number> = {
  uploading: 0, uploaded: 1, verifying: 1, verified: 2, categorizing: 2, categorized: 3, exporting: 3, done: 4,
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The badges for one card, most serious first, at most `limit` of them.
 *
 * A count is only reported once the step that would have fixed it has run:
 * before categorisation every product is uncategorised, and saying so on a
 * fresh upload is noise rather than news.
 */
export function healthBadges(
  health: ProjectHealth,
  status: string,
  skipsVerify: boolean,
  limit = 2,
): HealthBadge[] {
  if (RUNNING.has(status)) return [];
  const stage = STAGE[status] ?? 0;
  const out: HealthBadge[] = [];

  if (health.sharedUpc > 0) {
    out.push({
      tone: "critical",
      label: `${plural(health.sharedUpc, "product shares", "products share")} a UPC`,
      hint: "Usually a UPC column Excel saved as a number. Re-upload the vendor file with that column formatted as text.",
    });
  }
  if (!skipsVerify && stage >= 2 && health.verifyIssues > 0) {
    out.push({
      tone: "warning",
      label: `${plural(health.verifyIssues, "failed", "failed")} verify`,
      hint: "Products the marketplace lookup could not match. Open the project's Verify step to review them.",
    });
  }
  if (stage >= 3 && health.uncategorized > 0) {
    out.push({
      tone: "warning",
      label: `${plural(health.uncategorized, "needs", "need")} a category`,
      hint: "These products are left out of the marketplace files. Open the Categorize step to assign them.",
    });
  }
  if (stage >= 3 && health.missingImage > 0) {
    out.push({
      tone: "warning",
      label: `${plural(health.missingImage, "has", "have")} no photo`,
      hint: "Most marketplaces reject a listing without an image.",
    });
  }

  if (out.length === 0 && status === "categorized") {
    out.push({ tone: "good", label: "Ready to export", hint: "Every product is categorised and nothing needs attention." });
  }
  return out.slice(0, limit);
}

export type StepState = "done" | "running" | "current" | "todo";

/**
 * The pipeline as segments for the card's step bar: one per step this
 * marketplace actually has, each done, running, current (next to do) or todo.
 */
export function pipelineSteps(status: string, skipsVerify: boolean): { name: string; state: StepState }[] {
  const names = skipsVerify ? ["Upload", "Categorize", "Export"] : ["Upload", "Verify", "Categorize", "Export"];
  // Index of the step a status belongs to, and whether that step is finished.
  const at: Record<string, [string, "done" | "running"]> = {
    uploading: ["Upload", "running"], uploaded: ["Upload", "done"],
    verifying: ["Verify", "running"], verified: ["Verify", "done"],
    categorizing: ["Categorize", "running"], categorized: ["Categorize", "done"],
    exporting: ["Export", "running"], done: ["Export", "done"],
  };
  const [stepName, phase] = at[status] ?? ["Upload", "running"];
  // A skip-verify marketplace never really sits at a Verify status; treat it
  // as the upload being finished.
  const idx = Math.max(0, names.indexOf(stepName === "Verify" && skipsVerify ? "Upload" : stepName));
  return names.map((name, i) => {
    if (i < idx) return { name, state: "done" };
    if (i === idx) return { name, state: phase === "running" ? "running" : "done" };
    return { name, state: i === idx + 1 && phase === "done" ? "current" : "todo" };
  });
}
