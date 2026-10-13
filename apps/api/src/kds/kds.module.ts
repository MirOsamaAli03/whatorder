import { Module } from '@nestjs/common';
import { KdsController } from './kds.controller';
import { KdsPresenceService } from './kds-presence.service';
import { KdsService } from './kds.service';

@Module({
  controllers: [KdsController],
  providers: [KdsService, KdsPresenceService],
  exports: [KdsService, KdsPresenceService],
})
export class KdsModule {}
