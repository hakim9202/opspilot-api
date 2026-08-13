-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "revokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RedactionPattern" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedactionPattern_pkey" PRIMARY KEY ("id")
);
