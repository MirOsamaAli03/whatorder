import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ZodValidationPipe, zodBody } from '../common/pipes/zod-validation.pipe';
import {
  createCategorySchema,
  createItemSchema,
  createModifierSchema,
  createOptionSchema,
  createVariantSchema,
  menuQuerySchema,
  setAvailabilitySchema,
  setBranchOverrideSchema,
  setItemModifiersSchema,
  updateCategorySchema,
  updateItemSchema,
  updateModifierSchema,
  updateOptionSchema,
  updateVariantSchema,
  type CreateCategoryDto,
  type CreateItemDto,
  type CreateModifierDto,
  type CreateOptionDto,
  type CreateVariantDto,
  type MenuQueryDto,
  type SetAvailabilityDto,
  type SetBranchOverrideDto,
  type SetItemModifiersDto,
  type UpdateCategoryDto,
  type UpdateItemDto,
  type UpdateModifierDto,
  type UpdateOptionDto,
  type UpdateVariantDto,
} from './menu.dto';
import { MenuService } from './menu.service';
import { ModifiersService } from './modifiers.service';

/**
 * Menu API (ENGINEERING_SPEC.md 60).
 *
 * Reads need `menu.view`, which every operational role holds — a kitchen screen
 * and a POS both need the menu. Writes are split between `menu.create`,
 * `menu.update` and `menu.delete` so a branch manager can mark a dish sold out
 * without also being able to change its price.
 */
@Controller('menu')
export class MenuController {
  constructor(
    private readonly menu: MenuService,
    private readonly modifiers: ModifiersService,
  ) {}

  // --- reads ---------------------------------------------------------------

  @Get()
  @RequirePermission(Permission.MENU_VIEW)
  getMenu(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(menuQuerySchema)) query: MenuQueryDto,
  ) {
    return this.menu.getMenu(auth, query);
  }

  @Get('modifiers')
  @RequirePermission(Permission.MENU_VIEW)
  listModifiers(@CurrentUser() auth: AuthContext) {
    return this.modifiers.findAll(auth);
  }

  @Get('items/:id')
  @RequirePermission(Permission.MENU_VIEW)
  getItem(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(menuQuerySchema)) query: MenuQueryDto,
  ) {
    return this.menu.getItem(auth, id, query.branchId);
  }

  // --- categories ----------------------------------------------------------

  @Post('categories')
  @RequirePermission(Permission.MENU_CREATE)
  createCategory(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createCategorySchema)) body: CreateCategoryDto,
  ) {
    return this.menu.createCategory(auth, body);
  }

  @Patch('categories/:id')
  @RequirePermission(Permission.MENU_UPDATE)
  updateCategory(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateCategorySchema)) body: UpdateCategoryDto,
  ) {
    return this.menu.updateCategory(auth, id, body);
  }

  /** Archives rather than deletes; the category's items become uncategorized. */
  @Delete('categories/:id')
  @RequirePermission(Permission.MENU_DELETE)
  @HttpCode(HttpStatus.OK)
  archiveCategory(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.menu.archiveCategory(auth, id);
  }

  // --- items ---------------------------------------------------------------

  @Post('items')
  @RequirePermission(Permission.MENU_CREATE)
  createItem(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createItemSchema)) body: CreateItemDto,
  ) {
    return this.menu.createItem(auth, body);
  }

  @Patch('items/:id')
  @RequirePermission(Permission.MENU_UPDATE)
  updateItem(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateItemSchema)) body: UpdateItemDto,
  ) {
    return this.menu.updateItem(auth, id, body);
  }

  /** Archives rather than deletes, so historical orders stay resolvable. */
  @Delete('items/:id')
  @RequirePermission(Permission.MENU_DELETE)
  @HttpCode(HttpStatus.OK)
  archiveItem(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.menu.archiveItem(auth, id);
  }

  /**
   * Marks an item available, sold out or hidden — chain-wide, or for one branch
   * when `branchId` is supplied.
   *
   * Only `menu.update`, deliberately: marking tonight's biryani sold out is a
   * routine floor decision, not a menu edit.
   */
  @Post('items/:id/availability')
  @RequirePermission(Permission.MENU_UPDATE)
  @HttpCode(HttpStatus.OK)
  setAvailability(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(setAvailabilitySchema)) body: SetAvailabilityDto,
  ) {
    return this.menu.setAvailability(auth, id, body);
  }

  @Put('items/:id/branches/:branchId')
  @RequirePermission(Permission.MENU_UPDATE)
  setBranchOverride(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(zodBody(setBranchOverrideSchema)) body: SetBranchOverrideDto,
  ) {
    return this.menu.setBranchOverride(auth, id, branchId, body);
  }

  @Delete('items/:id/branches/:branchId')
  @RequirePermission(Permission.MENU_UPDATE)
  @HttpCode(HttpStatus.OK)
  clearBranchOverride(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ) {
    return this.menu.clearBranchOverride(auth, id, branchId);
  }

  @Put('items/:id/modifiers')
  @RequirePermission(Permission.MENU_UPDATE)
  setItemModifiers(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(setItemModifiersSchema)) body: SetItemModifiersDto,
  ) {
    return this.modifiers.setItemModifiers(auth, id, body);
  }

  // --- variants ------------------------------------------------------------

  @Post('items/:id/variants')
  @RequirePermission(Permission.MENU_CREATE)
  addVariant(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(createVariantSchema)) body: CreateVariantDto,
  ) {
    return this.menu.addVariant(auth, id, body);
  }

  @Patch('variants/:id')
  @RequirePermission(Permission.MENU_UPDATE)
  updateVariant(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateVariantSchema)) body: UpdateVariantDto,
  ) {
    return this.menu.updateVariant(auth, id, body);
  }

  @Delete('variants/:id')
  @RequirePermission(Permission.MENU_DELETE)
  @HttpCode(HttpStatus.OK)
  removeVariant(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.menu.removeVariant(auth, id);
  }

  // --- modifiers -----------------------------------------------------------

  @Post('modifiers')
  @RequirePermission(Permission.MENU_CREATE)
  createModifier(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createModifierSchema)) body: CreateModifierDto,
  ) {
    return this.modifiers.create(auth, body);
  }

  @Patch('modifiers/:id')
  @RequirePermission(Permission.MENU_UPDATE)
  updateModifier(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateModifierSchema)) body: UpdateModifierDto,
  ) {
    return this.modifiers.update(auth, id, body);
  }

  @Delete('modifiers/:id')
  @RequirePermission(Permission.MENU_DELETE)
  @HttpCode(HttpStatus.OK)
  archiveModifier(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.modifiers.archive(auth, id);
  }

  @Post('modifiers/:id/options')
  @RequirePermission(Permission.MENU_CREATE)
  addOption(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(createOptionSchema)) body: CreateOptionDto,
  ) {
    return this.modifiers.addOption(auth, id, body);
  }

  @Patch('options/:id')
  @RequirePermission(Permission.MENU_UPDATE)
  updateOption(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateOptionSchema)) body: UpdateOptionDto,
  ) {
    return this.modifiers.updateOption(auth, id, body);
  }

  @Delete('options/:id')
  @RequirePermission(Permission.MENU_DELETE)
  @HttpCode(HttpStatus.OK)
  removeOption(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.modifiers.removeOption(auth, id);
  }
}
