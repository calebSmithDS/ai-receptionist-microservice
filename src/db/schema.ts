import {
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';

/**
 * ARCHITECTURAL WHY: PostgreSQL Enums vs Plain Text
 * We declare an explicit enum for terminal states. This enforces strict type-safety
 * both at compile-time (TypeScript) and database-level runtime (PostgreSQL), guaranteeing
 * that bad state transitions cannot corrupt our financial and ROI reporting metrics.
 */
export const terminalStatusEnum = pgEnum('terminal_status', [
  'COMPLETED',
  'ESCALATED',
  'ABANDONED',
  'TERMINATED',
]);

/**
 * ARCHITECTURAL WHY: The Conversation Ledger Table
 * In an asynchronous architecture debounced by QStash, this table acts as the source-of-truth
 * write-model for billing, analytics, and operational metrics.
 */
export const conversationLedgers = pgTable(
  'conversation_ledgers',
  {
    /**
     * Primary Key: session_id
     * WHY: We use session_id directly as the PK rather than an auto-incrementing serial integer.
     * This avoids cross-system identity mapping issues: Redis, QStash payloads, and Twilio webhooks
     * all reference this deterministic UUID.
     */
    sessionId: text('session_id').primaryKey(),

    /**
     * business_id: Multi-tenant partition key
     * WHY: In multi-tenant systems, every tenant query MUST filter by business_id to prevent
     * cross-tenant data leaks. We index this column for single-tenant filtering.
     */
    businessId: text('business_id').notNull(),

    /**
     * caller_phone: E.164 formatted customer telephone number (e.g., +61412345678).
     */
    callerPhone: text('caller_phone').notNull(),

    /**
     * terminal_status: The final FSM state reached by the session.
     */
    terminalStatus: terminalStatusEnum('terminal_status').notNull(),

    /**
     * escalation_reason: Nullable explanation if status is ESCALATED
     * (e.g., "CUSTOMER_REQUESTED_HUMAN", "EMERGENCY_GAS_LEAK", "MAX_TURNS_EXCEEDED").
     */
    escalationReason: text('escalation_reason'),

    /**
     * turn_count & stall_count:
     * WHY: Tracks conversational efficiency. High stall counts indicate confusing LLM prompts
     * or customer hesitation, helping us optimize AI prompt engineering.
     */
    turnCount: integer('turn_count').notNull().default(0),
    stallCount: integer('stall_count').notNull().default(0),

    /**
     * extracted_suburb: Geolocation context parsed from conversational turns.
     */
    extractedSuburb: text('extracted_suburb'),

    /**
     * servicem8_job_uuid: External third-party reference.
     * WHY: Nullable because not all conversations convert to booked jobs. When populated,
     * it enables end-to-end attribution (from inbound SMS -> ServiceM8 invoice paid).
     */
    servicem8JobUuid: text('servicem8_job_uuid'),

    /**
     * Token consumption columns:
     * WHY: Essential for calculating LLM gross margin and per-tenant cost attribution.
     */
    totalPromptTokens: integer('total_prompt_tokens').notNull().default(0),
    totalCompletionTokens: integer('total_completion_tokens').notNull().default(0),

    /**
     * started_at: When the first inbound SMS initiated this session.
     */
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),

    /**
     * resolved_at: When the FSM completed, escalated, or timed out.
     */
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * ARCHITECTURAL WHY: Composite Index (business_id, resolved_at)
     * For weekly client ROI digests, we run queries like:
     *   SELECT count(*), terminal_status FROM conversation_ledgers
     *   WHERE business_id = $1 AND resolved_at BETWEEN $2 AND $3
     *
     * A composite B-tree index starting with `business_id` (high cardinality equality match)
     * followed by `resolved_at` (range filter) lets Postgres perform an index-only scan
     * without sequential table scanning.
     */
    index('idx_conversation_ledgers_business_resolved').on(
      table.businessId,
      table.resolvedAt
    ),

    /**
     * Single-column index on business_id for general tenant lookups.
     */
    index('idx_conversation_ledgers_business_id').on(table.businessId),
  ]
);

export type ConversationLedger = typeof conversationLedgers.$inferSelect;
export type NewConversationLedger = typeof conversationLedgers.$inferInsert;

