import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { LicensingModule } from '../licensing/licensing.module';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [AgentsModule, IncidentsModule, LicensingModule],
  controllers: [DashboardController],
})
export class DashboardModule {}
