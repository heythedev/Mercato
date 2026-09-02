import { describe, it, expect, vi, beforeEach } from "vitest";

// The AI post-pass under a provider outage. On 2026-09-02 a drained Kimi
// balance was recorded as three "failed attempts" per product and then
// "Needs manual review" across ~7,000 rows that no model ever looked at. The
// rule now: a fatal (account-level) failure writes NOTHING and stops the run;
// rows closed that way earlier are re-queued and judged for real.

vi.mock("@/lib/keepa/cache", () => ({
  getCachedCodeLookups: vi.fn(async () => new Map()),
  getCachedCascadeFailures: vi.fn(async () => new Set()),
  getCachedProducts: vi.fn(async () => new Map()),
  cacheCodeLookup: vi.fn(async () => {}),
  cacheCodeLookups: vi.fn(async () => {}),
  cacheProducts: vi.fn(async () => {}),
  newCacheStats: vi.fn(() => ({})),
  logCacheStats: vi.fn(),
}));
vi.mock("@/lib/ai/moonshot", () => ({
  moonshotConfigured: () => true,
  getAiOutage: () => null,
  classifyAiError: (e: unknown) => ({ fatal: false, reason: String(e) }),
}));
const compareMock = vi.fn();
vi.mock("@/lib/ai/compare-images", () => ({
  compareVendorAgainstAllImagesBatch: (...args: unknown[]) => compareMock(...args),
}));

import { applyAiVerificationPasses, type VerifyResult } from "./verify";
import { isImageCheckPending, needsImageRequeue, requeueImageField } from "./image-check-state";

const FATAL = { verdict: "unsure", reason: "AI unavailable — Kimi (AI) balance is $0.00", retryable: true, fatal: true };

function pendingResult(
  id: string,
  note = "Images not compared — re-verify to run AI visual comparison.",
): VerifyResult {
  return {
    productId: id,
    status: "ok",
    liveData: { images: ["https://m.example/live.jpg"] },
    fields: [
      { field: "title", label: "Title", stored: "A", live: "A", match: true, severity: "ok" },
      {
        field: "images", label: "Images", stored: "https://v.example/cat.jpg", live: "https://m.example/p",
        match: false, severity: "warning", note, liveImage: "https://m.example/live.jpg",
      },
    ],
  } as VerifyResult;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const products = (ids: string[]) => ids.map((id) => ({ id, name: `Product ${id}` })) as any;
const imagesOf = (r: VerifyResult) => r.fields.find((f) => f.field === "images") as Record<string, unknown>;

describe("applyAiVerificationPasses under a provider outage", () => {
  beforeEach(() => compareMock.mockReset());

  it("leaves the row untouched when the call is fatal and reports the outage", async () => {
    compareMock.mockResolvedValue([FATAL]);
    const r = pendingResult("p1");
    const before = JSON.stringify(r.fields);
    const out = await applyAiVerificationPasses([r], products(["p1"]), "amazon", { onlyFlagged: true });
    expect(out.aiUnavailable).toMatch(/balance/);
    expect([...out.untouched]).toEqual(["p1"]);
    expect(JSON.stringify(r.fields)).toBe(before); // no attempt counted, no note, no severity
    expect(r.status).toBe("ok");
  });

  it("keeps real verdicts from the same wave and skips only the fatal ones", async () => {
    compareMock.mockResolvedValue([{ verdict: "match", reason: "same item" }, FATAL]);
    const a = pendingResult("a");
    const b = pendingResult("b");
    const out = await applyAiVerificationPasses([a, b], products(["a", "b"]), "amazon", { onlyFlagged: true });
    expect(imagesOf(a).severity).toBe("ok");
    expect(imagesOf(b).note).toMatch(/not compared/);
    expect([...out.untouched]).toEqual(["b"]);
    expect(out.aiUnavailable).toMatch(/balance/);
  });

  it("re-queues a row that was finalized during an earlier outage and judges it for real", async () => {
    compareMock.mockResolvedValue([{ verdict: "match", reason: "same brake pads" }]);
    const r = pendingResult(
      "p1",
      "Needs manual review — AI vision call failed (Failed after 3 attempts. Last error: Your account is suspended)",
    );
    imagesOf(r).aiAttempts = 3;
    r.status = "warning"; // the wrongly escalated status
    const out = await applyAiVerificationPasses([r], products(["p1"]), "amazon", { onlyFlagged: true });
    expect(compareMock).toHaveBeenCalledTimes(1);
    expect(out.aiUnavailable).toBeNull();
    expect(imagesOf(r).severity).toBe("ok");
    expect(imagesOf(r).note).toMatch(/images match/);
    expect(r.status).toBe("ok");
  });

  it("counts a transient failure as one attempt and keeps the row queued", async () => {
    compareMock.mockResolvedValue([
      { verdict: "unsure", reason: "AI vision call failed (HTTP 502: Bad gateway).", retryable: true },
    ]);
    const r = pendingResult("p1");
    const out = await applyAiVerificationPasses([r], products(["p1"]), "amazon", { onlyFlagged: true });
    expect(out.aiUnavailable).toBeNull();
    expect(imagesOf(r).aiAttempts).toBe(1);
    expect(imagesOf(r).note).toMatch(/not compared yet/);
    expect(r.status).toBe("ok"); // pending images stay soft
  });

  it("finalizes a genuine model UNSURE as manual review (not an outage)", async () => {
    compareMock.mockResolvedValue([{ verdict: "unsure", reason: "product not clearly visible" }]);
    const r = pendingResult("p1");
    const out = await applyAiVerificationPasses([r], products(["p1"]), "amazon", { onlyFlagged: true });
    expect(out.aiUnavailable).toBeNull();
    expect(imagesOf(r).note).toMatch(/^Needs manual review — product not clearly visible/);
    expect(needsImageRequeue(imagesOf(r))).toBe(false);
    expect(r.status).toBe("warning");
  });
});

describe("image-check-state predicates", () => {
  const base = { field: "images", stored: "https://v/cat.jpg", liveImage: "https://m/live.jpg" };

  it("recognizes pending, outage-closed and empty-answer rows as still pending", () => {
    expect(isImageCheckPending({ ...base, note: "Images not compared — re-verify" })).toBe(true);
    expect(isImageCheckPending({ ...base, note: "Needs manual review — AI vision call failed (HTTP 429)" })).toBe(true);
    expect(isImageCheckPending({ ...base, note: "Needs manual review — No reason given" })).toBe(true);
    expect(isImageCheckPending({ ...base, note: "Needs manual review — AI unavailable — balance is $0.00" })).toBe(true);
  });

  it("does not re-queue real verdicts, real UNSUREs or download failures", () => {
    expect(isImageCheckPending({ ...base, note: "AI visual check: images match — same item" })).toBe(false);
    expect(isImageCheckPending({ ...base, note: "Needs manual review — product not clearly visible" })).toBe(false);
    expect(isImageCheckPending({ ...base, note: "Needs manual review — Could not download the catalog image." })).toBe(false);
    expect(isImageCheckPending({ field: "images", stored: "", liveImage: "https://m/x.jpg", note: "not compared" })).toBe(false);
  });

  it("requeueImageField restores the marker, resets the budget and keeps the cause", () => {
    const f = { ...base, note: "Needs manual review — AI vision call failed (HTTP 402: account suspended)", aiAttempts: 3, severity: "warning" };
    const cause = requeueImageField(f);
    expect(cause).toBe("AI vision call failed (HTTP 402: account suspended)");
    expect(f.note).toMatch(/^Images not compared yet — the earlier AI check could not run \(AI vision call failed/);
    expect(f.aiAttempts).toBe(0);
    expect(needsImageRequeue(f)).toBe(false);
    expect(isImageCheckPending(f)).toBe(true);
  });
});
