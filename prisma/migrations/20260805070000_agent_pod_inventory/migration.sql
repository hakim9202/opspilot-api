-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "podInventory" JSONB;
ALTER TABLE "Agent" ADD COLUMN "podInventoryAt" TIMESTAMP(3);
