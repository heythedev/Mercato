import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { toDisplayBarcode } from "@/lib/barcode";
import { buildDownloadName, contentDisposition } from "@/lib/export/filename";

type FieldResult = { field: string; label: string; stored: string; live: string; severity: string; note?: string };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      name: true,
      marketplace: true,
      products: {
        select: {
          id: true, name: true, vendorSku: true, upc: true, asin: true, brand: true,
          verifyStatus: true, verifyFields: true,
        },
        orderBy: { name: "asc" },
      },
    },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Build CSV
  // `colour` and `pack` each emit a (Catalog) / (Marketplace) / Result triple,
  // which is the side-by-side comparison the verification report is asked for.
  const FIELD_ORDER = [
    "title", "brand", "model", "upc", "colour", "pack",
    "images", "description", "dimensions",
  ];
  const mpLabel =
    project.marketplace === "walmart" ? "Walmart" :
    project.marketplace === "amazon_us" ? "Amazon US" :
    "Amazon";

  const FIELD_LABELS: Record<string, string> = {
    model: "Model Number", upc: "UPC", colour: "Colour", pack: "Pack / Set Qty",
  };
  const header = [
    "SKU", "UPC", "ASIN", "Product Name", "Overall Status",
    "Catalog Image URL", `${mpLabel} Image URL`, "Image Result", "Image Note",
    ...FIELD_ORDER.filter(f => f !== "images").flatMap(f => {
      const label = FIELD_LABELS[f] ?? capitalize(f);
      return [`${label} (Catalog)`, `${label} (${mpLabel})`, `${label} Result`];
    }),
  ].map(h => `"${h}"`).join(",");

  // Numeric-ID fields (UPC, ASIN, SKU) must be forced to text in Excel, otherwise
  // 12-digit UPCs render as scientific notation (7.56E+11). The =""VALUE"" formula
  // trick tells Excel to evaluate the cell as a text string, not a number.
  const numId = (v: string | null | undefined) =>
    v ? `"=""${String(v).replace(/"/g, '""')}"""` : `""`;

  const rows = project.products.map((p) => {
    const fields = (p.verifyFields ?? []) as FieldResult[];
    const byField = Object.fromEntries(fields.map(f => [f.field, f]));

    const imgField = byField["images"];
    const textCells = [
      p.name,
      p.verifyStatus ?? "pending",
      imgField?.stored ?? "",
      imgField?.live ?? "",
      imgField?.severity ?? "N/A",
      imgField?.note ?? "",
      ...FIELD_ORDER.filter(f => f !== "images").flatMap(f => {
        const fr = byField[f];
        return fr ? [fr.stored, fr.live, fr.severity] : ["N/A", "N/A", "N/A"];
      }),
    ].map(c => `"${String(c ?? "").replace(/"/g, '""')}"`);

    return [
      numId(p.vendorSku),
      numId(toDisplayBarcode(p.upc) ?? p.upc),
      numId(p.asin),
      ...textCells,
    ].join(",");
  });

  const csv = "﻿" + [header, ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(buildDownloadName({
        prefix: "mercato-verification-report",
        projectName: project.name,
        marketplace: project.marketplace,
        extension: "csv",
      })),
    },
  });
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

