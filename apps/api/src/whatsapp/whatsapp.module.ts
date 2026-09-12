import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CartModule } from '../cart/cart.module';
import { MenuModule } from '../menu/menu.module';
import { OrdersModule } from '../orders/orders.module';
import { BotIdentityService } from './bot-identity.service';
import { ConversationService } from './conversation.service';
import { WhatsAppSenderService } from './whatsapp-sender.service';

/**
 * WhatsApp as a channel adapter (ENGINEERING_SPEC.md 21).
 *
 * It imports the menu, cart and order modules rather than reimplementing any of
 * them — which is what makes §87's rule ("no WhatsAppOrderService") structural:
 * there is nowhere else for the logic to go.
 */
@Module({
  imports: [AuthModule, MenuModule, CartModule, OrdersModule],
  providers: [BotIdentityService, ConversationService, WhatsAppSenderService],
  exports: [ConversationService, WhatsAppSenderService, BotIdentityService],
})
export class WhatsAppModule {}
