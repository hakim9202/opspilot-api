import { Module } from '@nestjs/common';
import { LicensingService } from './licensing.service';
import { LicensingController } from './licensing.controller';

@Module({
  providers: [LicensingService],
  controllers: [LicensingController],
  exports: [LicensingService],
})
export class LicensingModule {}
