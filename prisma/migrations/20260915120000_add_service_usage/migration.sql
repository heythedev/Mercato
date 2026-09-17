-- CreateTable
CREATE TABLE "ServiceUsage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service" TEXT NOT NULL,
    "model" TEXT,
    "feature" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ServiceUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceUsage_createdAt_idx" ON "ServiceUsage"("createdAt");

-- CreateIndex
CREATE INDEX "ServiceUsage_service_createdAt_idx" ON "ServiceUsage"("service", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceUsage_feature_createdAt_idx" ON "ServiceUsage"("feature", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceUsage_projectId_idx" ON "ServiceUsage"("projectId");
