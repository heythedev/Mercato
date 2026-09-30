import { z } from "zod";
import { prisma } from "@/lib/db";
import { canOperateProject, isAnyAdmin, type Actor } from "@/lib/authz";
import { defaultKey } from "@/lib/export/defaults";
import type { McpTool, ToolResult } from "./tools";

/**
 * Tools that change things, behind MCP_WRITE_ENABLED and off by default.
 *
 * Letting a language model edit a live catalogue is a decision a person makes
 * deliberately, having read what these do — not one that arrives with a
 * deploy. So the flag is off, the tools are not even listed until it is on,
 * and each of them is built to be reversible or to refuse.
 *
 * Three rules hold throughout:
 *
 *   1. Nothing here can do what the web app forbids. canOperateProject is
 *      owner-only — an admin may LOOK at someone's project but not start runs
 *      or edit rows in it, and that is enforced by the same function the UI
 *      calls, not a copy of its intent.
 *
 *   2. Every bulk change previews by default. `apply: true` is required to
 *      write, so "set the category for everything matching X" answers with
 *      what it WOULD touch until somebody confirms. A model that
 *      misunderstands a filter then costs a sentence, not a catalogue.
 *
 *   3. A change is capped. Beyond MAX_WRITE rows the tool refuses and says to
 *      narrow the filter — an instruction that would rewrite 60,000 products
 *      is more likely a mistake than a plan.
 */

const MAX_WRITE = 500;

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

export const WRITE_TOOLS: McpTool[] = [
  {
    name: "set_product_category",
    title: "Set a category",
    description:
      "Set the marketplace category on products in one project. Previews by default; pass apply=true to write. Only on projects you own.",
    schema: {
      projectId: z.string(),
      category: z.string().describe("The exact category path to set"),
      matchName: z.string().optional().describe("Only products whose name contains this"),
      onlyUncategorised: z.boolean().optional().describe("Only products with no category yet"),
      apply: z.boolean().optional().describe("false (default) previews; true writes"),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      // Owner-only, exactly as in the browser: editing someone's catalogue
      // under their name is not something an admin should do by accident.
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only change projects you own." });
      }

      const where = {
        projectId: id,
        ...(a.matchName ? { name: { contains: String(a.matchName), mode: "insensitive" as const } } : {}),
        ...(a.onlyUncategorised
          ? { OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] }
          : {}),
      };

      const count = await prisma.product.count({ where });
      if (count === 0) return ok({ matched: 0, note: "Nothing matched — no change made." });
      if (count > MAX_WRITE) {
        return ok({
          error: `${count} products matched, over the ${MAX_WRITE} limit. Narrow the filter.`,
          matched: count,
        });
      }

      const sample = await prisma.product.findMany({
        where,
        select: { name: true, vendorSku: true, marketplaceCategory: true },
        take: 10,
      });

      if (a.apply !== true) {
        return ok({
          preview: true,
          wouldChange: count,
          to: String(a.category),
          sample,
          note: "Nothing was written. Call again with apply=true to make this change.",
        });
      }

      const res = await prisma.product.updateMany({
        where,
        data: { marketplaceCategory: String(a.category) },
      });
      return ok({ changed: res.count, to: String(a.category), project: project.name });
    },
  },

  {
    name: "set_export_default",
    title: "Set an export default",
    description:
      "Set a fixed value for a required column no data source can answer — Proposition 65, PFAS, embedded battery. Applies to every export for that marketplace.",
    schema: {
      marketplace: z.string().describe("e.g. bestbuy, mathis"),
      attribute: z.string().describe("Column name or field code, e.g. californiaProposition65Warning.type"),
      value: z.string().describe("The value to write. Empty string clears it."),
    },
    async run(actor: Actor, a) {
      // A declaration applies to everything a team exports, so this is not a
      // per-project edit and an ordinary member should not make it.
      if (!isAnyAdmin(actor)) {
        return ok({ error: "Admins only — an export default applies to every project." });
      }
      const marketplace = String(a.marketplace).toLowerCase();
      const attribute = defaultKey(String(a.attribute));
      const value = String(a.value ?? "");

      // These are legal statements the seller makes. Recording WHO set one
      // and when is the point of doing it here rather than in a config file.
      const existing = await prisma.exportDefault.findFirst({
        where: { marketplace, attribute, teamId: actor.teamId ?? null },
        select: { id: true, value: true },
      });

      if (existing) {
        await prisma.exportDefault.update({ where: { id: existing.id }, data: { value } });
        return ok({ updated: true, marketplace, attribute, from: existing.value, to: value });
      }
      await prisma.exportDefault.create({
        data: { marketplace, attribute, value, teamId: actor.teamId ?? null },
      });
      return ok({ created: true, marketplace, attribute, value });
    },
  },

  {
    name: "rename_project",
    title: "Rename a project",
    description: "Change a project's name. Only projects you own.",
    schema: { projectId: z.string(), name: z.string().min(1).max(120) },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only rename projects you own." });
      }
      const name = String(a.name).trim().slice(0, 120);
      if (!name) return ok({ error: "A name is required." });
      await prisma.project.update({ where: { id }, data: { name } });
      return ok({ renamed: true, from: project.name, to: name });
    },
  },

  {
    name: "clear_product_field",
    title: "Clear a wrong value",
    description:
      "Blank a field that holds something wrong — a fabricated barcode, a bad category. Previews by default. An empty cell is correctable; a wrong one ships.",
    schema: {
      projectId: z.string(),
      field: z.enum(["upc", "brand", "marketplaceCategory", "imageUrl"]),
      matchName: z.string().optional(),
      apply: z.boolean().optional(),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only change projects you own." });
      }

      const field = String(a.field) as "upc" | "brand" | "marketplaceCategory" | "imageUrl";
      const where = {
        projectId: id,
        ...(a.matchName ? { name: { contains: String(a.matchName), mode: "insensitive" as const } } : {}),
        NOT: { [field]: null },
      };

      const count = await prisma.product.count({ where });
      if (count === 0) return ok({ matched: 0, note: "Nothing to clear." });
      if (count > MAX_WRITE) {
        return ok({ error: `${count} products matched, over the ${MAX_WRITE} limit.`, matched: count });
      }
      if (a.apply !== true) {
        return ok({ preview: true, wouldClear: count, field, note: "Call again with apply=true." });
      }
      const res = await prisma.product.updateMany({ where, data: { [field]: null } });
      return ok({ cleared: res.count, field, project: project.name });
    },
  },

];
