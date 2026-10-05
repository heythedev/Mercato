import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WRITE_TOOLS } from "./write-tools";

// A spreadsheet was deliberately kept out of tool arguments: an .xlsx is a zip,
// one wrong character corrupts the archive, and the damage surfaces later as a
// parse failure nobody can explain. The upload LINK exists for that reason.
//
// But a client whose sandbox blocks outbound requests cannot follow a link —
// it answers 403 — while the MCP connection it is already talking over works
// fine. So the bytes may come through the argument after all, on one
// condition: a checksum, so a mis-sent file is refused rather than parsed into
// a half-broken project.

const tool = WRITE_TOOLS.find((t) => t.name === "send_project_file")!;

describe("send_project_file", () => {
  it("is offered, and asks for the checksum alongside the bytes", () => {
    expect(tool).toBeDefined();
    for (const field of ["name", "marketplace", "filename", "contentBase64", "sha256"]) {
      expect(Object.keys(tool.schema), field).toContain(field);
    }
  });

  it("tells the caller why it exists, so it is reached for at the right moment", () => {
    // The description is what a model reads when the link has just failed.
    expect(tool.description).toMatch(/403|egress|sandbox/i);
  });

  it("names the checksum of the RAW bytes, not of the base64", () => {
    // Hashing the encoded text instead of the file is the obvious mistake, and
    // it would reject every correct upload. Read off the published schema, so
    // the wording a client actually sees is what is pinned.
    const published = z.toJSONSchema(z.object(tool.schema), { io: "input" }) as {
      properties?: Record<string, { description?: string }>;
    };
    expect(published.properties?.sha256?.description).toMatch(/raw/i);
  });
});

describe("the checksum that makes it safe", () => {
  // The guard the tool applies, stated here so the property is pinned
  // independently of the handler: a single altered character must not match.
  const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  it("a file that arrives intact matches", () => {
    const bytes = Buffer.from("PK\u0003\u0004 pretend this is a workbook", "utf8");
    const sent = Buffer.from(bytes.toString("base64"), "base64");
    expect(digest(sent)).toBe(digest(bytes));
  });

  it("one wrong character does not", () => {
    const bytes = Buffer.from("PK\u0003\u0004 pretend this is a workbook", "utf8");
    const b64 = bytes.toString("base64");
    const corrupted = b64.slice(0, 5) + (b64[5] === "A" ? "B" : "A") + b64.slice(6);
    expect(digest(Buffer.from(corrupted, "base64"))).not.toBe(digest(bytes));
  });

  it("truncation does not", () => {
    const bytes = Buffer.from("PK\u0003\u0004 a longer pretend workbook body", "utf8");
    const short = Buffer.from(bytes.toString("base64").slice(0, 20), "base64");
    expect(digest(short)).not.toBe(digest(bytes));
  });
});
