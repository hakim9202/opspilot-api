import { Controller, Get, Param, Query } from '@nestjs/common';
import { IncidentsService } from './incidents.service';

@Controller('v1/incidents')
export class IncidentsController {
  constructor(private readonly incidentsService: IncidentsService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 50;
    return this.incidentsService.list(Number.isFinite(n) ? n : 50);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.incidentsService.getById(id);
  }
}
