import { z } from 'zod';
import { uuidSchema } from './schemas';

export const WEBHOOK_QUEUE = 'webhooks';

export const webhookJobSchema = z.object({ orgId: uuidSchema, eventId: uuidSchema }).strict();
export type WebhookJob = z.infer<typeof webhookJobSchema>;
