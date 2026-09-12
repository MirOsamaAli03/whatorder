import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Domain event plumbing. Global because any module that changes business data
 * may need to record an event alongside it (ENGINEERING_SPEC.md 57, 58).
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class EventsModule {}
