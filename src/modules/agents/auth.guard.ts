import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers['authorization'] as string | undefined;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Empty bearer token');
    }
    const agent = await this.prisma.agent.findUnique({
      where: { accessToken: token },
    });
    if (!agent) {
      throw new UnauthorizedException('Invalid agent token');
    }
    if (agent.status === 'revoked' || agent.revokedAt) {
      throw new UnauthorizedException('Agent has been revoked');
    }
    req.agent = agent;
    return true;
  }
}
