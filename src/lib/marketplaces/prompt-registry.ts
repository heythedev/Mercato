import type { PromptCtx } from "./prompt-ctx";

/**
 * The per-marketplace TEXT of the categorisation prompt.
 *
 * This used to be six ternary chains inside the prompt builder, each naming
 * the same marketplaces in a slightly different order, so adding one meant
 * finding all six and appending a branch to each. A branch missed left a
 * marketplace silently inheriting another's wording — Best Buy once carried
 * "Best Buy sells ONLY electronics", written for a 230-path electronics list,
 * and confidently refused 66 of 118 products against the real 1,450-leaf
 * taxonomy.
 *
 * The strings here are the originals, moved character for character. They are
 * what categorisation accuracy rests on — 92% measured against the Mathis
 * catalogue — and the move was verified by rendering 475,840 characters of
 * prompt across every marketplace, before and after, and diffing.
 *
 * A marketplace with no entry falls back to DEFAULT_PIECES, which is the
 * generic wording an unconstrained marketplace already got.
 */
export type PromptPiece = (ctx: PromptCtx) => string;

export type PromptPieces = {
  storeContext?: PromptPiece;
  reasoningInstruction?: PromptPiece;
  jsonExample?: PromptPiece;
  pathHint?: PromptPiece;
  mathisSizeRule?: PromptPiece;
  temuDisambiguationRule?: PromptPiece;
};

export const DEFAULT_PIECES: Required<PromptPieces> = {
  storeContext: () => "You are a product categorization expert for a major retail marketplace.",
  reasoningInstruction: () => `For each product, first think: "What is this product? What does it do / who uses it?" — then pick the best category. Use your knowledge of real-world products.`,
  jsonExample: () => `[{"index":1,"category":"Category Name","path":"Category Name","confidence":0.95},...]`,
  pathHint: () => `- path: full path e.g. "Mathis Brothers > Seasonal"`,
  mathisSizeRule: () => "",
  temuDisambiguationRule: () => "",
};

export const PROMPTS: Record<string, PromptPieces> = {
  mathis: {
    storeContext: () => "You are a product categorization expert for Mathis Brothers / Mathis Home. You are given the official Mirakl taxonomy sheet (Department > Category > Subcategory > Product Type). Your job is to match each product to the leaf path whose NAME best matches the product type — using ONLY the taxonomy list. Do not invent paths. Do not relocate a product to a different department based on assumptions about adult vs kids, room type, or how a retailer 'usually' organizes furniture.",
    reasoningInstruction: () => `For each product, match it using the TAXONOMY only:
STEP 1 — Identify the product type from the name/description (e.g. "Daybed", "Sofa", "Crib", "Table Lamp").
STEP 2 — Search the taxonomy list for a leaf (or path segment) with that same product-type name.
STEP 3 — If exactly one path contains that leaf (e.g. Daybeds only under Baby & Kids), YOU MUST use that path. Do not pick a "similar" adult Furniture path like Sofas.
STEP 4 — Only if no product-type leaf matches, fall back to the closest listed path — still from the list only.
Do NOT use outside assumptions (adult daybed → living room sofas, etc.). The taxonomy is the source of truth.`,
    jsonExample: () => `[{"index":1,"category":"Baby & Kids > Kids Furniture > Daybeds","path":"Baby & Kids > Kids Furniture > Daybeds","confidence":0.95},...]`,
    pathHint: () => `- category and path: must be the exact leaf path from the taxonomy sheet (e.g. "Baby & Kids > Kids Furniture > Daybeds" when the product is a daybed — because that is where Daybeds lives on the sheet)`,
    mathisSizeRule: () => `
MATHIS RULES (mandatory — taxonomy over assumptions):
1. Match by PRODUCT TYPE NAME in the taxonomy first. Example: product is a "Daybed" and the sheet only has "Baby & Kids > Kids Furniture > Daybeds" → assign that path. Never substitute Sofas, Beds, or Living Room because it "looks adult".
2. Department names on the sheet are organizational labels for Mirakl — they are NOT a signal to re-interpret the product. A daybed under Baby & Kids stays Baby & Kids even if branding/size feels adult.
3. Never invent a path. Never pick a nearby category that is a different product type.
4. Prefer the deepest leaf that literally matches the product type.
5. Use "Uncategorized" only if no listed path's product type matches at all.
6. Lighting → "Decor > Lighting …". Window treatments → "Decor > Window Treatments …". Holiday decor → "Seasonal > …".
7. OUTDOOR EXCEPTION to rule 1: a product explicitly for outdoor/patio use ("Outdoor", "Patio", "Garden" in the name) MUST stay in the "Outdoor > …" department. If no Outdoor leaf names its exact type, use the closest Outdoor path (outdoor patio daybed → "Outdoor > Outdoor Seating > Outdoor Sectionals" or the nearest Outdoor Seating leaf — NEVER "Baby & Kids > Kids Furniture > Daybeds").`,
  },
  temu: {
    storeContext: () => "You are a product categorization expert for the Temu marketplace seller portal. You are given the EXACT Temu category taxonomy (Category > Sub-Category > Product Type) sourced directly from Temu's seller listing system. Your job is to match each product to the single most specific leaf path from that taxonomy — using ONLY the paths listed. The output must be directly usable for listing on Temu's seller portal without any manual remapping. Do not invent paths. Do not shorten paths to 1 or 2 levels. Always output the full 3-level path.",
    reasoningInstruction: () => `For EACH product, follow these steps in order:
STEP 1 — Identify what the product physically IS. State the core noun (e.g. "top hat", "kippah", "crown", "costume suit", "necklace"). Ignore audience (kids/adults) and color at this step.
STEP 2 — Find the taxonomy section that covers that physical object type. Example: any hat → look in "Jewelry & Accessories > Hats & Caps"; any crown/tiara → "Jewelry & Accessories > Crowns & Tiaras"; any kids costume → "Holidays & Party > Costumes & Dress-Up".
STEP 3 — Pick the single leaf within that section that most closely matches. Copy it character-for-character.
IMPORTANT: Base the category on WHAT the item is, not who it's for. A hat for a child is still a hat → Hats & Caps, not Kids' Clothing.`,
    jsonExample: () => `[{"index":1,"category":"Jewelry & Accessories > Hats & Caps > Baseball Caps","path":"Jewelry & Accessories > Hats & Caps > Baseball Caps","confidence":0.95},{"index":2,"category":"Holidays & Party > Costumes & Dress-Up > Kids' Costumes","path":"Holidays & Party > Costumes & Dress-Up > Kids' Costumes","confidence":0.90},...]`,
    pathHint: () => `- category and path: must be the exact leaf path from the taxonomy sheet (e.g. "Jewelry & Accessories > Crowns & Tiaras > Crowns" for a crown, "Holidays & Party > Costumes & Dress-Up > Kids' Costumes" for a children's costume, "Jewelry & Accessories > Hats & Caps > Religious & Cultural Hats" for a kipah or tarboosh)`,
    temuDisambiguationRule: () => `
TEMU DISAMBIGUATION (apply when more than one section could fit — resolve by PRIMARY FUNCTION, not by audience, brand, color, or theme):
1. AUDIENCE ISN'T A CATEGORY. A hat, shoe, or necklace for a child is still a hat/shoe/necklace → its object section (Jewelry & Accessories, Shoes), NOT "Kids & Baby". Use "Kids & Baby" only for items that are inherently infant/toddler gear (diapers, baby bottles, cribs, strollers).
2. FUNCTION OVER ATTACHMENT. Categorize by what the item IS, not what it holds or connects to. A phone case → Electronics accessories, NOT Bags & Luggage. A watch band → Jewelry & Accessories, NOT Electronics. A laptop sleeve → Bags & Luggage only if it is a carry bag, else Electronics accessory.
3. APPAREL vs COSTUME. Everyday wearable clothing → Men's/Women's Clothing. Themed/holiday/character dress-up → "Holidays & Party > Costumes & Dress-Up". A "kids suit" for daily wear is clothing; a "kids pirate outfit" is a costume.
4. DECOR vs SEASONAL. Generic home decor → "Home & Garden". Items tied to a specific holiday (Christmas, Halloween, Easter) → "Holidays & Party".
5. MATERIAL/CRAFT vs FINISHED GOOD. Raw supplies to make something → "Arts & Crafts" or "Office & School Supplies". A finished decorated object → its object section.
6. TOOL vs APPLIANCE. Hand/power tools → "Tools & Home Improvement". Plug-in household machines (blender, vacuum, air fryer) → "Home Appliances". Kitchen-specific electric gadgets → "Kitchen & Dining".
7. SPORT/OUTDOOR vs GENERAL. Gear used for a specific sport or outdoor activity → "Sports & Outdoors". General-use versions of the same object go to their object section (a plain water bottle → Kitchen & Dining; a hydration pack → Sports & Outdoors).
8. When two leaves remain equally valid after these rules, pick the MORE SPECIFIC leaf and lower your confidence (≤0.7) so it is flagged for review.`,
  },
  bestbuy: {
    storeContext: () => "You are a product categorization expert for the Best Buy marketplace. Best Buy sells ONLY electronics, computers, home appliances, home theater, gaming, cameras, mobile devices, and health/fitness tech. You are given the EXACT Best Buy category taxonomy (Category > Subcategory > Sub-Subcategory). Match each product to the single most specific leaf path from that taxonomy — using ONLY the paths listed. If a product clearly does not belong on Best Buy (construction tools, masonry materials, hardware supplies, industrial parts, raw materials, etc.), use 'Uncategorized'. Do not invent paths. Always output the full 3-level path for products that DO belong on Best Buy.",
    reasoningInstruction: () => `For EACH product, follow these steps:
STEP 1 — Ask: "Is this an electronics, computer, appliance, home theater, gaming, camera, mobile device, or health/fitness tech product?" If NO (e.g. it is a construction tool, masonry supply, hardware material, industrial part, acid brush, raw material, plumbing part) → assign "Uncategorized" immediately. Do not go to step 2.
STEP 2 — Identify the product's primary technology function (e.g. "wireless headphones", "laptop", "smart doorbell").
STEP 3 — Find the Best Buy taxonomy section matching that function (e.g. headphones → Audio > Headphones; laptop → Computers & Tablets > Laptops).
STEP 4 — Pick the single leaf that most closely matches the product's specific type. Copy it character-for-character.`,
    jsonExample: () => `[{"index":1,"category":"Audio > Headphones > Wireless Headphones","path":"Audio > Headphones > Wireless Headphones","confidence":0.95},{"index":2,"category":"Computers & Tablets > Laptops > Gaming Laptops","path":"Computers & Tablets > Laptops > Gaming Laptops","confidence":0.90},...]`,
    pathHint: () => `- category and path: must be the exact leaf path from the Best Buy taxonomy (e.g. "Audio > Headphones > Wireless Headphones" for wireless headphones, "Computers & Tablets > Laptops > Gaming Laptops" for a gaming laptop)`,
  },
  sears: {
    storeContext: () => "You are a product categorization expert for the Sears Marketplace. You are given the EXACT Sears category taxonomy (Category > Subcategory > Sub-Subcategory). Match each product to the single most specific leaf path from that taxonomy — using ONLY the paths listed. Sears sells tools, appliances, clothing, electronics, lawn care, automotive, and home goods. Do not invent paths. Always output the full 3-level path.",
    reasoningInstruction: () => `For EACH product, follow these steps:
STEP 1 — Identify what department the product belongs to on Sears (Appliances, Tools & Hardware, Clothing, Electronics, Lawn & Garden, etc.).
STEP 2 — Find the matching section in the Sears taxonomy, then narrow to the right subcategory and leaf.
STEP 3 — Copy the full 3-level path character-for-character.`,
    jsonExample: () => `[{"index":1,"category":"Tools & Hardware > Power Tools > Drills & Drivers","path":"Tools & Hardware > Power Tools > Drills & Drivers","confidence":0.95},{"index":2,"category":"Appliances > Major Appliances > Refrigerators","path":"Appliances > Major Appliances > Refrigerators","confidence":0.90},...]`,
    pathHint: () => `- category and path: must be the exact leaf path from the Sears taxonomy (e.g. "Tools & Hardware > Power Tools > Drills & Drivers" for a drill, "Appliances > Major Appliances > Refrigerators" for a fridge)`,
  },
  walmart: {
    storeContext: (ctx) => ctx.walmartRichMode
      ? `You are a product categorization expert for the Walmart Marketplace seller portal. You are given Walmart's OFFICIAL item taxonomy (Category > Product Type Group), sourced directly from Walmart's Marketplace taxonomy API. Match each product to the single most specific 2-level path from that taxonomy — using ONLY the paths listed, copied character-for-character. Do not invent paths. Do not shorten a path to just the category. The output must be a real Walmart taxonomy entry usable for listing without manual remapping.
Disambiguation rules:
- Match by what the product physically IS (its core noun/function), not who it's for or what it attaches to
- Sport/activity gear → "Sports & Outdoors > …" (cycling, fishing, camping, fitness, hunting)
- Hand/power tools and building materials → "Home Improvement > …"
- Kitchenware, decor, bedding, storage → "Home > …"
- A product for a child is still its object type (a kids' bike → Sports & Outdoors cycling group, not Toys) unless it is inherently a toy or baby gear`
      : `You are a product categorization expert for the Walmart Marketplace seller portal. You are given the EXACT category list that Walmart's MP Item Setup template accepts (75 values). Match each product to the single closest category from that list — using ONLY the entries provided verbatim. Important mapping rules for Walmart's non-obvious category names:
- "Sports & Recreation Other" covers ALL sports, fitness, cycling, outdoor recreation, camping, hunting, fishing
- "Garden & Patio" covers outdoor furniture, planters, garden decor, patio accessories
- "Home Decor, Kitchen, & Other" covers kitchen gadgets, cookware, bakeware, home accessories, candles, frames, rugs
- "Household Cleaning Products & Supplies" covers cleaning chemicals, mops, vacuums, trash bags
- "Electronics Accessories" covers cables (NON-HDMI), chargers, cases, screen protectors, mounts
- "Electronics Cables" covers HDMI, DisplayPort, audio, networking, USB cables
- "Tools" covers hand tools and power tools (drills, saws, wrenches, screwdrivers)
- "Hardware" covers nuts, bolts, screws, brackets, fasteners, hinges, anchors
- "Building Supply" covers lumber, drywall, insulation, flooring, paint, masonry
- "Medical Aids & Equipment" covers mobility aids, medical devices, first aid
- "Beauty, Personal Care, & Hygiene" covers makeup, skincare, haircare, razors, oral care
- "Baby Transport" covers strollers, car seats, carriers, bouncers
Do not invent categories. Output only values that appear verbatim in the list.`,
    reasoningInstruction: (ctx) => ctx.walmartRichMode
      ? `For EACH product, follow these steps:
STEP 1 — Identify what the product physically IS (its core noun and function) from the NAME alone — ignore the [vendor category] tag at this step: e.g. "bicycle lock", "yoga mat", "kitchen knife", "baby stroller".
STEP 2 — Find the taxonomy CATEGORY that covers that object type (e.g. bicycle lock → Sports & Outdoors; kitchen knife → Home; table lamp → Home).
STEP 3 — Within that category, pick the Product Type Group whose name most closely matches the product (e.g. "Sports & Outdoors > Cycling", "Home > Kitchen Cutting Utensils & Tools", "Home > Lamps and Light Bulbs Lighting & Light Fixtures").
STEP 4 — Copy the full 2-level path character-for-character from the list.`
      : `For EACH product, follow these steps:
STEP 1 — Identify what the product physically IS (its core noun and function) from the NAME alone — ignore the [vendor category] tag at this step: e.g. "bicycle lock", "yoga mat", "kitchen knife", "baby stroller".
STEP 2 — Use the category descriptions in your instructions to find the BEST matching Walmart template category. Remember: "Sports & Recreation Other" covers ALL cycling/fitness/sports gear; "Tools" covers hand/power tools; "Hardware" covers fasteners/brackets.
STEP 3 — When two categories seem equally valid, pick the MORE SPECIFIC one (e.g. "Bedding" over "Home Decor, Kitchen, & Other" for a comforter; "Baby Transport" over "Baby Diapering, Care, & Other" for a stroller).
STEP 4 — Copy the chosen category character-for-character from the list.`,
    jsonExample: (ctx) => ctx.walmartRichMode
      ? `[{"index":1,"category":"Sports & Outdoors > Cycling","path":"Sports & Outdoors > Cycling","confidence":0.95},{"index":2,"category":"Home > Kitchen Cutting Utensils & Tools","path":"Home > Kitchen Cutting Utensils & Tools","confidence":0.9},...]`
      : `[{"index":1,"category":"Furniture","path":"Furniture","confidence":0.95},{"index":2,"category":"Home Decor, Kitchen, & Other","path":"Home Decor, Kitchen, & Other","confidence":0.9},...]`,
  },
};

/** One piece of prompt text for a marketplace, falling back to the generic. */
export function promptPiece(
  marketplaceId: string,
  name: keyof PromptPieces,
  ctx: PromptCtx,
): string {
  const fn = PROMPTS[marketplaceId]?.[name] ?? DEFAULT_PIECES[name];
  return fn(ctx);
}
