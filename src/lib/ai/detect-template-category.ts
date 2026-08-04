import { generateText } from "ai";
import { moonshot, MOONSHOT_TEXT_MODEL } from "@/lib/ai/moonshot";

const GENERIC_SHEET = /^(sheet\d*|template|data|catalog|products?|items?|listing|upload|feed|export|flatfile|flat.?file)$/i;
const GENERIC_FILE_WORDS = /\b(template|walmart|amazon|bestbuy|best.buy|marketplace|export|upload|listing|catalog|products?|items?|data|feed|flat.?file|v\d+|\d{4,})\b/gi;

export async function detectTemplateCategory(
  filename: string,
  sheetName: string | null,
  columns: string[],
): Promise<string | null> {
  // 1. Sheet name heuristic — if not generic it usually IS the category
  const cleanSheet = sheetName?.trim() ?? "";
  if (cleanSheet && !GENERIC_SHEET.test(cleanSheet)) {
    return cleanSheet;
  }

  // 2. Filename heuristic — strip generic words, keep what's left
  const baseName = filename.replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ");
  const stripped = baseName.replace(GENERIC_FILE_WORDS, " ").replace(/\s+/g, " ").trim();
  if (stripped.length > 2 && !/^\d+$/.test(stripped)) {
    // Capitalise words
    return stripped.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // 3. AI fallback — infer from column headers + filename
  try {
    const { text } = await generateText({
      model: moonshot(MOONSHOT_TEXT_MODEL),
      prompt: `What product category does this marketplace template file belong to?
Filename: ${filename}
Sheet: ${sheetName ?? "none"}
Column headers: ${columns.slice(0, 25).join(", ")}

Reply with ONLY the category name (e.g. "Clothing", "Home & Kitchen", "Electronics", "Quilts & Bedding"). No explanation, no quotes.`,
      maxOutputTokens: 30,
    });
    const result = text.trim().replace(/^["']|["']$/g, "");
    return result || null;
  } catch {
    return null;
  }
}
