import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { actorOf, adminUserIds, canReadProject, ownerIdForNewTemplate, teamIdForNewRow, templateVisibilityOr } from "@/lib/authz";
import { bestBuyTemplateColumns, getBestBuyColumnsForCategory } from "@/lib/export/bestbuy-template";
import { normCategoryPath } from "@/lib/export/zip";
import { miraklConfigured } from "@/lib/bestbuy/mirakl-client";

export const dynamic = "force-dynamic";

/**
 * Build one Best Buy category's template from Mirakl and SAVE it.
 *
 * Best Buy has 1,450 leaf categories, each with its own required attribute set,
 * and no API serves the template file (probed: /api/products/*\/template all
 * 404). PM11 serves the attribute configuration those files are generated from,
 * so src/lib/export/bestbuy-template.ts can rebuild any category's sheet.
 *
 * Until now it only did so IN MEMORY, and only on the path taken when no Best
 * Buy templates exist at all: upload a single template and every other category
 * silently lost the generated one and got name-matched to whatever template
 * scored highest instead. This endpoint closes that gap by persisting the
 * generated columns as an ordinary ExportTemplate, so a category can be filled
 * in one click and then behaves exactly like an uploaded template — editable,
 * listed under Templates, and reused by every later export.
 *
 * Column keys are the verbatim Mirakl attribute codes, which is what the real
 * template filler in zip.ts keys on (bestBuyFillKeyForCode / bestBuyBareAttribute).
 * Using the human label instead would produce a template that looks right and
 * fills nothing.
 */
/**
 * Which of a project's categories already have a Best Buy template, and which
 * still need one.
 *
 * Best Buy publishes no way to download 1,450 templates at once — a seller
 * fetches them one category at a time — so coverage is built up across
 * projects, not within one. Templates are shared, so the second project that
 * happens to contain "… > Wall Art" should never be asked for that workbook
 * again. This endpoint is what lets the export screen ask only for what is
 * genuinely missing.
 *
 *   GET /api/bestbuy/template?projectId=…
 */
export async function GET(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true, marketplace: true },
  });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const actor = actorOf(user);
  if (!canReadProject(actor, project)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Counted in SQL: a Best Buy project can carry thousands of rows and only the
  // distinct categories matter here.
  const groups = await prisma.product.groupBy({
    by: ["marketplaceCategory"],
    where: { projectId, marketplaceCategory: { not: null } },
    _count: { _all: true },
  });

  const templates = await prisma.exportTemplate.findMany({
    where: {
      marketplace: { equals: "bestbuy", mode: "insensitive" },
      OR: templateVisibilityOr(actor, await adminUserIds()),
    },
    select: { id: true, name: true, category: true },
  });

  // A template with no category declared covers nothing in particular — the 22
  // group workbooks state their coverage inside the file instead, and those are
  // matched at export time, not here.
  const byCategory = new Map<string, { id: string; name: string }>();
  for (const t of templates) {
    const key = normCategoryPath(t.category ?? "");
    if (key && !byCategory.has(key)) byCategory.set(key, { id: t.id, name: t.name });
  }

  const categories = groups
    .filter((g) => g.marketplaceCategory && g.marketplaceCategory !== "Uncategorized")
    .map((g) => {
      const category = g.marketplaceCategory as string;
      const match = byCategory.get(normCategoryPath(category));
      return {
        category,
        products: g._count._all,
        hasTemplate: !!match,
        templateId: match?.id ?? null,
        templateName: match?.name ?? null,
      };
    })
    .sort((a, b) => b.products - a.products);

  return NextResponse.json({
    categories,
    total: categories.length,
    covered: categories.filter((c) => c.hasTemplate).length,
    // Whether "Build from Best Buy" can be offered as an alternative to uploading.
    canGenerate: miraklConfigured(),
  });
}

export async function POST(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const body = await req.json().catch(() => ({}));
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!category) {
    return NextResponse.json({ error: "category required" }, { status: 400 });
  }

  if (!miraklConfigured()) {
    return NextResponse.json(
      {
        error:
          "Best Buy templates cannot be generated — Mirakl credentials are not configured on this " +
          "environment. Upload the category's template file instead.",
      },
      { status: 400 },
    );
  }

  const actor = actorOf(user);

  // Already have one for this category? Hand it back rather than creating a
  // second: the button is easy to press twice, and two templates for one
  // category would make the export's name matching ambiguous.
  const existing = await prisma.exportTemplate.findFirst({
    where: {
      marketplace: { equals: "bestbuy", mode: "insensitive" },
      category: { equals: category, mode: "insensitive" },
      OR: templateVisibilityOr(actor, await adminUserIds()),
    },
    select: { id: true, name: true, marketplace: true, category: true, fileFormat: true, userId: true },
  });
  if (existing) {
    return NextResponse.json({ ...existing, created: false });
  }

  const columns = await getBestBuyColumnsForCategory(category);
  if (!columns?.length) {
    return NextResponse.json(
      {
        error:
          `Best Buy has no attribute set for "${category}". The category path may not match Best ` +
          `Buy's taxonomy — upload this category's template file instead.`,
      },
      { status: 404 },
    );
  }

  // The leaf is what a human calls this category; the full path is kept in
  // `category`, which is what the export matches on.
  const leaf = category.split(/\s*>\s*/).pop()?.trim() || category;

  const template = await prisma.exportTemplate.create({
    data: {
      userId: ownerIdForNewTemplate(actor),
      teamId: teamIdForNewRow(actor),
      name: `Best Buy — ${leaf}`,
      marketplace: "bestbuy",
      category,
      fileFormat: "xlsx",
      // No fileData: there is no source workbook to preserve, so the export
      // writes a fresh sheet from these columns — the same thing the in-memory
      // fallback did, now durable.
      columns: bestBuyTemplateColumns(columns),
    },
    select: { id: true, name: true, marketplace: true, category: true, fileFormat: true, userId: true },
  });

  return NextResponse.json({
    ...template,
    created: true,
    columnCount: columns.length,
    requiredCount: columns.filter((c) => c.required).length,
  });
}
