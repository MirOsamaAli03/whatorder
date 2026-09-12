import { Module } from '@nestjs/common';
import { CartPricingService } from './cart-pricing.service';
import { DeliveryZoneService } from './delivery-zone.service';

/**
 * Pricing and delivery-zone resolution, shared by the cart and by checkout so
 * the preview a customer sees and the amount they are charged come from the
 * same code (ENGINEERING_SPEC.md 27, 28, 29).
 */
@Module({
  providers: [CartPricingService, DeliveryZoneService],
  exports: [CartPricingService, DeliveryZoneService],
})
export class PricingModule {}
