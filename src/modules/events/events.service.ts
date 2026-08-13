import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiSuggestionService } from '../incidents/ai-suggestion.service';
import { IncidentsService } from '../incidents/incidents.service';
import { BatchEventsDto } from './events.dto';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSuggestions: AiSuggestionService,
    private readonly incidents: IncidentsService,
  ) {}

  async ingestBatch(agentId: string, dto: BatchEventsDto) {
    if (!dto?.events || !Array.isArray(dto.events)) {
      throw new BadRequestException('events array is required');
    }
    if (dto.events.length === 0) {
      return { accepted: 0 };
    }
    if (dto.events.length > 200) {
      throw new BadRequestException('max 200 events per batch');
    }

    const created: Array<{
      id: string;
      type: string;
      severity: string;
      title: string;
      message: string;
      namespace: string | null;
      resource: string | null;
      reason: string | null;
      metadata: unknown;
    }> = [];

    for (const e of dto.events) {
      if (!e.type || !e.title || !e.message || !e.occurredAt) {
        throw new BadRequestException(
          'each event requires type, title, message, occurredAt',
        );
      }
      const occurredAt = new Date(e.occurredAt);
      const snapshotRaw =
        e.snapshot && typeof e.snapshot === 'object'
          ? e.snapshot
          : this.incidents.composeSnapshotFromMetadata({
              type: e.type,
              reason: e.reason,
              namespace: e.namespace,
              resource: e.resource,
              occurredAt,
              metadata: e.metadata,
            });
      const snapshot = JSON.parse(JSON.stringify(snapshotRaw)) as Prisma.InputJsonValue;

      const row = await this.prisma.incident.create({
        data: {
          agentId,
          type: e.type,
          severity: e.severity || 'warning',
          title: e.title,
          message: e.message,
          namespace: e.namespace,
          resource: e.resource,
          reason: e.reason,
          occurredAt,
          labels: (e.labels ?? {}) as Prisma.InputJsonValue,
          metadata: (e.metadata ?? {}) as Prisma.InputJsonValue,
          snapshot,
        },
      });
      created.push(row);
    }

    void this.aiSuggestions.enrichMany(created).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI enrich after ingest failed: ${msg}`);
    });

    return { accepted: created.length };
  }
}
