import { z } from 'zod';

/**
 * Data Contract for the event dispatched to QStash from the Ingest route.
 * This represents the lean, normalized SMS message before tenant enrichment.
 */
export const InboundSmsEventSchema = z.object({
  // Unique message ID from provider used for QStash deduplication
  messageId: z.string().min(1),
  // E.164 phone number of customer (e.g. +61412345678)
  fromPhone: z.string().min(6),
  // E.164 phone number of tenant virtual line dialed (e.g. +61488889999)
  toPhone: z.string().min(6),
  // Cleaned text body of the incoming SMS
  body: z.string().max(1000),
  // Source telephony provider (Telnyx or Twilio)
  provider: z.enum(['telnyx', 'twilio']),
  // ISO timestamp when the message was received by our ingest route
  receivedAt: z.string().datetime(),
});

export type InboundSmsEvent = z.infer<typeof InboundSmsEventSchema>;

