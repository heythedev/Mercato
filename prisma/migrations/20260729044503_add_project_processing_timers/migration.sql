-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "categorizeCompletedAt" TIMESTAMP(3),
ADD COLUMN     "categorizeMs" INTEGER,
ADD COLUMN     "verifyCompletedAt" TIMESTAMP(3),
ADD COLUMN     "verifyMs" INTEGER;
