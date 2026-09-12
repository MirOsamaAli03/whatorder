import { ConversationState } from '@restaurant-os/types';
import { z } from 'zod';

export const listConversationsSchema = z.object({
  /** Defaults to the ones needing a person; pass `ALL` for everything. */
  state: z.union([z.nativeEnum(ConversationState), z.literal('ALL')]).optional(),
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type ListConversationsDto = z.infer<typeof listConversationsSchema>;

export const replySchema = z.object({
  /**
   * Plain text. Interactive messages are the bot's business; a person typing a
   * reply is having a conversation, not running a flow.
   */
  body: z.string().min(1).max(1000),
});
export type ReplyDto = z.infer<typeof replySchema>;
