import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [AgentsModule, IncidentsModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
