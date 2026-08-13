import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AgentsService } from './agents.service';
import { HeartbeatDto, RegisterAgentDto } from './agents.dto';
import { AgentAuthGuard } from './auth.guard';

@Controller('v1/agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post('register')
  register(@Body() body: RegisterAgentDto) {
    return this.agentsService.register(body);
  }

  @Post('heartbeat')
  @UseGuards(AgentAuthGuard)
  heartbeat(@Req() req: any, @Body() body: HeartbeatDto) {
    return this.agentsService.heartbeat(req.agent.id, body);
  }

  @Post('commands/:id/status')
  @UseGuards(AgentAuthGuard)
  reportCommandStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { status?: string; result?: string; error?: string },
  ) {
    return this.agentsService.reportFixCommandStatus(req.agent.id, id, body);
  }

  /** Push redaction patterns / future remote config to the agent. */
  @Get('config')
  @UseGuards(AgentAuthGuard)
  config() {
    return this.agentsService.getAgentConfiguration();
  }

  @Get('settings/redaction')
  listRedaction() {
    return this.agentsService.listRedactionPatterns();
  }

  @Post('settings/redaction')
  addRedaction(@Body() body: { pattern?: string; label?: string }) {
    return this.agentsService.addRedactionPattern(body.pattern || '', body.label);
  }

  @Delete('settings/redaction/:id')
  deleteRedaction(@Param('id') id: string) {
    return this.agentsService.deleteRedactionPattern(id);
  }

  @Patch('settings/redaction/:id')
  patchRedaction(
    @Param('id') id: string,
    @Body() body: { enabled?: boolean },
  ) {
    return this.agentsService.setRedactionPatternEnabled(id, Boolean(body.enabled));
  }

  @Get()
  list() {
    return this.agentsService.listAgents();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.agentsService.getAgent(id);
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string) {
    return this.agentsService.revoke(id);
  }
}
