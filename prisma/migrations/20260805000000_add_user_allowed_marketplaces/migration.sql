-- Adds User.allowedMarketplaces, which was previously applied to the database
-- via `prisma db push` without a migration (schema/migration drift). This
-- migration records it so fresh databases (e.g. the Neon instance) match schema.
ALTER TABLE "User" ADD COLUMN "allowedMarketplaces" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
