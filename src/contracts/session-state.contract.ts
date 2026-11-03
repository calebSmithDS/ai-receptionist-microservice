import { z } from 'zod';

/**
 * State Machine Statuses
 *
 * - INIT:          Call missed. QStash job scheduled to send greeting SMS with a 30s delay.
 * - AWAITING_REPLY: Greeting sent. Waiting for customer SMS.
 * - QUALIFYING:    Reply received. LLM evaluated. Missing data triggers follow-up SMS.
 * - COMPLETED:     LLM successfully extracted all fields. Lead dispatched to ServiceM8.
 * - ESCALATED:     LLM detects anger, out-of-bounds, or human request. Halts AI automation.
 * - TERMINATED:    Detected as telemarketer / spam. No outbound SMS is ever sent.
 * - ABANDONED:     Customer failed to qualify after 5+ messages. AI silently drops all future webhooks.
 */
export const SessionStatusSchema = z.enum([
  'INIT',
  'AWAITING_REPLY',
  'QUALIFYING',
  'COMPLETED',
  'ESCALATED',
  'TERMINATED',
  'ABANDONED',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Supported Channels (protects future omnichannel expansion: Twilio SMS, WhatsApp, Web Chat)
 */
export const ChannelSchema = z.enum([
  'twilio_voice',
  'twilio_sms',
  'whatsapp',
  'web_chat',
]);
export type Channel = z.infer<typeof ChannelSchema>;

/**
 * Urgency classification for trade jobs
 */
export const LeadUrgencySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY']);
export type LeadUrgency = z.infer<typeof LeadUrgencySchema>;

/**
 * Structured job details extracted by the LLM.
 * Supports Visual Triage (MMS) via mediaUrls.
 * `intent` drives the spam sinkhole: if Gemini classifies as solicitation/spam,
 * the worker transitions to TERMINATED and sends zero outbound SMS.
 */
export const CollectedJobDetailsSchema = z.object({
  customerName: z.string().nullable().optional(),
  suburb: z.string().nullable().optional(),
  issue: z.string().nullable().optional(),
  urgency: LeadUrgencySchema.nullable().optional(),
  mediaUrls: z.array(z.string().url()).default([]),
  intent: z.enum(['customer_lead', 'solicitation', 'spam']).optional(),
});
export type CollectedJobDetails = z.infer<typeof CollectedJobDetailsSchema>;

/**
 * Single turn in the customer-assistant conversation
 */
export const ConversationTurnSchema = z.object({
  role: z.enum(['customer', 'assistant', 'system']),
  content: z.string(),
  channel: ChannelSchema.default('twilio_sms'),
  timestamp: z.string().datetime(),
  mediaUrls: z.array(z.string().url()).optional(),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

/**
 * Escalation tracking when AI hands off to human
 */
export const EscalationDetailsSchema = z.object({
  reason: z.enum(['ANGER', 'HUMAN_REQUEST', 'OUT_OF_BOUNDS', 'MAX_TURNS_EXCEEDED', 'DANGER_HAZARD', 'UNKNOWN']),
  detectedAt: z.string().datetime(),
  notes: z.string().optional(),
});
export type EscalationDetails = z.infer<typeof EscalationDetailsSchema>;

/**
 * Modular CRM sync state (protects future ServiceM8 / Jobber / CRM API sync)
 */
export const CrmSyncDetailsSchema = z.object({
  status: z.enum(['PENDING', 'SYNCED', 'FAILED', 'SKIPPED']).default('PENDING'),
  provider: z.string().optional(), // e.g. 'servicem8'
  externalJobId: z.string().optional(),
  syncedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type CrmSyncDetails = z.infer<typeof CrmSyncDetailsSchema>;

/**
 * Complete Upstash Redis Session State Schema
 * Key pattern: session:{business_id}:{caller_number}
 */
export const SessionStateSchema = z.object({
  businessId: z.string().min(1),
  callerNumber: z.string().min(6), // E.164 phone or unique caller ID
  status: SessionStatusSchema,
  channel: ChannelSchema.default('twilio_sms'),
  history: z.array(ConversationTurnSchema).default([]),
  collectedData: CollectedJobDetailsSchema.default({}),
  escalation: EscalationDetailsSchema.optional(),
  crmSync: CrmSyncDetailsSchema.optional(),
  metadata: z.object({
    callSid: z.string().optional(),
    turnCount: z.number().int().nonnegative().default(0),
    userMessageCount: z.number().int().nonnegative().default(0),
    /**
     * stallCount: counts consecutive customer messages with ZERO newly extracted data.
     * Resets to 0 whenever a new field (name, suburb, issue, urgency) is collected.
     * Powers the Anti-Loop: ultimatum at stallCount == 3, ABANDONED at stallCount >= 4.
     */
    stallCount: z.number().int().nonnegative().default(0),
    lastInboundAt: z.string().datetime(),
    lastOutboundAt: z.string().datetime().optional(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * Redis Key Helper Function
 * Pattern: session:{business_id}:{caller_number}
 */
export function buildSessionKey(businessId: string, callerNumber: string): string {
  // Normalize callerNumber: remove any spaces or non-standard characters
  const normalizedPhone = callerNumber.trim().replace(/\s+/g, '');
  return `session:${businessId}:${normalizedPhone}`;
}

/**
 * Helper to construct an initial session object in the INIT state
 */
export function createInitialSession(params: {
  businessId: string;
  callerNumber: string;
  callSid?: string;
  channel?: Channel;
}): SessionState {
  const now = new Date().toISOString();
  return {
    businessId: params.businessId,
    callerNumber: params.callerNumber,
    status: 'INIT',
    channel: params.channel || 'twilio_voice',
    history: [],
    collectedData: {
      mediaUrls: [],
    },
    metadata: {
      callSid: params.callSid,
      turnCount: 0,
      userMessageCount: 0,
      stallCount: 0,
      lastInboundAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

