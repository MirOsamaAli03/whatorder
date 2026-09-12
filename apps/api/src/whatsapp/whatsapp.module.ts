import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CartModule } from '../cart/cart.module';
import { MenuModule } from '../menu/menu.module';
import { OrdersModule } from '../orders/orders.module';
import { BotIdentityService } from './bot-identity.service';
import { ConversationService } from './conversation.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { WhatsAppSenderService } from './whatsapp-sender.service';

/**
 * WhatsApp as a channel adapter (ENGINEERING_SPEC.md 21).
 *
 * It imports the menu, cart and order modules rather than reimplementing any of
 * them — which is what makes §87's rule ("no WhatsAppOrderService") structural:
 * there is nowhere else for the logic to go.
 *
 * Two halves. ConversationService is the bot, driven by the webhook;
 * ConversationsService is the staff inbox behind it, for the conversations the
 * bot hands over to a person.
 */
@Module({
  imports: [AuditModule, AuthModule, MenuModule, CartModule, OrdersModule],
  controllers: [ConversationsController],
  providers: [
    BotIdentityService,
    ConversationService,
    ConversationsService,
    WhatsAppSenderService,
  ],
  exports: [ConversationService, ConversationsService, WhatsAppSenderService, BotIdentityService],
})
export class WhatsAppModule {}
