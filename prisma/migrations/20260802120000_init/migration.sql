-- CreateTable
CREATE TABLE "InstallToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstallToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "clusterName" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'registered',
    "labels" JSONB,
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "installTokenId" TEXT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "namespace" TEXT,
    "resource" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "labels" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstallToken_token_key" ON "InstallToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_accessToken_key" ON "Agent"("accessToken");

-- CreateIndex
CREATE INDEX "Incident_agentId_createdAt_idx" ON "Incident"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_type_createdAt_idx" ON "Incident"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_installTokenId_fkey" FOREIGN KEY ("installTokenId") REFERENCES "InstallToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
