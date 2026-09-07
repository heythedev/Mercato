-- Speeds up lib/categorize/category-reuse.ts's cross-project SKU identity
-- reuse lookup (findResolvedNamesBySku), which matches products by normalized
-- vendor SKU (lower(trim("vendorSku"))) across the WHOLE Product table. Without
-- this it is a sequential scan computing the expression on every row — measured
-- at ~6s for a 4,811-SKU file against an 88k-row table.
--
-- Same shape and same caveat as 20260907160219_add_product_normalized_name_index:
-- CONCURRENTLY (Product is written continuously by live runs) cannot run inside a
-- transaction, and this project's pooled DATABASE_URL makes `prisma migrate`
-- hang, so the index was created directly via a one-off pg script; kept here so
-- a fresh, non-pooled database gets it through the normal migrate flow.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Product_norm_sku_idx"
  ON "Product" (lower(trim("vendorSku")));
