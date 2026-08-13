import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LAB_PLANS,
  LabPlanId,
  clustersAllowed,
  resolvePlan,
} from './plans';

@Injectable()
export class LicensingService {
  constructor(private readonly prisma: PrismaService) {}

  async getLabOrganization() {
    const org = await this.prisma.organization.findUnique({
      where: { slug: 'lab' },
      include: {
        installTokens: { select: { id: true, token: true, label: true, active: true } },
      },
    });
    if (!org) {
      throw new NotFoundException('Lab organization not seeded');
    }
    return org;
  }

  /** Distinct non-revoked cluster names for an organization. */
  async listActiveClusters(organizationId: string): Promise<string[]> {
    const agents = await this.prisma.agent.findMany({
      where: {
        status: { not: 'revoked' },
        installToken: { organizationId },
      },
      select: { clusterName: true },
    });
    return [...new Set(agents.map((a) => a.clusterName).filter(Boolean))];
  }

  async getUsage(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }
    const plan = resolvePlan(org.plan);
    const clusters = await this.listActiveClusters(organizationId);
    const max = org.maxClusters;
    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        status: org.status,
        maxClusters: max,
      },
      plan,
      clustersUsed: clusters.length,
      clusters,
      remaining:
        max < 0 ? null : Math.max(0, max - clusters.length),
      unlimited: max < 0,
      canAddCluster: clustersAllowed(max, clusters.length),
      catalog: Object.values(LAB_PLANS),
    };
  }

  async getLabUsage() {
    const org = await this.getLabOrganization();
    return this.getUsage(org.id);
  }

  /**
   * Throws if org cannot add this clusterName as a new cluster.
   * Re-registering an existing cluster name is always allowed.
   */
  async assertCanRegisterCluster(
    organizationId: string | null | undefined,
    clusterName: string,
  ) {
    if (!organizationId) {
      // Legacy tokens without org — allow (lab migration gap).
      return;
    }
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!org) {
      throw new ForbiddenException('Organization not found for install token');
    }
    if (org.status !== 'active') {
      throw new ForbiddenException(`Organization license is ${org.status}`);
    }

    const clusters = await this.listActiveClusters(organizationId);
    if (clusters.includes(clusterName)) {
      return; // same cluster re-register / replace
    }
    if (!clustersAllowed(org.maxClusters, clusters.length)) {
      const plan = resolvePlan(org.plan);
      throw new ForbiddenException(
        `License limit reached for plan "${plan.label}": ` +
          `${clusters.length}/${org.maxClusters < 0 ? '∞' : org.maxClusters} clusters used. ` +
          `Upgrade the lab plan to register cluster "${clusterName}".`,
      );
    }
  }

  async setLabPlan(planId: string) {
    if (!Object.prototype.hasOwnProperty.call(LAB_PLANS, planId)) {
      throw new BadRequestException(
        `Invalid plan. Use one of: ${Object.keys(LAB_PLANS).join(', ')}`,
      );
    }
    const plan = LAB_PLANS[planId as LabPlanId];
    const org = await this.getLabOrganization();
    return this.prisma.organization.update({
      where: { id: org.id },
      data: {
        plan: plan.id,
        maxClusters: plan.maxClusters,
        status: 'active',
      },
    });
  }
}
