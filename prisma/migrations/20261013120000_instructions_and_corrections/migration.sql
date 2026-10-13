-- CreateTable
CREATE TABLE "MarketplaceInstruction" (
    "id" TEXT NOT NULL,
    "teamId" TEXT,
    "marketplace" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "MarketplaceInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceInstruction_teamId_marketplace_key"
  ON "MarketplaceInstruction"("teamId", "marketplace");

-- Postgres treats NULLs as distinct, so the constraint above does not stop two
-- GLOBAL rows sharing a marketplace. This partial index does.
CREATE UNIQUE INDEX "MarketplaceInstruction_global_marketplace_key"
  ON "MarketplaceInstruction"("marketplace") WHERE "teamId" IS NULL;

-- CreateIndex
CREATE INDEX "MarketplaceInstruction_marketplace_idx" ON "MarketplaceInstruction"("marketplace");

-- AddForeignKey
ALTER TABLE "MarketplaceInstruction" ADD CONSTRAINT "MarketplaceInstruction_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
--
-- No foreign key to Product, and no cascade. The product row is the least
-- durable thing here — projects are deleted routinely — and a correction whose
-- product is gone still says what this marketplace wanted in that column.
CREATE TABLE "AttributeCorrection" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "marketplace" TEXT NOT NULL,
    "category" TEXT,
    "attribute" TEXT NOT NULL,
    "was" TEXT NOT NULL,
    "corrected" TEXT NOT NULL,
    "wasSource" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributeCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttributeCorrection_marketplace_attribute_idx"
  ON "AttributeCorrection"("marketplace", "attribute");

-- CreateIndex
CREATE INDEX "AttributeCorrection_createdAt_idx" ON "AttributeCorrection"("createdAt");
