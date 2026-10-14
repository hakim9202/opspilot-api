-- AlterTable
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "containerInventory" JSONB;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "containerInventoryAt" TIMESTAMP(3);
