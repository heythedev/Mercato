-- Durable export jobs: job state and the finished ZIP live in the database
-- instead of one server instance's memory, so status polls and downloads work
-- from any instance and survive freezes/restarts.
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "phase" TEXT,
    "error" TEXT,
    "zip" BYTEA,
    "extension" TEXT,
    "contentType" TEXT,
    "missingTemplateCategories" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- createJob prunes on updatedAt (48h retention) — keep that scan indexed.
CREATE INDEX "ExportJob_updatedAt_idx" ON "ExportJob"("updatedAt");
