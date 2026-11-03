import { SessionState, SessionStatus, CollectedJobDetails } from '../contracts/session-state.contract.js';

/**
 * Input Alphabet (Σ): Events that trigger transitions.
 *
 * New events added:
 *   - SPAM_DETECTED:    Gemini classified intent as solicitation/spam. Hard-terminates session.
 *   - ULTIMATUM_SENT:   Anti-loop: 4th unanswered message. Hardcoded ultimatum dispatched.
 *   - SESSION_ABANDONED: Anti-loop: 5th+ unanswered message. Worker silently drops all future work.
 */
export type MachineEvent =
  | { type: 'DISPATCH_GREETING' }
  | { type: 'CUSTOMER_MESSAGE'; text: string; mediaUrls?: string[] }
  | {
      type: 'EVALUATION_COMPLETED';
      extracted: Partial<CollectedJobDetails>;
      isFullyQualified: boolean;
      followUpQuestion?: string;
    }
  | {
      type: 'ESCALATION_DETECTED';
      reason: 'ANGER' | 'HUMAN_REQUEST' | 'OUT_OF_BOUNDS' | 'MAX_TURNS_EXCEEDED' | 'DANGER_HAZARD';
      notes?: string;
    }
  | { type: 'SPAM_DETECTED' }
  | { type: 'ULTIMATUM_SENT'; missingFields: string[] }
  | { type: 'SESSION_ABANDONED' };

/**
 * Output Alphabet (Ω): Pure action descriptors — zero I/O, zero side-effects.
 *
 * New action types:
 *   - TERMINATE_SILENTLY:     Spam/solicitation path. Commit TERMINATED state, send nothing.
 *   - SEND_ULTIMATUM_SMS:     Anti-loop path. Worker bypasses Gemini and fires hardcoded SMS.
 *   - ABANDON_SESSION:        Anti-loop path. Marks ABANDONED; all future webhooks are dropped.
 *   - DISPATCH_LEAD_TO_SERVICEM8: COMPLETED path. POSTs structured payload to ServiceM8 REST inbox.
 */
export type MachineAction =
  | { type: 'SEND_GREETING_SMS' }
  | { type: 'EVALUATE_WITH_LLM'; userText: string; mediaUrls?: string[] }
  | { type: 'SEND_FOLLOWUP_SMS'; text: string }
  | { type: 'DISPATCH_LEAD_TO_OWNER'; lead: CollectedJobDetails }
  | { type: 'DISPATCH_LEAD_TO_SERVICEM8'; lead: CollectedJobDetails }
  | { type: 'SEND_COMPLETION_SMS'; customMessage?: string }
  | { type: 'ALERT_OWNER_ESCALATION'; reason: string; notes?: string }
  | { type: 'FORWARD_UNHANDLED_TO_OWNER'; text?: string }
  | { type: 'TERMINATE_SILENTLY' }
  | { type: 'SEND_ULTIMATUM_SMS'; missingFields: string[] }
  | { type: 'ABANDON_SESSION' };

export interface TransitionResult {
  nextState: SessionState;
  actions: MachineAction[];
  isTransitionValid: boolean;
}

/** Handler signature for transition table cells */
type TransitionRule<TEvent extends MachineEvent = MachineEvent> = (
  state: SessionState,
  event: TEvent
) => { target: SessionStatus; actions: MachineAction[]; updatedState?: Partial<SessionState> };

/**
 * Transition Table (δ: Q × Σ → Q' × Ω)
 *
 * Reading guide:
 *   TRANSITION_TABLE[currentStatus][eventType] = rule function
 *
 * Any (state, event) pair with no entry is an ILLEGAL transition —
 * the transition() function returns isTransitionValid: false and the
 * worker discards the event without mutating Redis. This is the
 * core idempotency guarantee.
 */
export const TRANSITION_TABLE: {
  [KState in SessionStatus]?: {
    [KEvent in MachineEvent['type']]?: TransitionRule<Extract<MachineEvent, { type: KEvent }>>;
  };
} = {
  // ─────────────────────────────────────────────────────────────────────────────
  // 1. INIT → AWAITING_REPLY
  //    Only one valid transition from INIT: send the opening greeting.
  //    If a MISSED_CALL webhook is redelivered while session is already
  //    AWAITING_REPLY, the table lookup returns undefined → isTransitionValid: false
  //    and the worker safely ignores the duplicate.
  // ─────────────────────────────────────────────────────────────────────────────
  INIT: {
    DISPATCH_GREETING: (state) => ({
      target: 'AWAITING_REPLY',
      actions: [{ type: 'SEND_GREETING_SMS' }],
      updatedState: {
        metadata: {
          ...state.metadata,
          lastOutboundAt: new Date().toISOString(),
        },
      },
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. AWAITING_REPLY → QUALIFYING  (or TERMINATED for spam on first reply)
  // ─────────────────────────────────────────────────────────────────────────────
  AWAITING_REPLY: {
    CUSTOMER_MESSAGE: (state, event) => ({
      target: 'QUALIFYING',
      actions: [{ type: 'EVALUATE_WITH_LLM', userText: event.text, mediaUrls: event.mediaUrls }],
      updatedState: {
        metadata: {
          ...state.metadata,
          turnCount: state.metadata.turnCount + 1,
          userMessageCount: (state.metadata.userMessageCount ?? 0) + 1,
          lastInboundAt: new Date().toISOString(),
        },
      },
    }),

    SPAM_DETECTED: () => ({
      target: 'TERMINATED',
      actions: [{ type: 'TERMINATE_SILENTLY' }],
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. QUALIFYING — the main conversation loop
  // ─────────────────────────────────────────────────────────────────────────────
  QUALIFYING: {
    CUSTOMER_MESSAGE: (state, event) => ({
      target: 'QUALIFYING',
      actions: [{ type: 'EVALUATE_WITH_LLM', userText: event.text, mediaUrls: event.mediaUrls }],
      updatedState: {
        metadata: {
          ...state.metadata,
          turnCount: state.metadata.turnCount + 1,
          userMessageCount: (state.metadata.userMessageCount ?? 0) + 1,
          lastInboundAt: new Date().toISOString(),
        },
      },
    }),

    EVALUATION_COMPLETED: (state, event) => {
      const mergedData: CollectedJobDetails = {
        ...state.collectedData,
        ...event.extracted,
        mediaUrls: [
          ...(state.collectedData.mediaUrls || []),
          ...(event.extracted.mediaUrls || []),
        ],
      };

      if (event.isFullyQualified) {
        return {
          target: 'COMPLETED',
          actions: [
            // ServiceM8 dispatch replaces the SMS-to-owner flow for COMPLETED leads.
            // The owner SMS alert is kept as a belt-and-suspenders backup.
            { type: 'DISPATCH_LEAD_TO_SERVICEM8', lead: mergedData },
            { type: 'DISPATCH_LEAD_TO_OWNER', lead: mergedData },
            { type: 'SEND_COMPLETION_SMS', customMessage: event.followUpQuestion },
          ],
          updatedState: {
            collectedData: mergedData,
            crmSync: { status: 'PENDING', provider: 'servicem8' },
          },
        };
      }

      return {
        target: 'QUALIFYING',
        actions: event.followUpQuestion
          ? [{ type: 'SEND_FOLLOWUP_SMS', text: event.followUpQuestion }]
          : [],
        updatedState: { collectedData: mergedData },
      };
    },

    ESCALATION_DETECTED: (state, event) => ({
      target: 'ESCALATED',
      actions: [{ type: 'ALERT_OWNER_ESCALATION', reason: event.reason, notes: event.notes }],
      updatedState: {
        escalation: {
          reason: event.reason,
          detectedAt: new Date().toISOString(),
          notes: event.notes,
        },
      },
    }),

    SPAM_DETECTED: () => ({
      target: 'TERMINATED',
      actions: [{ type: 'TERMINATE_SILENTLY' }],
    }),

    // Anti-Loop: 4th message, still unqualified
    ULTIMATUM_SENT: (_state, event) => ({
      target: 'QUALIFYING',
      actions: [{ type: 'SEND_ULTIMATUM_SMS', missingFields: event.missingFields }],
    }),

    // Anti-Loop: 5th+ message, still unqualified
    SESSION_ABANDONED: () => ({
      target: 'ABANDONED',
      actions: [{ type: 'ABANDON_SESSION' }],
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. COMPLETED — latching, forward all follow-ups to owner
  // ─────────────────────────────────────────────────────────────────────────────
  COMPLETED: {
    CUSTOMER_MESSAGE: (_state, event) => ({
      target: 'COMPLETED',
      actions: [{ type: 'FORWARD_UNHANDLED_TO_OWNER', text: event.text }],
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. ESCALATED — latching, AI is paused, forward all to owner
  // ─────────────────────────────────────────────────────────────────────────────
  ESCALATED: {
    CUSTOMER_MESSAGE: (_state, event) => ({
      target: 'ESCALATED',
      actions: [{ type: 'FORWARD_UNHANDLED_TO_OWNER', text: event.text }],
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. TERMINATED — absolute sink. No transitions out. Zero cost.
  //    Omitting all events means the illegal-transition guard fires for everything.
  // ─────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. ABANDONED — silent sink. Webhook received but immediately dropped by worker.
  // ─────────────────────────────────────────────────────────────────────────────
};

/**
 * Pure Transition Function δ(Q, e) → (Q', actions)
 *
 * Performs the table lookup and applies the rule, or returns
 * isTransitionValid: false for illegal (state, event) pairs.
 * The worker MUST check isTransitionValid before executing actions.
 */
export function transition(currentState: SessionState, event: MachineEvent): TransitionResult {
  const stateTransitions = TRANSITION_TABLE[currentState.status];
  const rule = stateTransitions?.[event.type] as TransitionRule<MachineEvent> | undefined;

  if (!rule) {
    return {
      nextState: currentState,
      actions: [],
      isTransitionValid: false,
    };
  }

  const outcome = rule(currentState, event);
  const now = new Date().toISOString();

  const nextState: SessionState = {
    ...currentState,
    ...outcome.updatedState,
    status: outcome.target,
    updatedAt: now,
  };

  return {
    nextState,
    actions: outcome.actions,
    isTransitionValid: true,
  };
}
