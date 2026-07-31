import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma, inChunks } from "@/lib/db";
import type { ExportTemplate } from "@prisma/client";
import { generateCategoryZip, generateExportZip, generateFlatCategoryZip, generateFlatExport, generateSingleTemplateExport, unwrapSingleFileZip, type TemplateRow } from "@/lib/export/zip";
import { createJob, resolveJob, rejectJob, getJob, setJobPhase } from "@/lib/export/job-store";
import { buildDownloadName, contentDisposition } from "@/lib/export/filename";

export const maxDuration = 300;

// Poll job status / download completed ZIP
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found or expired" }, { status: 404 });

  if (job.status === "processing") {
    // Echo the phase and a heartbeat so the client can show real progress and
    // tell a slow-but-alive job apart from a stalled one.
    return NextResponse.json({
      status: "processing",
      phase: job.phase ?? "Preparing…",
      updatedAt: job.updatedAt,
    });
  }

  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error }, { status: 500 });
  }

  // Done — serve the ZIP under a human-readable name
  // ("mercato-Spring Catalog-mathis-23-07-2026.zip" rather than the raw project id).
  const meta = await prisma.project.findUnique({
    where: { id },
    select: { name: true, marketplace: true },
  });
  // Single-file exports are served as the spreadsheet itself, so the extension
  // and MIME type follow whatever the job actually stored.
  const extension = job.extension ?? "zip";
  const contentType = job.contentType ?? "application/zip";
  const filename = buildDownloadName({
    projectName: meta?.name,
    marketplace: meta?.marketplace,
    extension,
  });

  const missing = job.missingTemplateCategories ?? [];
  return new Response(job.zip as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition(filename),
      // Temu categories that had no matching template — client reads this to show
      // an "upload a template for these categories" warning after download.
      "X-Missing-Template-Categories": missing.map(encodeURIComponent).join(","),
      "Access-Control-Expose-Headers": "X-Missing-Template-Categories",
    },
  });
}

// Start export job — lightweight auth + existence check only, then returns { jobId } immediately.
// All heavy DB queries (products, template fileData) run inside the background job.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const autoMatch: boolean = body.autoMatch ?? false;
  const templateId: string | undefined = body.templateId;
  const templateIds: string[] = body.templateIds ?? [];

  if (!autoMatch && !templateId && !templateIds.length) {
    return NextResponse.json({ error: "autoMatch, templateId or templateIds required" }, { status: 400 });
  }

  // Lightweight check — just ownership, no heavy data loaded
  const projectMeta = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, marketplace: true },
  });
  if (!projectMeta) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (projectMeta.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const jobId = `${id}_${Date.now()}`;
  createJob(jobId);

  // Mark exporting — this is fast (no data load)
  await prisma.project.update({ where: { id }, data: { status: "exporting" } });

  // All heavy work (loading products JSON, loading template fileData BYTEA) runs here in background.
  // The HTTP response returns the jobId above; client polls GET until done.
  void (async () => {
    try {
      const useAutoMatch = autoMatch || !!templateId;
      const useTemplateIds = !autoMatch && !templateId && templateIds.length > 0;

      // "amazon_us" and "amazon" share the same template pool; use lowercase for case-insensitive match
      const mp = projectMeta.marketplace;
      const mpLower = mp.toLowerCase();
      const mpFamily = mpLower === "amazon_us" || mpLower === "amazon" ? ["amazon_us", "amazon"] : [mpLower];

      // Include templates owned by admin users (some may have userId=adminId instead of null).
      const adminUserIds = (await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } }))
        .map((u) => u.id);
      const adminOr = adminUserIds.length > 0 ? [{ userId: { in: adminUserIds } }] : [];
      const templateOwnerOr = [{ userId: user!.id }, { userId: null }, ...adminOr];

      // Include fileData so category-zip exports can use fillTemplateXlsx and preserve
      // original template formatting, column widths, styles, and dropdown validations.
      // userId is included so we can prefer user-uploaded templates over admin/global ones.
      setJobPhase(jobId, "Loading products…");
      const templateSelect = { id: true, name: true, marketplace: true, category: true, fileFormat: true, columns: true, fileData: true, userId: true };
      const [project, rawTemplates] = await Promise.all([
        prisma.project.findUnique({ where: { id }, include: { products: true } }),
        useAutoMatch
          ? prisma.exportTemplate.findMany({
              where: { marketplace: { in: mpFamily, mode: "insensitive" }, OR: templateOwnerOr },
              select: templateSelect,
              orderBy: { createdAt: "asc" },
            })
          : prisma.exportTemplate.findMany({
              where: { id: { in: templateIds }, OR: templateOwnerOr },
              select: templateSelect,
              orderBy: { createdAt: "asc" },
            }),
      ]);

      // Both user-uploaded and admin/global templates are included in the export pool.
      // When the user has uploaded a template with the same name as an admin template,
      // the user's version replaces the admin's — so their customisation takes effect
      // without losing access to admin templates they haven't overridden.
      const userOwnTemplates = rawTemplates.filter(t => t.userId === user!.id);
      const adminTemplates   = rawTemplates.filter(t => t.userId !== user!.id);
      const userNames = new Set(userOwnTemplates.map(t => t.name.toLowerCase().trim()));
      const nonOverriddenAdmin = adminTemplates.filter(t => !userNames.has(t.name.toLowerCase().trim()));
      const allTemplates = [...userOwnTemplates, ...nonOverriddenAdmin] as TemplateRow[];

      if (!project) throw new Error("Project not found");

      // ── Catalog back-fill: images + attributes ────────────────────────────────
      // SKU-only vendor sheets carry no images/size/color; those come from the vendor's
      // own catalog (Modway/TOV). Categorize-time enrichment only runs for rows whose
      // name is still a raw code, so a project categorized before attribute support was
      // added would permanently miss its images. Filling here — right before the
      // template is written — makes the export self-sufficient regardless of when (or
      // whether) enrichment ran. Only products missing an image are touched; results
      // are persisted so subsequent exports skip the network entirely.
      try {
        const { fillCatalogAttributes } = await import("@/lib/ai/resolve-sku");
        const fills = await fillCatalogAttributes(
          project.products,
          (done, total) => setJobPhase(jobId, `Fetching product images ${done}/${total}…`),
        );
        if (fills.size > 0) {
          project.products = project.products.map((p) => {
            const f = fills.get(p.id);
            if (!f) return p;
            return {
              ...p,
              imageUrl: p.imageUrl || f.imageUrl,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              vendorData: { ...((p.vendorData ?? {}) as object), ...f.attributes } as any,
            };
          });
          const originalById = new Map(project.products.map((p) => [p.id, p]));
          await inChunks([...fills.keys()], (productId) => {
            const merged = originalById.get(productId);
            return prisma.product.update({
              where: { id: productId },
              data: {
                ...(merged?.imageUrl ? { imageUrl: merged.imageUrl } : {}),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                vendorData: (merged?.vendorData ?? undefined) as any,
              },
            });
          });
          console.log(`[export] catalog back-fill: images/attributes added for ${fills.size} products`);
        }
      } catch (err) {
        console.warn("[export] catalog back-fill failed (continuing without):", err);
      }

      // For Walmart exports: AI-generate optimised titles (meaning + attributes + USPs)
      // instead of copying vendor titles word-for-word. Falls back to vendor name on error.
      if (mpLower === "walmart" && project.products.length > 0) {
        try {
          setJobPhase(jobId, `Generating optimised titles for ${project.products.length} products…`);
          const { generateMarketplaceTitles } = await import("@/lib/ai/generate-title");
          const titleMap = await generateMarketplaceTitles("walmart", project.products);
          if (titleMap.size > 0) {
            project.products = project.products.map((p) =>
              titleMap.has(p.id) ? { ...p, name: titleMap.get(p.id)! } : p
            );
          }
        } catch (err) {
          console.warn("[export] title generation failed, using vendor names:", err);
        }
      }

      // Mathis requires templates (throws if none). Walmart, Best Buy and Temu gracefully
      // fall back to flat category ZIP when no templates are uploaded.
      const usesTemplates = mpLower === "mathis";
      if (usesTemplates && !allTemplates.length) {
        throw new Error(`No templates found for ${projectMeta.marketplace}. Upload templates first.`);
      }

      const isTemu = mpLower === "temu";
      const isBestBuy = mpLower === "bestbuy";
      const isWalmart = mpLower === "walmart";
      const isSears = mpLower === "sears";
      const isWayfair = mpLower === "wayfair";
      // Category-split marketplaces: products grouped by category, each group filled into
      // the closest matching uploaded template (one output file per template).
      // Wayfair is category-split too, but by Wayfair *class* — the 1,305 PL SKUs span
      // multiple classes, each needing its own class-specific template workbook. The
      // per-class template fill uses a Wayfair-aware header profile (7 header rows,
      // data at row 8) inside fillTemplateXlsx — see WAYFAIR_HEADER_PROFILE in zip.ts.
      const usesCategoryExport = isTemu || isBestBuy || isWalmart || isWayfair;

      setJobPhase(jobId, "Building spreadsheet files…");

      // Wayfair's class templates have a 7-row header block (data starts row 8) plus a
      // hidden validation engine — the shared fillTemplateXlsx would corrupt them. The
      // dedicated Wayfair filler (wayfair-fill.ts) is not enabled yet, so guard any
      // template-based Wayfair export rather than silently producing a broken workbook.
      // The no-template flat export below is safe (standard flat columns).
      if (isWayfair && ((useTemplateIds && allTemplates.length) || allTemplates.length)) {
        throw new Error(
          "Wayfair template export is not enabled yet. The dedicated Wayfair class-template " +
          "filler requires Wayfair's real Product Addition Template workbook and per-class " +
          "attribute schemas (see src/lib/export/wayfair-fill.ts). Export without a template " +
          "to produce a flat column file in the meantime.",
        );
      }

      let zipBuffer: Buffer;
      let missingTemplateCategories: string[] = [];
      if (useTemplateIds && allTemplates.length) {
        // User explicitly selected a template → all products in one file using that template.
        // This takes priority over category-split so any marketplace can use
        // a manually chosen template instead of auto-matching by category.
        const tpl = allTemplates[0];
        const templateFileData = tpl?.fileData ? Buffer.from(tpl.fileData as unknown as ArrayBuffer) : null;
        zipBuffer = await generateSingleTemplateExport(project.products, tpl, projectMeta.marketplace, templateFileData) as Buffer;
      } else if (usesCategoryExport && allTemplates.length) {
        // With uploaded templates: match each category to the closest template
        // and export in that template's column format — one file per matched category
        const result = await generateCategoryZip(project.products, allTemplates, projectMeta.marketplace, templateId);
        zipBuffer = result.zip;
        missingTemplateCategories = result.missingTemplateCategories;
      } else if (usesCategoryExport) {
        // Without templates: split by AI-assigned category using flat columns
        zipBuffer = await generateFlatCategoryZip(project.products, projectMeta.marketplace) as Buffer;
      } else if (isSears && allTemplates.length) {
        // Sears uses one generic template — all products go into a single file.
        // No category-splitting needed since a single template covers the whole catalogue.
        const tpl = allTemplates[0];
        const templateFileData = tpl?.fileData ? Buffer.from(tpl.fileData as unknown as ArrayBuffer) : null;
        zipBuffer = await generateSingleTemplateExport(project.products, tpl, projectMeta.marketplace, templateFileData) as Buffer;
      } else if (!allTemplates.length) {
        // No templates → flat export (one file, standard columns)
        zipBuffer = await generateFlatExport(project.products, projectMeta.marketplace) as Buffer;
      } else if (useAutoMatch) {
        const result = await generateCategoryZip(project.products, allTemplates, projectMeta.marketplace, templateId);
        zipBuffer = result.zip;
        missingTemplateCategories = result.missingTemplateCategories;
      } else {
        zipBuffer = await generateExportZip(project.products, allTemplates as unknown as ExportTemplate[], projectMeta.marketplace) as Buffer;
      }

      // A one-file export (Walmart always produces a single sheet) is delivered
      // as that spreadsheet rather than a ZIP the user has to unpack first.
      const payload = await unwrapSingleFileZip(zipBuffer as Buffer);
      resolveJob(jobId, payload.buffer, {
        extension: payload.extension,
        contentType: payload.contentType,
        missingTemplateCategories,
      });
      await prisma.project.update({ where: { id }, data: { status: "done" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[export] background job failed:", msg);
      rejectJob(jobId, msg);
      await prisma.project.update({ where: { id }, data: { status: "categorized" } }).catch(() => {});
    }
  })();

  return NextResponse.json({ jobId });
}
