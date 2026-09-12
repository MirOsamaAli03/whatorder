import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service';
import { StreamTicketService } from './stream-ticket.service';

/**
 * Real-time fan-out (ENGINEERING_SPEC.md 64). Global because the KDS today and
 * the dashboard, POS and delivery tracking later all subscribe to the same
 * tenant-scoped channels.
 */
@Global()
@Module({
  providers: [RealtimeService, StreamTicketService],
  exports: [RealtimeService, StreamTicketService],
})
export class RealtimeModule {}
