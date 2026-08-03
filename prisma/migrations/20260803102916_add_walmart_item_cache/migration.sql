-- CreateTable
CREATE TABLE "WalmartItemCache" (
    "code" TEXT NOT NULL,
    "item" JSONB,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalmartItemCache_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "WalmartItemCache_fetchedAt_idx" ON "WalmartItemCache"("fetchedAt");
