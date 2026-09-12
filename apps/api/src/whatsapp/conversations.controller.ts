import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Permission, type AuthContext } from '@restaurant-os/types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ZodValidationPipe, zodBody } from '../common/pipes/zod-validation.pipe';
import {
  listConversationsSchema,
  replySchema,
  type ListConversationsDto,
  type ReplyDto,
} from './conversations.dto';
import { ConversationsService } from './conversations.service';

/**
 * The staff inbox for WhatsApp conversations.
 *
 * Behind `customers.view` and `customers.update` rather than an order
 * permission: a thread is a customer's phone number and everything they have
 * said, which is exactly what kitchen staff deliberately do not hold (§11).
 */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @RequirePermission(Permission.CUSTOMERS_VIEW)
  findAll(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(listConversationsSchema)) query: ListConversationsDto,
  ) {
    return this.conversations.findAll(auth, query);
  }

  /**
   * How many customers are waiting for a person.
   *
   * Its own endpoint so the navigation badge is one small poll rather than
   * fetching every conversation on every screen.
   */
  @Get('waiting')
  @RequirePermission(Permission.CUSTOMERS_VIEW)
  waiting(@CurrentUser() auth: AuthContext, @Query('branchId') branchId?: string) {
    return this.conversations.waitingCount(auth, branchId);
  }

  @Get(':id')
  @RequirePermission(Permission.CUSTOMERS_VIEW)
  findOne(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.findOne(auth, id);
  }

  @Post(':id/reply')
  @RequirePermission(Permission.CUSTOMERS_UPDATE)
  reply(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(replySchema)) body: ReplyDto,
  ) {
    return this.conversations.reply(auth, id, body);
  }

  /** Hands the conversation back to the bot. */
  @Post(':id/resolve')
  @RequirePermission(Permission.CUSTOMERS_UPDATE)
  resolve(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.resolve(auth, id);
  }
}
