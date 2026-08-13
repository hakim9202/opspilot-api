-- CreateTable
CREATE TABLE "AgentFixCommand" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "incidentId" TEXT,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "error" TEXT,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFixCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentFixCommand_agentId_status_idx" ON "AgentFixCommand"("agentId", "status");

-- CreateIndex
CREATE INDEX "AgentFixCommand_incidentId_idx" ON "AgentFixCommand"("incidentId");

-- AddForeignKey
ALTER TABLE "AgentFixCommand" ADD CONSTRAINT "AgentFixCommand_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFixCommand" ADD CONSTRAINT "AgentFixCommand_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;
