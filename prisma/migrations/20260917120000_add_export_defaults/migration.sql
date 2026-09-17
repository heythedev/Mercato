-- CreateTable
CREATE TABLE "ExportDefault" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "attribute" TEXT NOT NULL,
    "label" TEXT,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ExportDefault_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExportDefault_marketplace_attribute_key" ON "ExportDefault"("marketplace", "attribute");

-- CreateIndex
CREATE INDEX "ExportDefault_marketplace_idx" ON "ExportDefault"("marketplace");
