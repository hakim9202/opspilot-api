import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LicensingService } from '../licensing/licensing.service';
import { HeartbeatDto, RegisterAgentDto } from './agents.dto';

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly licensing: LicensingService,
  ) {}

  async register(dto: RegisterAgentDto) {
    if (!dto.installToken || !dto.hostname || !dto.clusterName) {
      throw new BadRequestException(
        'installToken, hostname, and clusterName are required',
      );
    }

    const install = await this.prisma.installToken.findUnique({
      where: { token: dto.installToken },
    });
    if (!install || !install.active) {
      throw new UnauthorizedException('Invalid install token');
    }

    await this.licensing.assertCanRegisterCluster(
      install.organizationId,
      dto.clusterName,
    );

    const accessToken = `agt_${randomBytes(32).toString('hex')}`;

    // Same org + cluster → replace existing non-revoked agent (dedupe + license-friendly).
    if (install.organizationId) {
      const existing = await this.prisma.agent.findFirst({
        where: {
          clusterName: dto.clusterName,
          status: { not: 'revoked' },
          installToken: { organizationId: install.organizationId },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        const updated = await this.prisma.agent.update({
          where: { id: existing.id },
          data: {
            hostname: dto.hostname,
            environment: dto.environment || existing.environment || 'lab',
            version: dto.version || existing.version || '0.0.0',
            accessToken,
            status: 'online',
            labels: dto.labels ?? existing.labels ?? {},
            lastHeartbeatAt: new Date(),
            revokedAt: null,
            installTokenId: install.id,
          },
        });
        return {
          agentId: updated.id,
          accessToken: updated.accessToken,
          replaced: true,
        };
      }
    }

    const agent = await this.prisma.agent.create({
      data: {
        hostname: dto.hostname,
        environment: dto.environment || 'lab',
        clusterName: dto.clusterName,
        version: dto.version || '0.0.0',
        accessToken,
        status: 'online',
        labels: dto.labels ?? {},
        lastHeartbeatAt: new Date(),
        installTokenId: install.id,
      },
    });

    return {
      agentId: agent.id,
      accessToken: agent.accessToken,
      replaced: false,
    };
  }

  async heartbeat(agentId: string, dto: HeartbeatDto) {
    const data: Record<string, unknown> = {
      status: dto.status || 'online',
      version: dto.version || undefined,
      lastHeartbeatAt: new Date(),
    };

    if (Array.isArray(dto.pods)) {
      const pods = dto.pods
        .filter((p) => p && p.namespace && p.name)
        .slice(0, 500)
        .map((p) => ({
          namespace: String(p.namespace),
          name: String(p.name),
          status: String(p.status || 'Unknown'),
          ready: p.ready != null && String(p.ready).trim() ? String(p.ready) : undefined,
          restarts: Number.isFinite(Number(p.restarts)) ? Number(p.restarts) : 0,
          age: String(p.age || ''),
          cpu: p.cpu != null && String(p.cpu).trim() ? String(p.cpu) : undefined,
          memory:
            p.memory != null && String(p.memory).trim() ? String(p.memory) : undefined,
        }));
      data.podInventory = pods;
      data.podInventoryAt = new Date();
    }

    if (Array.isArray(dto.containers)) {
      const containers = dto.containers
        .filter((c) => c && c.name)
        .slice(0, 500)
        .map((c) => ({
          name: String(c.name),
          status: String(c.status || 'Unknown'),
          health: c.health != null && String(c.health).trim() ? String(c.health) : undefined,
          restarts: Number.isFinite(Number(c.restarts)) ? Number(c.restarts) : 0,
          age: String(c.age || ''),
          image: c.image != null && String(c.image).trim() ? String(c.image) : undefined,
          service: c.service != null && String(c.service).trim() ? String(c.service) : undefined,
        }));
      data.containerInventory = containers;
      data.containerInventoryAt = new Date();
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: data as any,
    });
    const configuration = await this.getAgentConfiguration();
    const pendingCommands = await this.claimPendingFixCommands(agentId);
    return {
      ok: true,
      configuration,
      pendingCommands,
      podCount: Array.isArray(dto.pods) ? dto.pods.length : undefined,
    };
  }

  /** Claim up to N pending fix commands for this agent heartbeat. */
  async claimPendingFixCommands(agentId: string, limit = 5) {
    const pending = await this.prisma.agentFixCommand.findMany({
      where: { agentId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    if (pending.length === 0) return [];

    const now = new Date();
    const claimed = [];
    for (const cmd of pending) {
      const updated = await this.prisma.agentFixCommand.updateMany({
        where: { id: cmd.id, status: 'pending' },
        data: { status: 'claimed', claimedAt: now },
      });
      if (updated.count === 0) continue;
      claimed.push({
        id: cmd.id,
        type: cmd.type,
        params: normalizeParams(cmd.params),
      });
    }
    return claimed;
  }

  async reportFixCommandStatus(
    agentId: string,
    commandId: string,
    body: { status?: string; result?: string; error?: string },
  ) {
    const cmd = await this.prisma.agentFixCommand.findFirst({
      where: { id: commandId, agentId },
    });
    if (!cmd) throw new NotFoundException('Fix command not found');

    const status = (body.status || '').trim();
    if (status !== 'succeeded' && status !== 'failed') {
      throw new BadRequestException('status must be succeeded or failed');
    }

    return this.prisma.agentFixCommand.update({
      where: { id: commandId },
      data: {
        status,
        result: body.result ? String(body.result).slice(0, 2000) : null,
        error: body.error ? String(body.error).slice(0, 2000) : null,
        completedAt: new Date(),
      },
    });
  }

  async getAgentConfiguration() {
    const patterns = await this.prisma.redactionPattern.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { pattern: true, label: true },
    });
    return {
      redactionPatterns: patterns.map((p) => p.pattern),
      redactionLabels: patterns.map((p) => p.label || p.pattern),
    };
  }

  async revoke(agentId: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    if (agent.status === 'revoked') {
      return { ok: true, agentId, status: 'revoked' };
    }
    // Rotate token so any leaked credential stops working immediately.
    const deadToken = `revoked_${randomBytes(32).toString('hex')}`;
    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
        accessToken: deadToken,
      },
    });
    return { ok: true, agentId, status: 'revoked' };
  }

  async listAgents() {
    const agents = await this.prisma.agent.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        hostname: true,
        environment: true,
        clusterName: true,
        version: true,
        status: true,
        lastHeartbeatAt: true,
        revokedAt: true,
        createdAt: true,
        labels: true,
        podInventory: true,
        podInventoryAt: true,
        containerInventory: true,
        containerInventoryAt: true,
      },
    });

    const now = Date.now();
    return agents.map((a) => {
      if (a.status === 'revoked') {
        return { ...a, status: 'revoked' as const };
      }
      const stale =
        !a.lastHeartbeatAt || now - a.lastHeartbeatAt.getTime() > 90_000;
      return {
        ...a,
        status: stale ? 'offline' : a.status,
      };
    });
  }

  async getAgent(id: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      select: {
        id: true,
        hostname: true,
        environment: true,
        clusterName: true,
        version: true,
        status: true,
        lastHeartbeatAt: true,
        revokedAt: true,
        createdAt: true,
        labels: true,
        podInventory: true,
        podInventoryAt: true,
        containerInventory: true,
        containerInventoryAt: true,
      },
    });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    const now = Date.now();
    let status = agent.status;
    if (status !== 'revoked') {
      const stale =
        !agent.lastHeartbeatAt ||
        now - agent.lastHeartbeatAt.getTime() > 90_000;
      status = stale ? 'offline' : status;
    }
    return { ...agent, status };
  }

  async listRedactionPatterns() {
    return this.prisma.redactionPattern.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async addRedactionPattern(pattern: string, label?: string) {
    const trimmed = (pattern || '').trim();
    if (!trimmed) {
      throw new BadRequestException('pattern is required');
    }
    try {
      // Validate regex compiles.
      // eslint-disable-next-line no-new
      new RegExp(trimmed);
    } catch {
      throw new BadRequestException('pattern is not a valid regular expression');
    }
    return this.prisma.redactionPattern.create({
      data: {
        pattern: trimmed,
        label: (label || '').trim() || null,
        enabled: true,
      },
    });
  }

  async deleteRedactionPattern(id: string) {
    try {
      await this.prisma.redactionPattern.delete({ where: { id } });
    } catch {
      throw new NotFoundException('Pattern not found');
    }
    return { ok: true };
  }

  async setRedactionPatternEnabled(id: string, enabled: boolean) {
    try {
      return await this.prisma.redactionPattern.update({
        where: { id },
        data: { enabled },
      });
    } catch {
      throw new NotFoundException('Pattern not found');
    }
  }
}

function normalizeParams(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}
