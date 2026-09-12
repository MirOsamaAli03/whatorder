import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service';
import { CustomersModule } from '../customers/customers.module';
import { PricingModule } from '../pricing/pricing.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [PricingModule, CustomersModule],
  controllers: [OrdersController],
  providers: [OrdersService, IdempotencyService],
  exports: [OrdersService],
})
export class OrdersModule {}
