import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentAuthGuard } from './auth.guard';
import { LicensingModule } from '../licensing/licensing.module';

@Module({
  imports: [LicensingModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentAuthGuard],
  exports: [AgentsService, AgentAuthGuard],
})
export class AgentsModule {}
