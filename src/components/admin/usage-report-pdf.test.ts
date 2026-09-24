import { describe, expect, it } from "vitest";

/**
 * The report document actually renders.
 *
 * A PDF is not HTML: @react-pdf/renderer has its own layout engine and its own
 * (much smaller) style vocabulary, so a document can typecheck perfectly and
 * still throw at render time on a property the engine does not implement, or a
 * percentage where it wants a number. Nothing else in the suite would catch
 * that — the page renders it in the browser, at which point the admin sees the
 * failure instead of the report.
 *
 * So this renders the real document to real bytes and checks they are a PDF.
 */

async function render(data: unknown): Promise<Buffer> {
  const [{ renderToBuffer }, React, { UsageReportDoc }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("react"),
    import("./usage-report-pdf"),
  ]);
  const el = React.createElement(UsageReportDoc, { data } as never);
  return renderToBuffer(el as never);
}

const row = (over: Record<string, unknown> = {}) => ({
  calls: 120, input: 4200, output: 240, units: 0, failed: 0, estCostUsd: 1.25, ...over,
});

const FULL = {
  days: 30,
  since: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  actualSpendUsd: 90.21,
  actualByDay: {},
  balanceReadings: 44,
  teamScoped: false,
  byDay: [
    { day: "2026-09-23", service: "kimi", ...row() },
    { day: "2026-09-23", service: "keepa", ...row({ units: 500, input: 0, output: 0 }) },
    { day: "2026-09-24", service: "kimi", ...row({ failed: 31 }) },
  ],
  byService: [
    { service: "kimi", ...row({ calls: 10371, failed: 993 }) },
    { service: "keepa", ...row({ calls: 9545, units: 99776, input: 0, output: 0 }) },
    { service: "synccentric", ...row({ calls: 2246, units: 49621, input: 0, output: 0 }) },
  ],
  byFeature: [
    { service: "kimi", feature: "verify_image", ...row({ calls: 8705, input: 36_000_000 }) },
    { service: "kimi", feature: "export_dropdown", ...row({ calls: 1422, failed: 972 }) },
  ],
  byProject: [{ projectId: "abc12345", name: "BestBuy-Project2", ...row() }],
  byModel: [{ model: "kimi-k2.6", ...row() }],
};

describe("the usage report PDF", () => {
  it("renders a real PDF from a full dataset", async () => {
    const buf = await render(FULL);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    // Two A4 pages of content, not an empty shell.
    expect(buf.length).toBeGreaterThan(3000);
  }, 30_000);

  it("renders when the account has no measured spend yet", async () => {
    // Under two balance readings the dollar figure falls back to the token
    // estimate, and the wording changes with it — a separate branch.
    const buf = await render({ ...FULL, actualSpendUsd: null, balanceReadings: 1 });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  }, 30_000);

  it("renders an empty period without dividing by zero", async () => {
    // A 24-hour window on a quiet day: no calls, no features, no projects. The
    // chart's peak, the per-active-day average and the failure share are all
    // divisions that have no denominator here.
    const buf = await render({
      ...FULL, days: 1, actualSpendUsd: null,
      byDay: [], byService: [], byFeature: [], byProject: [], byModel: [],
    });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  }, 30_000);

  it("renders a 90-day window — one column per day, all on one axis", async () => {
    const byDay = Array.from({ length: 90 }, (_, i) => ({
      day: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
      service: "kimi",
      ...row(),
    }));
    const buf = await render({ ...FULL, days: 90, byDay });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  }, 30_000);
});
