import { pgTable, text, timestamp, boolean, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ALLIUM SPEC: spec/eligibility-engine.allium
 * ENTITY: ContactProfile
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const contactCategoryEnum = pgEnum('contact_category', [
  'unknown_caller',
  'single_first_name',
  'commercial_contact',
  'explicit_excluded',
  'opted_out',
]);

export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey(), // e.g. "biz_123:+61412345678"
    businessId: text('business_id').notNull(),
    phoneNumber: text('phone_number').notNull(), // E.164 format (+61...)
    category: contactCategoryEnum('category').notNull().default('unknown_caller'),
    displayName: text('display_name'),
    isMuted: boolean('is_muted').notNull().default(false),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true }),
    lastMissedCallAt: timestamp('last_missed_call_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_contacts_biz_phone').on(table.businessId, table.phoneNumber),
    index('idx_contacts_lookup').on(table.phoneNumber),
  ]
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ALLIUM SPEC: spec/eligibility-engine.allium
 * ENTITY: IntentSession
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const intentStatusEnum = pgEnum('intent_status', [
  'awaiting_intent',
  'resolved_personal',
  'resolved_service',
  'expired',
]);

export const classificationResultEnum = pgEnum('classification_result', [
  'personal',
  'service',
]);

export const intentSessions = pgTable(
  'intent_sessions',
  {
    id: text('id').primaryKey(), // e.g. "biz_123:+61412345678"
    businessId: text('business_id').notNull(),
    callerPhone: text('caller_phone').notNull(),
    status: intentStatusEnum('status').notNull().default('awaiting_intent'),
    neutralSmsSentAt: timestamp('neutral_sms_sent_at', { withTimezone: true }).defaultNow().notNull(),
    incomingReplyText: text('incoming_reply_text'),
    classificationResult: classificationResultEnum('classification_result'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_intent_lookup').on(table.businessId, table.callerPhone),
  ]
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ALLIUM SPEC: spec/eligibility-engine.allium
 * ENTITY: MuteMagicLink
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const muteMagicLinks = pgTable(
  'mute_magic_links',
  {
    token: text('token').primaryKey(), // Cryptographically random secure slug
    businessId: text('business_id').notNull(),
    targetPhone: text('target_phone').notNull(),
    isRedeemed: boolean('is_redeemed').notNull().default(false),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_mute_token').on(table.token),
  ]
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ALLIUM SPEC: spec/eligibility-engine.allium
 * ENTITY: EligibilityDecision
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const eligibilityActionEnum = pgEnum('eligibility_action', [
  'standard_sms',
  'neutral_sms',
  'suppress',
]);

export const eligibilityReasonEnum = pgEnum('eligibility_reason', [
  'personal_exclusion',
  'opted_out',
  'duplicate_call_window',
  'recent_sms_window',
  'recent_callback_detected',
  'known_contact_uncertain',
  'unknown_caller',
]);

export const eligibilityDecisions = pgTable(
  'eligibility_decisions',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id').notNull(),
    callerPhone: text('caller_phone').notNull(),
    action: eligibilityActionEnum('action').notNull(),
    reason: eligibilityReasonEnum('reason').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_decisions_biz_caller').on(table.businessId, table.callerPhone),
    index('idx_decisions_time').on(table.evaluatedAt),
  ]
);

