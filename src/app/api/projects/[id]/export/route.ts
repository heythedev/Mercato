import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma, inChunks } from "@/lib/db";
import type { ExportTemplate, Prisma } from "@prisma/client";
import { generateCategoryZip, generateExportZip, generateFlatCategoryZip, generateFlatExport, generateSingleTemplateExport, unwrapSingleFileZip, type TemplateRow } from "@/lib/export/zip";
import { createJob, resolveJob, rejectJob, getJobStatus, getJobZip, setJobPhase, touchJob } from "@/lib/export/job-store";
import { buildDownloadName, contentDisposition } from "@/lib/export/filename";

export const maxDuration = 300;

// The catalog image back-fill scrapes the vendor's site per SKU. A SKU-only
// sheet where every product is missing an image (852 Vickerman rows) turns
// that into a minutes-long network sweep that outlives the function — so it
// gets a hard time budget instead. Fills are persisted, so each export run
// picks up where the previous one stopped and the catalog heals incrementally.
const BACKFILL_BUDGET_MS = 120_000;

// Poll job status / download completed ZIP
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = await getJobStatus(jobId);
  // A job belonging to someone else reads as absent rather than Forbidden —
  // jobIds encode the project id, no need to confirm they exist to outsiders.
  if (!job || job.userId !== user!.id) {
    return NextResponse.json({ error: "Job not found or expired" }, { status: 404 });
  }

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
  // The payload is fetched only now, so the poll loop never drags the BYTEA
  // column across the wire.
  const [zip, meta] = await Promise.all([
    getJobZip(jobId),
    prisma.project.findUnique({
      where: { id },
      select: { name: true, marketplace: true },
    }),
  ]);
  if (!zip) return NextResponse.json({ error: "Export payload missing — please run the export again" }, { status: 410 });
  // Single-file exports are served as the spreadsheet itself, so the extension
  // and MIME type follow whatever the job actually stored.
  const extension = job.extension ?? "zip";
  const contentType = job.contentType ?? "application/zip";
  const filename = buildDownloadName({
    projectName: meta?.name,
    marketplace: meta?.marketplace,
    extension,
  });

  const missing = job.missingTemplateCategories;
  return new Response(zip as unknown as BodyInit, {
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
  await createJob(jobId, id, user!.id);

  // All heavy work (loading products JSON, loading template fileData BYTEA)
  // runs after the response. `after()` matters on Vercel: a bare fire-and-forget
  // promise has no guaranteed CPU once the response is sent — the instance can
  // be frozen mid-query, which leaked pool connections until the next export
  // died with "timeout exceeded when trying to connect". `after()` keeps the
  // function alive (up to maxDuration) until the job finishes.
  after(async () => {
    // Mark exporting inside the background job so the POST can return the jobId
    // immediately without a DB round-trip. Previously this was awaited in the
    // request handler — if the DB was slow or the connection pool was exhausted
    // the await could hang for 30s and Render's proxy would 502 the request.
    await prisma.project.update({ where: { id }, data: { status: "exporting" } }).catch(() => {});
    // Heartbeat: bump updatedAt every 20s for the whole job so long single
    // operations (the product load, one giant model batch) never look dead to
    // the client's stall detector even when the phase string is unchanged.
    const heartbeat = setInterval(() => { void touchJob(jobId); }, 20_000);
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
      await setJobPhase(jobId, "Loading products…");
      const templateSelect = { id: true, name: true, marketplace: true, category: true, fileFormat: true, columns: true, fileData: true, userId: true };
      // Select only the columns the export actually reads. `include: products`
      // pulled every column, and `liveData` alone (Walmart's full listing
      // payload, ~13KB per product) made this 87MB / ~68s for a 7k project —
      // before a single row was written. The fields below are every product
      // property referenced by the template writer.
      const productSelect = {
        id: true,
        name: true,
        vendorSku: true,
        upc: true,
        asin: true,
        brand: true,
        price: true,
        description: true,
        imageUrl: true,
        marketplaceCategory: true,
        categoryPath: true,
        specProductType: true,
        verifyStatus: true,
        vendorData: true,
        // liveData is fetched separately and slimmed — see below.
      } as const;
      const [project, rawTemplates, liveDataRows] = await Promise.all([
        prisma.project.findUnique({
          where: { id },
          include: { products: { select: productSelect } },
        }),
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
        // liveData holds Walmart's full listing payload (~13KB/product), but the
        // export reads only a handful of scalar fields from it. Stripping the
        // heavy nested values IN SQL cuts the transferred payload roughly 3x
        // (76MB → 26MB on a 7k project) instead of shipping them across the wire
        // just to ignore them.
        //
        // `- 'key'` removes a top-level key from a jsonb value. Only `variants`
        // and `imageEntities` are dropped: they are the two largest fields
        // (~45% of the payload) and nothing reads them — the image angles the
        // export needs are already flattened into `images`. Description and
        // image fields are KEPT, because the generic "match a template column
        // name against a liveData key" fallback can legitimately resolve a
        // Description or Image column from them.
        prisma.$queryRawUnsafe<Array<{ id: string; liveData: unknown }>>(
          `SELECT id, ("liveData" - 'variants' - 'imageEntities') AS "liveData"
           FROM "Product"
           WHERE "projectId" = $1 AND "liveData" IS NOT NULL`,
          id,
        ),
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

      // Attach the slimmed liveData fetched above. Products with no verification
      // result simply have none, matching the previous behaviour.
      const liveById = new Map(liveDataRows.map((r) => [r.id, r.liveData]));
      type ExportProduct = (typeof project.products)[number] & { liveData: Prisma.JsonValue };
      let products: ExportProduct[] = project.products.map((p) => ({
        ...p,
        liveData: (liveById.get(p.id) ?? null) as Prisma.JsonValue,
      }));

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
          products,
          (done, total) => { void setJobPhase(jobId, `Fetching product images ${done}/${total}…`); },
          { deadline: Date.now() + BACKFILL_BUDGET_MS },
        );
        if (fills.size > 0) {
          products = products.map((p) => {
            const f = fills.get(p.id);
            if (!f) return p;
            return {
              ...p,
              imageUrl: p.imageUrl || f.imageUrl,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              vendorData: { ...((p.vendorData ?? {}) as object), ...f.attributes } as any,
            };
          });
          const originalById = new Map(products.map((p) => [p.id, p]));
          // Chunk size 5, not the default 10: the default equals the pg pool's
          // max, and a write burst that owns every connection starves the
          // status polls running concurrently on this same instance.
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
          }, 5);
          console.log(`[export] catalog back-fill: images/attributes added for ${fills.size} products`);
        }
      } catch (err) {
        console.warn("[export] catalog back-fill failed (continuing without):", err);
      }

      // For Walmart exports: AI-generate optimised titles (meaning + attributes + USPs)
      // instead of copying vendor titles word-for-word. Falls back to vendor name on error.
      if (mpLower === "walmart" && products.length > 0) {
        try {
          await setJobPhase(jobId, `Generating optimised titles for ${products.length} products…`);
          const { generateMarketplaceTitles } = await import("@/lib/ai/generate-title");
          // Per-batch progress: a 7k catalog makes ~470 title batches, and a
          // single static phase for all of them reads as a stalled export to
          // the client's 5-minute no-progress detector.
          const titleMap = await generateMarketplaceTitles("walmart", products, (done, total) => {
            void setJobPhase(jobId, `Generating optimised titles ${done}/${total}…`);
          });
          if (titleMap.size > 0) {
            products = products.map((p) =>
              titleMap.has(p.id) ? { ...p, name: titleMap.get(p.id)! } : p
            );
          }
        } catch (err) {
          console.warn("[export] title generation failed, using vendor names:", err);
        }
      }

      // ── Disambiguate identical titles ─────────────────────────────────────
      // Vendor sheets carry genuine variants under one name: this catalog has
      // 11 rows of "Caroline's Treasures Peacock Throw Pillow…", each a
      // different artwork/size with its own UPC. Exported as-is they read as
      // one product repeated with contradictory UPCs. Each duplicate gets a
      // distinguishing suffix — its size when sizes differ, otherwise the
      // design code from its SKU — so every row is identifiable.
      {
        const byName = new Map<string, typeof products>();
        for (const p of products) {
          const k = (p.name ?? "").trim().toLowerCase();
          if (!k) continue;
          const arr = byName.get(k);
          if (arr) arr.push(p); else byName.set(k, [p]);
        }
        const suffixFor = (p: (typeof products)[number], sizesDiffer: boolean): string => {
          const vd = (p.vendorData ?? {}) as Record<string, unknown>;
          const dims = String(vd.dimensions ?? "").trim();
          if (sizesDiffer && dims) return dims;
          // Design code: the trailing alphanumeric run of the SKU
          // (CTTS-DAC3248PW1818 → DAC3248PW1818) names the variant precisely.
          const m = (p.vendorSku ?? "").match(/([A-Z0-9]{4,})$/i);
          return m ? m[1] : (p.upc ?? "").slice(-6);
        };
        let disambiguated = 0;
        for (const group of byName.values()) {
          if (group.length < 2) continue;
          const dims = new Set(group.map((p) => String(((p.vendorData ?? {}) as Record<string, unknown>).dimensions ?? "")));
          const sizesDiffer = dims.size > 1;
          for (const p of group) {
            const suffix = suffixFor(p, sizesDiffer);
            if (suffix && !p.name.toLowerCase().includes(suffix.toLowerCase())) {
              p.name = `${p.name} - ${suffix}`;
              disambiguated++;
            }
          }
        }
        if (disambiguated) {
          console.log(`[export] disambiguated ${disambiguated} identical titles with size/design suffixes`);
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

      await setJobPhase(jobId, "Building spreadsheet files…");

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
        zipBuffer = await generateSingleTemplateExport(products, tpl, projectMeta.marketplace, templateFileData) as Buffer;
      } else if (usesCategoryExport && allTemplates.length) {
        // With uploaded templates: match each category to the closest template
        // and export in that template's column format — one file per matched category
        const result = await generateCategoryZip(products, allTemplates, projectMeta.marketplace, templateId);
        zipBuffer = result.zip;
        missingTemplateCategories = result.missingTemplateCategories;
      } else if (usesCategoryExport) {
        // Without templates: split by AI-assigned category using flat columns
        zipBuffer = await generateFlatCategoryZip(products, projectMeta.marketplace) as Buffer;
      } else if (isSears && allTemplates.length) {
        // Sears uses one generic template — all products go into a single file.
        // No category-splitting needed since a single template covers the whole catalogue.
        const tpl = allTemplates[0];
        const templateFileData = tpl?.fileData ? Buffer.from(tpl.fileData as unknown as ArrayBuffer) : null;
        zipBuffer = await generateSingleTemplateExport(products, tpl, projectMeta.marketplace, templateFileData) as Buffer;
      } else if (!allTemplates.length) {
        // No templates → flat export (one file, standard columns)
        zipBuffer = await generateFlatExport(products, projectMeta.marketplace) as Buffer;
      } else if (useAutoMatch) {
        const result = await generateCategoryZip(products, allTemplates, projectMeta.marketplace, templateId);
        zipBuffer = result.zip;
        missingTemplateCategories = result.missingTemplateCategories;
      } else {
        zipBuffer = await generateExportZip(products, allTemplates as unknown as ExportTemplate[], projectMeta.marketplace) as Buffer;
      }

      // A one-file export (Walmart always produces a single sheet) is delivered
      // as that spreadsheet rather than a ZIP the user has to unpack first.
      const payload = await unwrapSingleFileZip(zipBuffer as Buffer);
      // Status write BEFORE resolveJob, and best-effort: it used to run after,
      // unguarded, so a transient DB error on this bookkeeping write threw the
      // job into the catch below — which discarded an already-built ZIP and
      // reported the export as failed.
      await prisma.project.update({ where: { id }, data: { status: "done" } }).catch(() => {});
      await resolveJob(jobId, payload.buffer, {
        extension: payload.extension,
        contentType: payload.contentType,
        missingTemplateCategories,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[export] background job failed:", msg);
      await rejectJob(jobId, msg);
      await prisma.project.update({ where: { id }, data: { status: "categorized" } }).catch(() => {});
    } finally {
      // The heartbeat must stop with the job — touchJob is a no-op once the
      // job leaves "processing", but the interval itself would leak forever.
      clearInterval(heartbeat);
    }
  });

  return NextResponse.json({ jobId });
}
