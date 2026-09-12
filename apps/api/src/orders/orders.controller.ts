import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { DomainError } from '@restaurant-os/domain';
import { ErrorCode, Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import { ZodValidationPipe, zodBody } from '../common/pipes/zod-validation.pipe';
import {
  cancelOrderSchema,
  checkoutSchema,
  listOrdersSchema,
  transitionOrderSchema,
  type CancelOrderDto,
  type CheckoutDto,
  type ListOrdersDto,
  type TransitionOrderDto,
} from './orders.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @RequirePermission(Permission.ORDERS_VIEW)
  findAll(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(listOrdersSchema)) query: ListOrdersDto,
  ) {
    return this.orders.findAll(auth, query);
  }

  @Get(':id')
  @RequirePermission(Permission.ORDERS_VIEW)
  findOne(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findOne(auth, id);
  }

  /**
   * POST /api/v1/orders — turns a cart into an order.
   *
   * Requires an `Idempotency-Key` header (ENGINEERING_SPEC.md 17). Order
   * creation is the operation that must never happen twice, and a retry over a
   * dropped connection is the normal case, not an edge one — so the header is
   * mandatory rather than optional.
   */
  @Post()
  @RequirePermission(Permission.ORDERS_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async checkout(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(checkoutSchema)) body: CheckoutDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new DomainError(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key header is required when placing an order',
        400,
      );
    }

    const result = await this.idempotency.run(
      {
        tenantId: auth.tenantId,
        key: idempotencyKey.trim(),
        endpoint: 'POST /orders',
        body,
      },
      () => this.orders.checkout(auth, body),
    );

    return result.value;
  }

  /**
   * POST /api/v1/orders/:id/transition — the only way a status changes.
   *
   * A single endpoint rather than one per status (`/accept`, `/ready`, …):
   * every legal move goes through the same validation, audit and event path,
   * and adding a status later does not add an endpoint that might skip a step.
   */
  @Post(':id/transition')
  @RequirePermission(Permission.ORDERS_UPDATE)
  @HttpCode(HttpStatus.OK)
  transition(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(transitionOrderSchema)) body: TransitionOrderDto,
  ) {
    return this.orders.transitionOrder(auth, id, body);
  }

  /** Convenience over the same state machine; spec 60 lists it separately. */
  @Post(':id/cancel')
  @RequirePermission(Permission.ORDERS_UPDATE)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(cancelOrderSchema)) body: CancelOrderDto,
  ) {
    return this.orders.cancel(auth, id, body.reason);
  }
}
