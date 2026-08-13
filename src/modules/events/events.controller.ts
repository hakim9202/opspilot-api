import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AgentAuthGuard } from '../agents/auth.guard';
import { BatchEventsDto } from './events.dto';
import { EventsService } from './events.service';

@Controller('v1/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post('batch')
  @UseGuards(AgentAuthGuard)
  batch(@Req() req: any, @Body() body: BatchEventsDto) {
    return this.eventsService.ingestBatch(req.agent.id, body);
  }
}
