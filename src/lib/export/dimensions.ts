/**
 * Normalize a catalog dimension string to the bare decimal (inches) that
 * Mirakl-style imports require. Catalog scrapes store values verbatim —
 * `18"`, `4.7"`, `7.5'`, `18 in.` — but Mathis' import rejects anything that
 * isn't a plain decimal number, so units are parsed and stripped here and
 * feet are converted to inches. Returns "" when no leading number exists at
 * all: an empty optional cell imports, a non-decimal value fails the row.
 */
export function toDecimalDimension(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";

  // Already a bare decimal — pass through untouched.
  if (/^\d+(\.\d+)?$/.test(s)) return s;

  const num = (v: number): string => String(Math.round(v * 100) / 100);

  // Compound feet + inches: 5' 6" → 66
  const compound = s.match(
    /^(\d+(?:\.\d+)?)\s*(?:'|′|ft\.?|feet|foot)\s*(\d+(?:\.\d+)?)\s*(?:"|″|”|in\.?|inch(?:es)?)?$/i,
  );
  if (compound) return num(parseFloat(compound[1]) * 12 + parseFloat(compound[2]));

  // Feet only: 7.5' / 7.5 ft → 90
  const feet = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|′|ft\.?|feet|foot)$/i);
  if (feet) return num(parseFloat(feet[1]) * 12);

  // Inches with a unit mark: 18" / 4.7″ / 18 in. / 18 inches → 18 / 4.7
  const inches = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|″|”|in\.?|inch(?:es)?)$/i);
  if (inches) return num(parseFloat(inches[1]));

  // Last resort: take the leading number of a messier value ("18 in. approx").
  const lead = s.match(/^(\d+(?:\.\d+)?)/);
  return lead ? num(parseFloat(lead[1])) : "";
}
