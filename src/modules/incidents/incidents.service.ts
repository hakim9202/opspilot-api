import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiSuggestionService } from './ai-suggestion.service';
import {
  buildAutoFixCommands,
  buildAgentFixPlan,
  getSuggestionAction,
  type AutoFixCommand,
  type SuggestionAction,
} from './auto-fix';
import {
  inferDeploymentFromPodName,
  podHistoryResourceMatchers,
} from './pod-history';
import { displayFixForSeverity } from './suggestion-display';

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSuggestions: AiSuggestionService,
  ) {}

  async list(limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.incident.findMany({
      take,
      orderBy: { occurredAt: 'desc' },
      include: {
        agent: {
          select: {
            id: true,
            hostname: true,
            clusterName: true,
            environment: true,
          },
        },
      },
    });
  }

  /**
   * Timeline for a pod: pod-scoped incidents plus owner Deployment rollouts/unhealthy.
   */
  async listForPod(
    agentId: string,
    namespace: string,
    podName: string,
    limit = 100,
  ) {
    const take = Math.min(Math.max(limit, 1), 200);
    const deploy = inferDeploymentFromPodName(podName);
    const resources = podHistoryResourceMatchers(podName, deploy);
    return this.prisma.incident.findMany({
      where: {
        agentId,
        namespace,
        resource: { in: resources },
      },
      orderBy: { occurredAt: 'desc' },
      take,
      select: {
        id: true,
        type: true,
        severity: true,
        title: true,
        message: true,
        reason: true,
        resource: true,
        namespace: true,
        occurredAt: true,
        suggestedFix: true,
        snapshot: true,
        metadata: true,
      },
    });
  }

  async getById(id: string) {
    const row = await this.prisma.incident.findUnique({
      where: { id },
      include: {
        agent: {
          select: {
            id: true,
            hostname: true,
            clusterName: true,
            environment: true,
            version: true,
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundException('Incident not found');
    }
    return row;
  }

  aiConfigured() {
    return this.aiSuggestions.isConfigured();
  }

  displaySuggestedFix(
    stored: string | null | undefined,
    severity?: string | null,
  ) {
    return displayFixForSeverity(stored, severity, (s) =>
      this.aiSuggestions.displaySuggestion(s),
    );
  }

  /** apply | view | null — drives row button label and destination. */
  suggestionAction(incident: {
    type?: string | null;
    resource?: string | null;
    suggestedFix?: string | null;
    metadata?: unknown;
  }): SuggestionAction {
    return getSuggestionAction(incident);
  }

  autoFixCommands(incident: {
    type?: string | null;
    reason?: string | null;
    namespace?: string | null;
    resource?: string | null;
    suggestedFix?: string | null;
    metadata?: unknown;
  }): AutoFixCommand[] {
    if (!getSuggestionAction(incident)) return [];
    return buildAutoFixCommands(incident);
  }

  async listFixCommandsForIncident(incidentId: string) {
    return this.prisma.agentFixCommand.findMany({
      where: { incidentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }

  async enqueueAgentFix(
    incidentId: string,
    input: {
      memoryLimit?: string;
      memoryRequest?: string;
      container?: string;
      image?: string;
      deployAction?: string;
      replicas?: string;
      acknowledge?: string;
    },
  ) {
    if (input.acknowledge !== '1') {
      throw new BadRequestException('Confirmation checkbox is required');
    }
    const incident = await this.getById(incidentId);
    let plan;
    try {
      plan = buildAgentFixPlan(incident, input);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid fix parameters',
      );
    }

    // Cancel other pending commands for this incident.
    await this.prisma.agentFixCommand.updateMany({
      where: {
        incidentId,
        status: { in: ['pending', 'claimed'] },
      },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    return this.prisma.agentFixCommand.create({
      data: {
        agentId: incident.agentId,
        incidentId: incident.id,
        type: plan.type,
        params: plan.params,
        status: 'pending',
      },
    });
  }

  /** Build a snapshot from flat metadata when agent did not send one. */
  composeSnapshotFromMetadata(input: {
    type: string;
    reason?: string | null;
    namespace?: string | null;
    resource?: string | null;
    occurredAt: Date;
    metadata?: unknown;
  }) {
    const meta =
      input.metadata &&
      typeof input.metadata === 'object' &&
      !Array.isArray(input.metadata)
        ? (input.metadata as Record<string, unknown>)
        : {};

    const str = (k: string) =>
      meta[k] !== undefined && meta[k] !== null && String(meta[k]) !== ''
        ? String(meta[k])
        : undefined;

    const resourceName = (input.resource || '').replace(/^pod\//, '');
    const evidence: string[] = [];
    const cause = str('cause') || input.reason || undefined;
    if (cause) evidence.push(`cause=${cause}`);
    if (str('exitCode')) evidence.push(`exitCode=${str('exitCode')}`);
    if (str('waitingReason')) evidence.push(`waitingReason=${str('waitingReason')}`);
    if (str('terminatedReason'))
      evidence.push(`terminatedReason=${str('terminatedReason')}`);
    if (str('logSnippet')) evidence.push(`log=${str('logSnippet')}`);

    return {
      version: 1,
      capturedAt: input.occurredAt.toISOString(),
      composed: true,
      resource: {
        kind: 'Pod',
        name: resourceName || undefined,
        namespace: input.namespace || undefined,
      },
      status: {
        type: input.type,
        phase: str('phase'),
        cause,
        waitingReason: str('waitingReason'),
        terminatedReason: str('terminatedReason'),
        exitCode: str('exitCode'),
        restartCount: str('restartCount'),
      },
      container: str('container')
        ? { name: str('container') }
        : undefined,
      logs: str('logSnippet')
        ? { snippet: str('logSnippet') }
        : undefined,
      evidence,
    };
  }
}
