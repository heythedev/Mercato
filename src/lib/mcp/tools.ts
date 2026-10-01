import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  adminUserIds,
  canOperateProject,
  canReadProject,
  isAnyAdmin,
  projectListScope,
  templateOwnerIds,
  templateVisibilityOr,
  type Actor,
} from "@/lib/authz";
import {
  INLINE_TAXONOMY_MAX,
  categoryIndex,
  nextSegments,
} from "@/lib/categorize/taxonomy";

/**
 * What Claude may do in Mercato, on behalf of one person.
 *
 * Every tool takes an `actor` and routes through the same helpers the web app
 * uses — projectListScope, canReadProject, templateVisibilityOr. Not similar
 * rules: the same functions. If a member cannot see a colleague's template in
 * the browser, the tool cannot fetch it either, and neither can drift from
 * the other, because there is only one implementation to drift from.
 *
 * Read-only, deliberately. Write tools are worth having — setting a category
 * across a filtered set, entering the three compliance declarations — but
 * they should be shaped by what people actually reach for, and nobody has
 * reached for anything yet. Adding them later is easy; withdrawing one that
 * turned out to be dangerous is not.
 */

export type ToolResult = { content: { type: "text"; text: string }[] };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

/** Caps exist so a tool cannot return a reply nothing can read. */
const MAX_ROWS = 200;

export type McpTool = {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  run: (actor: Actor, args: Record<string, unknown>) => Promise<ToolResult>;
};

/**
 * How many products one categorisation batch hands over.
 *
 * Small enough that the whole batch plus the taxonomy is readable in one go,
 * large enough that a 4,811-product catalogue is tens of calls rather than
 * hundreds. The caller loops until nothing is left, exactly as the export's
 * client does.
 */
const CATEGORIZE_BATCH = 40;
const CATEGORIZE_BATCH_MAX = 100;

/** A few vendor attributes, small enough not to crowd out the taxonomy. */
function vendorHints(vendorData: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vendorData || typeof vendorData !== "object") return out;
  for (const [k, v] of Object.entries(vendorData as Record<string, unknown>)) {
    if (Object.keys(out).length >= 8) break;
    if (v == null) continue;
    const s = String(v).trim();
    if (!s || s.length > 120) continue;
    out[k] = s;
  }
  return out;
}

export const TOOLS: McpTool[] = [
  {
    name: "next_categorization_batch",
    title: "Next products to categorise",
    description:
      "Hand over the next batch of uncategorised products together with the marketplace's valid category list. " +
      "Choose one EXACT path from that list per product, then call submit_categorization. Repeat until remaining is 0.",
    schema: {
      projectId: z.string(),
      limit: z.number().optional().describe(`Products to return (default ${CATEGORIZE_BATCH})`),
      categoryPrefix: z
        .string()
        .optional()
        .describe("For large taxonomies only: drill into this path to see the next level"),
      includeTaxonomy: z
        .boolean()
        .optional()
        .describe("Default true. Pass false once you have the list — it does not change between batches."),
    },
    async run(actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, marketplace: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      // Owner-only, like the write half. Handing someone a batch of work they
      // would then be refused permission to submit is a dead end, not a
      // courtesy.
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only categorise projects you own." });
      }

      const index = categoryIndex(project.marketplace);
      if (!index) {
        return ok({
          error: `No category list is available for ${project.marketplace}, so nothing could be checked against one. Categorise this project in Mercato instead.`,
        });
      }

      const uncategorised = {
        projectId: id,
        OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }],
      };
      const [total, remaining, rows] = await Promise.all([
        prisma.product.count({ where: { projectId: id } }),
        prisma.product.count({ where: uncategorised }),
        prisma.product.findMany({
          where: uncategorised,
          select: { id: true, name: true, brand: true, vendorSku: true, description: true, vendorData: true },
          orderBy: { id: "asc" },
          take: Math.min(Number(a.limit ?? CATEGORIZE_BATCH), CATEGORIZE_BATCH_MAX),
        }),
      ]);

      // Big taxonomies are drilled into a level at a time. Walmart's 5,242
      // paths would otherwise crowd out the products they are meant to
      // classify — and truncating the list would mean offering a choice that
      // silently excludes the right answer.
      // The list is identical on every call, and Best Buy's is 1,450 paths —
      // roughly 90KB. Repeating that down a hundred batches is most of the
      // conversation spent re-reading something that has not changed.
      const want = a.includeTaxonomy !== false;
      const inline = index.paths.length <= INLINE_TAXONOMY_MAX;
      const taxonomy = !want
        ? { mode: "omitted" as const, count: index.paths.length, note: "Asked for; use the list from an earlier call." }
        : inline
        ? { mode: "full" as const, count: index.paths.length, paths: index.paths }
        : {
            mode: "drill" as const,
            count: index.paths.length,
            prefix: String(a.categoryPrefix ?? "") || null,
            options: nextSegments(index.paths, a.categoryPrefix ? String(a.categoryPrefix) : undefined),
            note: "Too large to list. Call again with categoryPrefix set to one of these to see the next level, until you reach full paths.",
          };

      return ok({
        project: { id: project.id, name: project.name, marketplace: project.marketplace },
        progress: { total, categorised: total - remaining, remaining },
        taxonomy,
        products: rows.map((p) => ({
          productId: p.id,
          name: p.name,
          brand: p.brand,
          sku: p.vendorSku,
          description: p.description ? p.description.slice(0, 300) : null,
          attributes: vendorHints(p.vendorData),
        })),
        instructions:
          "Pick one path per product, copied EXACTLY from the list above — anything not in it is refused, " +
          "and a shortened path would quietly route the product into the wrong export file. " +
          "Include a confidence 0-1; use a low one rather than guessing, and those rows stay flagged for review. " +
          "Then call submit_categorization and request the next batch.",
      });
    },
  },

  {
    name: "list_projects",
    title: "List projects",
    description:
      "Projects you can see, newest first. A member sees their own; a team admin sees their team's; the super admin sees all.",
    schema: {
      status: z.string().optional().describe("Filter by status, e.g. done, categorized, exporting"),
      marketplace: z.string().optional().describe("Filter by marketplace, e.g. mathis, bestbuy"),
      search: z.string().optional().describe("Match part of the project name"),
      limit: z.number().int().min(1).max(MAX_ROWS).optional(),
    },
    async run(actor, a) {
      const rows = await prisma.project.findMany({
        where: {
          ...projectListScope(actor),
          ...(a.status ? { status: String(a.status) } : {}),
          ...(a.marketplace ? { marketplace: { equals: String(a.marketplace), mode: "insensitive" } } : {}),
          ...(a.search ? { name: { contains: String(a.search), mode: "insensitive" } } : {}),
        },
        select: {
          id: true, name: true, marketplace: true, status: true, createdAt: true, updatedAt: true,
          user: { select: { email: true } },
          _count: { select: { products: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: Number(a.limit ?? 50),
      });
      return ok(
        rows.map((p) => ({
          id: p.id,
          name: p.name,
          marketplace: p.marketplace,
          status: p.status,
          products: p._count.products,
          owner: p.user?.email ?? null,
          updatedAt: p.updatedAt,
        })),
      );
    },
  },

  {
    name: "get_project",
    title: "Project detail",
    description:
      "One project with its category breakdown and how far through the pipeline it is. Says where products were lost between upload and export.",
    schema: { projectId: z.string().describe("Project id from list_projects") },
    async run(actor, a) {
      const id = String(a.projectId);
      const p = await prisma.project.findUnique({
        where: { id },
        select: {
          id: true, name: true, marketplace: true, status: true, userId: true, teamId: true,
          createdAt: true, updatedAt: true, user: { select: { email: true } },
        },
      });
      if (!p) return ok({ error: "No such project" });
      // The same check the web app makes before rendering the page.
      if (!canReadProject(actor, p)) return ok({ error: "Not visible to you" });

      const [total, verified, categorised, uncategorised, byCategory] = await Promise.all([
        prisma.product.count({ where: { projectId: id } }),
        prisma.product.count({ where: { projectId: id, verifyStatus: { not: null } } }),
        prisma.product.count({
          where: { projectId: id, marketplaceCategory: { not: null }, NOT: { marketplaceCategory: "Uncategorized" } },
        }),
        prisma.product.count({
          where: { projectId: id, OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] },
        }),
        prisma.product.groupBy({
          by: ["marketplaceCategory"],
          where: { projectId: id },
          _count: { _all: true },
          orderBy: { _count: { id: "desc" } },
          take: 25,
        }),
      ]);

      return ok({
        ...{ id: p.id, name: p.name, marketplace: p.marketplace, status: p.status },
        owner: p.user?.email ?? null,
        updatedAt: p.updatedAt,
        // Stated as a funnel, because "why is only 182 of 1,999 exportable?"
        // is the question people actually arrive with.
        pipeline: {
          uploaded: total,
          verified,
          categorised,
          uncategorised,
          exportable: categorised,
          note: "Uncategorised products go to Uncategorized.csv and are not placed in any template.",
        },
        topCategories: byCategory.map((c) => ({
          category: c.marketplaceCategory ?? "(none)",
          products: c._count._all,
        })),
      });
    },
  },

  {
    name: "find_products",
    title: "Find products",
    description:
      "Search products by SKU, barcode, name or category, within the projects you can see.",
    schema: {
      query: z.string().describe("Part of a SKU, barcode, product name or category"),
      projectId: z.string().optional().describe("Restrict to one project"),
      missingField: z
        .enum(["upc", "brand", "category", "image", "price"])
        .optional()
        .describe("Only products where this is empty — for chasing export gaps"),
      limit: z.number().int().min(1).max(MAX_ROWS).optional(),
    },
    async run(actor, a) {
      const q = String(a.query ?? "").trim();
      const visible = await prisma.project.findMany({
        where: {
          ...projectListScope(actor),
          ...(a.projectId ? { id: String(a.projectId) } : {}),
        },
        select: { id: true },
      });
      if (!visible.length) return ok({ products: [], note: "No projects visible to you" });

      const missing: Record<string, object> = {
        upc: { OR: [{ upc: null }, { upc: "" }] },
        brand: { OR: [{ brand: null }, { brand: "" }] },
        category: { OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] },
        image: { OR: [{ imageUrl: null }, { imageUrl: "" }] },
        price: { price: null },
      };

      const rows = await prisma.product.findMany({
        where: {
          projectId: { in: visible.map((v) => v.id) },
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: "insensitive" } },
                  { vendorSku: { contains: q, mode: "insensitive" } },
                  { upc: { contains: q } },
                  { marketplaceCategory: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
          ...(a.missingField ? (missing[String(a.missingField)] as object) : {}),
        },
        select: {
          id: true, name: true, vendorSku: true, upc: true, brand: true,
          marketplaceCategory: true, verifyStatus: true,
          project: { select: { id: true, name: true } },
        },
        take: Number(a.limit ?? 50),
      });
      return ok({ count: rows.length, products: rows });
    },
  },

  {
    name: "export_readiness",
    title: "Export readiness",
    description:
      "For a project: which required columns would ship empty, how many rows each affects, and why. The question a client asks as 'the output sheet is wrong'.",
    schema: { projectId: z.string() },
    async run(actor, a) {
      const id = String(a.projectId);
      const p = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, marketplace: true, userId: true, teamId: true },
      });
      if (!p) return ok({ error: "No such project" });
      if (!canReadProject(actor, p)) return ok({ error: "Not visible to you" });

      const total = await prisma.product.count({ where: { projectId: id } });
      const checks: { field: string; where: object; why: string }[] = [
        { field: "upc / barcode", where: { OR: [{ upc: null }, { upc: "" }] },
          why: "From the vendor sheet, Synccentric, or nowhere. The model is not allowed to invent one." },
        { field: "brand", where: { OR: [{ brand: null }, { brand: "" }] },
          why: "From the vendor sheet or the catalogue lookup." },
        { field: "category", where: { OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] },
          why: "Not matched to a marketplace category — excluded from every template file." },
        { field: "image", where: { OR: [{ imageUrl: null }, { imageUrl: "" }] },
          why: "A catalogue photograph or none. Never generated." },
      ];

      const gaps = await Promise.all(
        checks.map(async (c) => {
          const n = await prisma.product.count({ where: { projectId: id, ...c.where } });
          return { field: c.field, empty: n, of: total, why: c.why };
        }),
      );

      return ok({
        project: p.name,
        marketplace: p.marketplace,
        products: total,
        gaps: gaps.filter((g) => g.empty > 0),
        alwaysManual: [
          "California Proposition 65 warning",
          "PFAS declaration",
          "Contains embedded battery",
        ],
        alwaysManualNote:
          "Seller declarations. No catalogue carries them and the model is barred from guessing — they need a stated value.",
      });
    },
  },

  {
    name: "list_templates",
    title: "List templates",
    description:
      "Export templates you can use. A member sees their own plus the global ones; a team admin sees their team's too.",
    schema: { marketplace: z.string().optional() },
    async run(actor, a) {
      const { adminIds, teamAdminIds } = await templateOwnerIds();
      const rows = await prisma.exportTemplate.findMany({
        where: {
          ...(a.marketplace
            ? { marketplace: { equals: String(a.marketplace), mode: "insensitive" } }
            : {}),
          OR: templateVisibilityOr(actor, adminIds, teamAdminIds),
        },
        select: {
          id: true, name: true, marketplace: true, category: true, createdAt: true,
          user: { select: { email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: MAX_ROWS,
      });
      return ok(
        rows.map((t) => ({
          id: t.id, name: t.name, marketplace: t.marketplace, category: t.category,
          owner: t.user?.email ?? "(global)",
        })),
      );
    },
  },

  {
    name: "usage_summary",
    title: "AI and API spend",
    description:
      "What the paid services cost over a window, by service and feature. Admins only — it covers the whole account.",
    schema: { days: z.number().int().min(1).max(90).optional().describe("Default 30") },
    async run(actor, a) {
      // Spend is an account-wide figure and cannot be meaningfully scoped to
      // one member's projects, so it is simply not offered to them.
      if (!isAnyAdmin(actor)) return ok({ error: "Admins only" });
      const days = Number(a.days ?? 30);
      const since = new Date(Date.now() - days * 86_400_000);

      const rows = await prisma.$queryRaw<
        { service: string; feature: string; calls: bigint; input: bigint; output: bigint; failed: bigint }[]
      >`
        select service, feature, count(*) as calls,
               coalesce(sum("inputTokens"),0) as input,
               coalesce(sum("outputTokens"),0) as output,
               count(*) filter (where not ok) as failed
        from "ServiceUsage"
        where "createdAt" >= ${since}
        group by 1,2 order by sum("inputTokens") desc nulls last limit 30`;

      const n = (v: bigint) => Number(v);
      const totalTokens = rows.reduce((s, r) => s + n(r.input) + n(r.output), 0) || 1;
      return ok({
        windowDays: days,
        byFeature: rows.map((r) => ({
          service: r.service,
          feature: r.feature,
          calls: n(r.calls),
          failed: n(r.failed),
          tokensIn: n(r.input),
          tokensOut: n(r.output),
          shareOfTokens: `${Math.round(((n(r.input) + n(r.output)) / totalTokens) * 100)}%`,
        })),
      });
    },
  },

  {
    name: "whoami",
    title: "Who am I",
    description: "The Mercato account this connection acts as, and what it can reach.",
    schema: {},
    async run(actor) {
      const [projects, admins] = await Promise.all([
        prisma.project.count({ where: projectListScope(actor) }),
        adminUserIds(),
      ]);
      return ok({
        userId: actor.id,
        role: actor.role,
        teamId: actor.teamId,
        visibleProjects: projects,
        isSuperAdmin: admins.includes(actor.id),
        note: "Every tool is scoped to this account — the same as what you see signed in.",
      });
    },
  },
];
