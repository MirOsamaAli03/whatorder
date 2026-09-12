import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import {
  inviteStaffSchema,
  updateStaffSchema,
  type InviteStaffDto,
  type UpdateStaffDto,
} from './staff.dto';
import { StaffService } from './staff.service';

@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermission(Permission.STAFF_VIEW)
  findAll(@CurrentUser() auth: AuthContext) {
    return this.staff.findAll(auth);
  }

  @Get('roles')
  @RequirePermission(Permission.STAFF_VIEW)
  listRoles(@CurrentUser() auth: AuthContext) {
    return this.staff.listRoles(auth);
  }

  @Get(':id')
  @RequirePermission(Permission.STAFF_VIEW)
  findOne(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.findOne(auth, id);
  }

  @Post()
  @RequirePermission(Permission.STAFF_MANAGE)
  invite(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(inviteStaffSchema)) body: InviteStaffDto,
  ) {
    return this.staff.invite(auth, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.STAFF_MANAGE)
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateStaffSchema)) body: UpdateStaffDto,
  ) {
    return this.staff.update(auth, id, body);
  }
}
