import { Body, Controller, Get, Post } from '@nestjs/common';
import { LicensingService } from './licensing.service';

@Controller('v1/license')
export class LicensingController {
  constructor(private readonly licensing: LicensingService) {}

  @Get()
  usage() {
    return this.licensing.getLabUsage();
  }

  /** Lab-only: switch plan without payment. */
  @Post('plan')
  setPlan(@Body() body: { plan?: string }) {
    return this.licensing.setLabPlan(body.plan || 'free');
  }
}
