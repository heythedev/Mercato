import { NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { miraklConfigured } from "@/lib/bestbuy/mirakl-client";

/**
 * Whether Best Buy templates can be generated automatically.
 *
 * Best Buy has 1,450 leaf categories, each with its own required attributes, so
 * the export builds every category's sheet from Mirakl's attribute
 * configuration (PM11) instead of expecting 1,450 uploaded template files. The
 * export screen needs to know that, otherwise it warns "no matching template"
 * for categories that will in fact be generated — which is what it did before
 * this endpoint existed.
 *
 * Reports capability only; never returns the credentials themselves.
 */
export async function GET() {
  const { response } = await authGuard();
  if (response) return response;

  return NextResponse.json({ autoTemplates: miraklConfigured() });
}
