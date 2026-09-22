import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { readXlsxGrid } from "@/lib/vendor/xlsx-lite";
import { detectTemplateCategory } from "@/lib/ai/detect-template-category";
import {
  actorOf,
  adminUserIds,
  canWriteTemplate,
  isGlobalTemplate,
  ownerIdForNewTemplate,
  teamIdForNewRow,
  templateVisibilityOr,
} from "@/lib/authz";

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_EXT = new Set([".xlsx", ".xlsm", ".csv", ".tsv"]);

export async function GET(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const marketplace = req.nextUrl.searchParams.get("marketplace");

  // "amazon_us" projects should also match templates tagged "amazon" and vice-versa.
  // Use lowercase comparison to handle case mismatches (e.g. "Mathis" vs "mathis").
  const marketplaceFamily = (mp: string) => {
    const lower = mp.toLowerCase();
    return lower === "amazon_us" || lower === "amazon" ? ["amazon_us", "amazon"] : [lower];
  };

  // Also pick up templates owned by admin users — some may have userId=adminId instead of null
  // if they were uploaded before the userId=null convention was enforced.
  const adminIds = await adminUserIds();
  const adminIdSet = new Set(adminIds);
  const actor = actorOf(user);

  // Return user's own templates + global/admin templates.
  // Exclude fileData (BYTEA blob) — only column definitions are needed for listing and export.
  const rawTemplates = await prisma.exportTemplate.findMany({
    where: {
      ...(marketplace ? { marketplace: { in: marketplaceFamily(marketplace), mode: "insensitive" } } : {}),
      OR: templateVisibilityOr(actor, adminIds),
    },
    select: {
      id: true, name: true, marketplace: true, category: true,
      fileFormat: true, columns: true, userId: true, createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Normalize: treat admin-owned templates as userId=null so the Admin badge shows on the client.
  const templates = rawTemplates.map((t) => ({
    ...t,
    userId: isGlobalTemplate(t, adminIdSet) ? null : t.userId,
  }));

  return NextResponse.json({ templates });
}

export async function POST(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const contentType = req.headers.get("content-type") ?? "";

  // ── File upload path ──────────────────────────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try { form = await req.formData(); } catch {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
    }

    const file = form.get("file");
    const marketplace = String(form.get("marketplace") ?? "").trim();
    const category = String(form.get("category") ?? "").trim() || null;
    const name = String(form.get("name") ?? "").trim();

    if (!(file instanceof File)) return NextResponse.json({ error: "No file attached" }, { status: 400 });
    if (!marketplace) return NextResponse.json({ error: "marketplace required" }, { status: 400 });
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return NextResponse.json({ error: `Unsupported type "${ext}". Use .xlsx, .xlsm, .csv, or .tsv.` }, { status: 400 });
    }
    if (file.size === 0) return NextResponse.json({ error: "File is empty" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 15 MB)" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    let headers: string[] = [];
    let sheetName: string | null = null;

    if (ext === ".csv" || ext === ".tsv") {
      const text = buffer.toString("utf-8").replace(/^﻿/, "");
      const delim = ext === ".tsv" ? "\t" : (text.includes("\t") ? "\t" : ",");
      const firstLine = text.split(/\r?\n/)[0] ?? "";
      headers = firstLine.split(delim).map((h) => h.replace(/^"|"$/g, "").trim()).filter(Boolean);
    } else {
      const result = await readXlsxGrid(buffer, 30);
      sheetName = result.sheetName;
      let bestIdx = 0, bestCount = -1;
      for (let i = 0; i < Math.min(result.grid.length, 25); i++) {
        const count = result.grid[i].filter((c) => c.trim() !== "").length;
        if (count >= 2 && count > bestCount) { bestCount = count; bestIdx = i; }
      }
      headers = (result.grid[bestIdx] ?? []).map((h) => h.trim()).filter(Boolean);
    }

    if (!headers.length) return NextResponse.json({ error: "No column headers found in file" }, { status: 400 });

    const columns = headers.map((key) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1).replace(/[_-]/g, " "),
    }));

    // Auto-detect category if not provided
    const resolvedCategory = category || await detectTemplateCategory(file.name, sheetName, headers) || null;

    const template = await prisma.exportTemplate.create({
      data: {
        userId: ownerIdForNewTemplate(actorOf(user)),
        teamId: teamIdForNewRow(actorOf(user)),
        name,
        marketplace,
        category: resolvedCategory,
        fileFormat: ext === ".csv" || ext === ".tsv" ? "csv" : "xlsx",
        columns,
        fileData: buffer,
      },
    });

    return NextResponse.json({ ...template, detectedColumns: headers.length, suggestedCategory: resolvedCategory });
  }

  // ── JSON path (manual column entry) ──────────────────────────────────────
  const body = await req.json();
  const { name, marketplace, category, fileFormat, columns } = body;

  if (!name || !marketplace || !columns) {
    return NextResponse.json({ error: "name, marketplace and columns required" }, { status: 400 });
  }

  const template = await prisma.exportTemplate.create({
    data: {
      userId: ownerIdForNewTemplate(actorOf(user)),
      teamId: teamIdForNewRow(actorOf(user)),
      name,
      marketplace,
      category: category ?? null,
      fileFormat: fileFormat ?? "xlsx",
      columns,
    },
  });

  return NextResponse.json(template);
}

export async function PATCH(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const template = await prisma.exportTemplate.findUnique({ where: { id } });
  if (!template) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canWriteTemplate(actorOf(user), template)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const updated = await prisma.exportTemplate.update({
    where: { id },
    data: {
      ...(body.name      ? { name: String(body.name).trim() }           : {}),
      ...(body.marketplace !== undefined ? { marketplace: String(body.marketplace) } : {}),
      ...(body.category  !== undefined ? { category: body.category ? String(body.category).trim() : null } : {}),
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const template = await prisma.exportTemplate.findUnique({ where: { id } });
  if (!template) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Users can only delete their own templates; admins can delete any
  if (!canWriteTemplate(actorOf(user), template)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.exportTemplate.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
