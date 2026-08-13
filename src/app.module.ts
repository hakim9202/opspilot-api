import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AgentsModule } from './modules/agents/agents.module';
import { EventsModule } from './modules/events/events.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { HealthModule } from './modules/health/health.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { LicensingModule } from './modules/licensing/licensing.module';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    LicensingModule,
    AgentsModule,
    EventsModule,
    IncidentsModule,
    DashboardModule,
  ],
})
export class AppModule {}
