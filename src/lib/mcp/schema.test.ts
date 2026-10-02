import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS, type McpTool } from "./tools";
import { WRITE_TOOLS } from "./write-tools";

/**
 * The contract, not the handler.
 *
 * Every tool was tested by calling it with well-formed arguments. None of
 * them tested the SCHEMA those arguments are published under — and that is
 * where the bug was. toJsonSchema branched on `_def.typeName`, a Zod 3 field;
 * this project is on Zod 4, where it is `_def.type`. Every lookup returned
 * undefined, so all sixteen non-string arguments across eleven tools were
 * advertised as "string".
 *
 * A client reads that schema and believes it. For numbers and booleans it
 * mostly survived — "40" becomes 40 soon enough. For submit_categorization
 * it was fatal: told `assignments` was a string, a real client sent a
 * string, and Array.isArray dropped it. The tool could not be used by
 * anything except a test that bypassed its own published contract.
 *
 * So these tests compare what is PUBLISHED against what is DECLARED, for
 * every tool, and will fail the next time the two part company.
 */

const ALL: McpTool[] = [...TOOLS, ...WRITE_TOOLS];

/** The same conversion the route performs. */
const published = (t: McpTool) =>
  z.toJSONSchema(z.object(t.schema), { io: "input" }) as {
    type: string;
    properties: Record<string, { type?: string; enum?: unknown[]; items?: unknown; anyOf?: unknown[] }>;
    required?: string[];
  };

/** Zod's own name for a field, unwrapping optional/default wrappers. */
function declaredType(v: unknown): string {
  const def = (v as { _def: { type?: string; innerType?: unknown } })._def;
  return def.innerType ? declaredType(def.innerType) : (def.type ?? "unknown");
}

/**
 * What each Zod type may legitimately publish as. A list rather than a single
 * value because `z.number().int()` correctly becomes "integer", not "number"
 * — a stricter answer, and one the hand-rolled version could never have
 * produced.
 */
const ZOD_TO_JSON: Record<string, string[]> = {
  string: ["string"],
  number: ["number", "integer"],
  boolean: ["boolean"],
  enum: ["string"],
  array: ["array"],
  object: ["object"],
};

/** True when Zod would accept the field being absent. */
function isOptional(v: unknown): boolean {
  const def = (v as { _def: { type?: string } })._def;
  return def.type === "optional" || def.type === "default" || def.type === "nullable";
}

describe("every tool publishes the types it actually declares", () => {
  for (const tool of ALL) {
    it(tool.name, () => {
      const schema = published(tool);
      expect(schema.type).toBe("object");

      for (const [key, zodField] of Object.entries(tool.schema)) {
        const want = ZOD_TO_JSON[declaredType(zodField)];
        const got = schema.properties[key];
        expect(got, `${tool.name}.${key} missing from the published schema`).toBeDefined();

        // An optional field may be published as anyOf[...] rather than a bare
        // type; either is valid JSON Schema, so accept both and look inside.
        const types = got.type
          ? [got.type]
          : (got.anyOf ?? []).map((v) => (v as { type?: string }).type).filter(Boolean);
        expect(
          want.some((w) => types.includes(w)),
          `${tool.name}.${key} should be one of ${want.join("/")}, published as ${JSON.stringify(got)}`,
        ).toBe(true);
      }
    });
  }
});

describe("the field that was actually broken", () => {
  const submit = ALL.find((t) => t.name === "submit_categorization")!;

  it("assignments is an array, not a string", () => {
    // The whole bug in one assertion. A client told "string" sends a string,
    // and the handler's Array.isArray drops it with "No assignments given".
    const p = published(submit).properties.assignments as { type?: string; items?: unknown };
    expect(p.type).toBe("array");
    expect(p.items).toBeDefined();
  });

  it("and its items say what each entry must contain", () => {
    const items = (published(submit).properties.assignments as { items: { properties?: Record<string, unknown>; required?: string[] } }).items;
    expect(Object.keys(items.properties ?? {}).sort()).toEqual(["category", "confidence", "productId"]);
    // A client that omits either of these cannot write anything useful, so
    // the schema has to say they are not optional.
    expect(items.required).toContain("productId");
    expect(items.required).toContain("category");
  });
});

describe("the types that silently degraded", () => {
  const find = (name: string) => ALL.find((t) => t.name === name)!;

  it("numbers are numbers, with their bounds", () => {
    // And better than the old version could manage: z.number().int().min().max()
    // publishes as integer with minimum and maximum, so a client knows the
    // range before it guesses one.
    expect(published(find("list_projects")).properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
    });
  });

  it("booleans are booleans", () => {
    const p = published(find("run_categorization")).properties.force;
    expect(p.type ?? (p.anyOf as { type: string }[])?.map((x) => x.type)).toContain("boolean");
  });

  it("enums publish their options, so a client cannot guess wrong", () => {
    const p = published(find("verification_issues")).properties.verdict as { enum?: unknown[]; anyOf?: { enum?: unknown[] }[] };
    const values = p.enum ?? p.anyOf?.find((x) => x.enum)?.enum ?? [];
    expect(values).toEqual(expect.arrayContaining(["warning", "mismatch", "not_found", "discontinued"]));
  });

  it("required means required, and optional means optional", () => {
    // A mandatory field missing from `required` lets a client call with
    // nothing; an optional one listed there makes a client send a value it
    // does not have. Both are checked against what Zod actually declares,
    // for every argument of every tool, rather than against an assumption —
    // find_products.projectId is genuinely optional, which is how the first
    // version of this test went wrong.
    for (const t of ALL) {
      const req = published(t).required ?? [];
      for (const [key, field] of Object.entries(t.schema)) {
        if (isOptional(field)) {
          expect(req, `${t.name}.${key} is optional`).not.toContain(key);
        } else {
          expect(req, `${t.name}.${key} is mandatory`).toContain(key);
        }
      }
    }
  });
});
