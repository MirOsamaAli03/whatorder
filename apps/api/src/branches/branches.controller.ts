import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ZodValidationPipe, zodBody } from '../common/pipes/zod-validation.pipe';
import {
  createBranchSchema,
  eligibleBranchesSchema,
  updateBranchSchema,
  type CreateBranchDto,
  type EligibleBranchesDto,
  type UpdateBranchDto,
} from './branches.dto';
import { BranchesService } from './branches.service';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermission(Permission.BRANCHES_VIEW)
  findAll(@CurrentUser() auth: AuthContext) {
    return this.branches.findAll(auth);
  }

  /**
   * GET /branches/eligible — which branches can serve this order.
   *
   * Deterministic branch selection (ENGINEERING_SPEC.md 29): for delivery, a
   * branch qualifies only when one of its zones covers the address, and the
   * nearest qualifying branch comes first. Every ordering channel asks this
   * before building a cart, so a WhatsApp customer and a website customer are
   * routed to the same kitchen.
   */
  @Get('eligible')
  @RequirePermission(Permission.BRANCHES_VIEW)
  findEligible(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(eligibleBranchesSchema)) query: EligibleBranchesDto,
  ) {
    return this.branches.findEligible(auth, query);
  }

  @Get(':id')
  @RequirePermission(Permission.BRANCHES_VIEW)
  findOne(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.branches.findOne(auth, id);
  }

  @Post()
  @RequirePermission(Permission.BRANCHES_MANAGE)
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createBranchSchema)) body: CreateBranchDto,
  ) {
    return this.branches.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.BRANCHES_MANAGE)
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateBranchSchema)) body: UpdateBranchDto,
  ) {
    return this.branches.update(auth, id, body);
  }
}
