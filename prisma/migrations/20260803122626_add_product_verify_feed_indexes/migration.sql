-- CreateIndex
CREATE INDEX "Product_projectId_idx" ON "Product"("projectId");

-- CreateIndex
CREATE INDEX "Product_projectId_verifiedAt_id_idx" ON "Product"("projectId", "verifiedAt", "id");
