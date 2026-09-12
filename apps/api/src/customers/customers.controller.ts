import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ZodValidationPipe, zodBody } from '../common/pipes/zod-validation.pipe';
import {
  createAddressSchema,
  createCustomerSchema,
  listCustomersSchema,
  updateAddressSchema,
  updateCustomerSchema,
  type CreateAddressDto,
  type CreateCustomerDto,
  type ListCustomersDto,
  type UpdateAddressDto,
  type UpdateCustomerDto,
} from './customers.dto';
import { CustomersService } from './customers.service';

/**
 * ENGINEERING_SPEC.md 60. Reads need `customers.view`, which kitchen staff
 * deliberately do not hold: a kitchen screen has no business with phone
 * numbers and addresses (spec 11).
 */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission(Permission.CUSTOMERS_VIEW)
  findAll(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(listCustomersSchema)) query: ListCustomersDto,
  ) {
    return this.customers.findAll(auth, query);
  }

  @Get(':id')
  @RequirePermission(Permission.CUSTOMERS_VIEW)
  findOne(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOne(auth, id);
  }

  @Get(':id/orders')
  @RequirePermission(Permission.CUSTOMERS_VIEW)
  findOrders(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOrders(auth, id);
  }

  @Post()
  @RequirePermission(Permission.CUSTOMERS_UPDATE)
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createCustomerSchema)) body: CreateCustomerDto,
  ) {
    return this.customers.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.CUSTOMERS_UPDATE)
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateCustomerSchema)) body: UpdateCustomerDto,
  ) {
    return this.customers.update(auth, id, body);
  }

  @Post(':id/addresses')
  @RequirePermission(Permission.CUSTOMERS_UPDATE)
  addAddress(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(createAddressSchema)) body: CreateAddressDto,
  ) {
    return this.customers.addAddress(auth, id, body);
  }

  @Patch('addresses/:addressId')
  @RequirePermission(Permission.CUSTOMERS_UPDATE)
  updateAddress(
    @CurrentUser() auth: AuthContext,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body(zodBody(updateAddressSchema)) body: UpdateAddressDto,
  ) {
    return this.customers.updateAddress(auth, addressId, body);
  }

  @Delete('addresses/:addressId')
  @RequirePermission(Permission.CUSTOMERS_UPDATE)
  removeAddress(
    @CurrentUser() auth: AuthContext,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.customers.removeAddress(auth, addressId);
  }
}
