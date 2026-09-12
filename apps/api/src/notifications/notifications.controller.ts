import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ZodValidationPipe, zodBody } from '../common/pipes/zod-validation.pipe';
import {
  createWhatsAppAccountSchema,
  createWhatsAppTemplateSchema,
  listNotificationsSchema,
  recordConsentSchema,
  updatePreferencesSchema,
  updateWhatsAppAccountSchema,
  updateWhatsAppTemplateSchema,
  type CreateWhatsAppAccountDto,
  type CreateWhatsAppTemplateDto,
  type ListNotificationsDto,
  type RecordConsentDto,
  type UpdatePreferencesDto,
  type UpdateWhatsAppAccountDto,
  type UpdateWhatsAppTemplateDto,
} from './notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * Notification settings and history (ENGINEERING_SPEC.md 60).
 *
 * Permissions reuse the existing catalogue rather than adding a new one.
 * Connecting a WhatsApp number and choosing which channels a restaurant uses is
 * organization configuration, so it sits behind `organization.manage`. The
 * notification *history* is behind `customers.view` instead, because every row
 * carries a destination — a phone number or an email address — and kitchen
 * staff deliberately do not hold that permission (spec 11).
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission(Permission.CUSTOMERS_VIEW)
  findAll(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(listNotificationsSchema)) query: ListNotificationsDto,
  ) {
    return this.notifications.findAll(auth, query);
  }

  @Get('preferences')
  @RequirePermission(Permission.ORGANIZATION_VIEW)
  findPreferences(@CurrentUser() auth: AuthContext) {
    return this.notifications.findPreferences(auth);
  }

  @Put('preferences')
  @RequirePermission(Permission.ORGANIZATION_MANAGE)
  updatePreferences(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(updatePreferencesSchema)) body: UpdatePreferencesDto,
  ) {
    return this.notifications.updatePreferences(auth, body);
  }

  @Get('whatsapp/accounts')
  @RequirePermission(Permission.ORGANIZATION_VIEW)
  findAccounts(@CurrentUser() auth: AuthContext) {
    return this.notifications.findAccounts(auth);
  }

  @Post('whatsapp/accounts')
  @RequirePermission(Permission.ORGANIZATION_MANAGE)
  createAccount(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createWhatsAppAccountSchema)) body: CreateWhatsAppAccountDto,
  ) {
    return this.notifications.createAccount(auth, body);
  }

  @Patch('whatsapp/accounts/:id')
  @RequirePermission(Permission.ORGANIZATION_MANAGE)
  updateAccount(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateWhatsAppAccountSchema)) body: UpdateWhatsAppAccountDto,
  ) {
    return this.notifications.updateAccount(auth, id, body);
  }

  @Get('whatsapp/templates')
  @RequirePermission(Permission.ORGANIZATION_VIEW)
  findTemplates(@CurrentUser() auth: AuthContext) {
    return this.notifications.findTemplates(auth);
  }

  @Post('whatsapp/templates')
  @RequirePermission(Permission.ORGANIZATION_MANAGE)
  createTemplate(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createWhatsAppTemplateSchema)) body: CreateWhatsAppTemplateDto,
  ) {
    return this.notifications.createTemplate(auth, body);
  }

  @Patch('whatsapp/templates/:id')
  @RequirePermission(Permission.ORGANIZATION_MANAGE)
  updateTemplate(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateWhatsAppTemplateSchema)) body: UpdateWhatsAppTemplateDto,
  ) {
    return this.notifications.updateTemplate(auth, id, body);
  }
}

/**
 * Consent lives under the customer it belongs to.
 *
 * A separate controller so the URL reads the way the data is shaped:
 * `/customers/:id/consents` rather than a notification endpoint that takes a
 * customer id.
 */
@Controller('customers/:customerId/consents')
export class CustomerConsentsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission(Permission.CUSTOMERS_VIEW)
  findAll(
    @CurrentUser() auth: AuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.notifications.findConsents(auth, customerId);
  }

  @Post()
  @RequirePermission(Permission.CUSTOMERS_UPDATE)
  record(
    @CurrentUser() auth: AuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body(zodBody(recordConsentSchema)) body: RecordConsentDto,
  ) {
    return this.notifications.recordConsent(auth, customerId, body);
  }
}
