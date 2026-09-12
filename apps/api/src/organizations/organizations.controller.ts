import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { updateOrganizationSchema, type UpdateOrganizationDto } from './organizations.dto';
import { OrganizationsService } from './organizations.service';

/**
 * ENGINEERING_SPEC.md 60 lists GET /organizations/:id. The id is deliberately
 * omitted: a caller has exactly one organization in scope, taken from the
 * session, so accepting an id would create a parameter that must be checked
 * on every request and can be forgotten once.
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get('current')
  @RequirePermission(Permission.ORGANIZATION_VIEW)
  findCurrent(@CurrentUser() auth: AuthContext) {
    return this.organizations.findCurrent(auth);
  }

  @Patch('current')
  @RequirePermission(Permission.ORGANIZATION_MANAGE)
  update(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(updateOrganizationSchema)) body: UpdateOrganizationDto,
  ) {
    return this.organizations.update(auth, body);
  }
}
