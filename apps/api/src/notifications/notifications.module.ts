import { Module } from '@nestjs/common';
import { CustomerConsentsController, NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

@Module({
  controllers: [NotificationsController, CustomerConsentsController, WhatsAppWebhookController],
  providers: [NotificationsService, WhatsAppWebhookService],
  exports: [NotificationsService, WhatsAppWebhookService],
})
export class NotificationsModule {}
