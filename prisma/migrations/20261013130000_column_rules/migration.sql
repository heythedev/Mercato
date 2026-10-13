-- CreateTable
CREATE TABLE "MarketplaceColumnRule" (
    "id" TEXT NOT NULL,
    "teamId" TEXT,
    "marketplace" TEXT NOT NULL,
    "column" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "find" TEXT,
    "value" TEXT,
    "note" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "MarketplaceColumnRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceColumnRule_marketplace_enabled_idx"
  ON "MarketplaceColumnRule"("marketplace", "enabled");

-- CreateIndex
CREATE INDEX "MarketplaceColumnRule_teamId_idx" ON "MarketplaceColumnRule"("teamId");

-- AddForeignKey
ALTER TABLE "MarketplaceColumnRule" ADD CONSTRAINT "MarketplaceColumnRule_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
