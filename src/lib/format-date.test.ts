import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime, formatDayMonth, formatYmd } from "./format-date";

describe("dates that survive hydration", () => {
  // The whole point of this module is that the output does NOT depend on the
  // machine's locale or timezone. Pinning exact strings is what makes that a
  // test rather than a hope: a bare toLocaleDateString() would render
  // "17/08/2026" here and "8/17/2026" in a US browser, which is precisely the
  // mismatch that made React discard the server tree on /admin/users.
  it("renders a timestamp the same way whatever the runtime locale is", () => {
    expect(formatDate("2026-08-17T00:00:00.000Z")).toBe("17 Aug 2026");
    expect(formatDate(new Date("2026-01-02T12:00:00.000Z"))).toBe("2 Jan 2026");
  });

  it("uses the house timezone, so a late-UTC timestamp is not the previous day", () => {
    // 2026-08-17T20:00Z is already the 18th in Asia/Kolkata (+05:30).
    expect(formatDate("2026-08-17T20:00:00.000Z")).toBe("18 Aug 2026");
  });

  it("formats a date and time without meridiem ambiguity", () => {
    expect(formatDateTime("2026-08-17T09:00:00.000Z")).toBe("17 Aug 2026, 14:30");
  });

  it("returns empty for an unparseable value rather than 'Invalid Date'", () => {
    expect(formatDate("not a date")).toBe("");
    expect(formatDateTime("")).toBe("");
  });
});

describe("calendar dates with no time and no zone", () => {
  it("reads the digits rather than parsing through Date", () => {
    // new Date("2026-08-17T00:00:00") parses in the runtime's LOCAL zone, so a
    // browser west of UTC would shift this to the 16th while the server kept
    // the 17th. Reading the parts removes the question entirely.
    expect(formatDayMonth("2026-08-17")).toBe("17 Aug");
    expect(formatDayMonth("2026-01-01")).toBe("1 Jan");
    expect(formatDayMonth("2026-12-31")).toBe("31 Dec");
  });

  it("renders the full date the same way", () => {
    expect(formatYmd("2026-09-21")).toBe("21 Sep 2026");
    expect(formatYmd("2026-01-01")).toBe("1 Jan 2026");
  });

  it("hands back anything it cannot read, instead of inventing a month", () => {
    expect(formatDayMonth("")).toBe("");
    expect(formatDayMonth("2026-13-01")).toBe("2026-13-01");
    expect(formatDayMonth("garbage")).toBe("garbage");
    expect(formatYmd("2026-00-10")).toBe("2026-00-10");
    expect(formatYmd("")).toBe("");
  });
});
