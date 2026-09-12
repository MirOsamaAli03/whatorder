import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import {
  addCartItemSchema,
  createCartSchema,
  updateCartItemSchema,
  updateCartSchema,
  type AddCartItemDto,
  type CreateCartDto,
  type UpdateCartDto,
  type UpdateCartItemDto,
} from './cart.dto';
import { CartService } from './cart.service';

/**
 * Cart API (ENGINEERING_SPEC.md 27).
 *
 * Building a cart needs `orders.create`, the same permission as placing the
 * order it becomes: a cashier assembling an order at the POS and a WhatsApp
 * adapter doing it on a customer's behalf are the same operation.
 *
 * Every response carries the server-computed totals, so no client ever adds up
 * a bill itself.
 */
@Controller('carts')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Post()
  @RequirePermission(Permission.ORDERS_CREATE)
  create(@CurrentUser() auth: AuthContext, @Body(zodBody(createCartSchema)) body: CreateCartDto) {
    return this.cart.create(auth, body);
  }

  @Get(':id')
  @RequirePermission(Permission.ORDERS_VIEW)
  findOne(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cart.findOne(auth, id);
  }

  @Patch(':id')
  @RequirePermission(Permission.ORDERS_CREATE)
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateCartSchema)) body: UpdateCartDto,
  ) {
    return this.cart.update(auth, id, body);
  }

  @Post(':id/items')
  @RequirePermission(Permission.ORDERS_CREATE)
  addItem(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(addCartItemSchema)) body: AddCartItemDto,
  ) {
    return this.cart.addItem(auth, id, body);
  }

  @Patch(':id/items/:itemId')
  @RequirePermission(Permission.ORDERS_CREATE)
  updateItem(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body(zodBody(updateCartItemSchema)) body: UpdateCartItemDto,
  ) {
    return this.cart.updateItem(auth, id, itemId, body);
  }

  @Delete(':id/items/:itemId')
  @RequirePermission(Permission.ORDERS_CREATE)
  removeItem(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.cart.removeItem(auth, id, itemId);
  }

  @Delete(':id/items')
  @RequirePermission(Permission.ORDERS_CREATE)
  clear(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cart.clear(auth, id);
  }
}
