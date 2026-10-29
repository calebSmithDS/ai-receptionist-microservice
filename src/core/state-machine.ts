import { SessionState, SessionStatus, CollectedJobDetails } from '../contracts/session-state.contract.js';

/**
 * Input Alphabet (Σ): Events that trigger transitions
 */
export type MachineEvent =
  | {
      type: 'DISPATCH_GREETING';
    }
  | {
      type: 'CUSTOMER_MESSAGE';
      text: string;
      mediaUrls?: string[];
    }
  | {
      type: 'EVALUATION_COMPLETED';
      extracted: Partial<CollectedJobDetails>;
      isFullyQualified: boolean;
      followUpQuestion?: string;
    }
  | {
      type: 'ESCALATION_DETECTED';
      reason: 'ANGER' | 'HUMAN_REQUEST' | 'OUT_OF_BOUNDS' | 'MAX_TURNS_EXCEEDED';
      notes?: string;
    };

/**
 * Output Alphabet (Ω): Pure action descriptions dispatched to workers
 */
export type MachineAction =
  | {
      type: 'SEND_GREETING_SMS';
    }
  | {
      type: 'EVALUATE_WITH_LLM';
      userText: string;
      mediaUrls?: string[];
    }
  | {
      type: 'SEND_FOLLOWUP_SMS';
      text: string;
    }
  | {
      type: 'DISPATCH_LEAD_TO_OWNER';
      lead: CollectedJobDetails;
    }
  | {
      type: 'SEND_COMPLETION_SMS';
      customMessage?: string;
    }
  | {
      type: 'ALERT_OWNER_ESCALATION';
      reason: string;
      notes?: string;
    }
  | {
      type: 'FORWARD_UNHANDLED_TO_OWNER';
      text?: string;
    };

export interface TransitionResult {
  nextState: SessionState;
  actions: MachineAction[];
  isTransitionValid: boolean;
}

/**
 * Handler signature for transition table cells
 */
type TransitionRule<TEvent extends MachineEvent = MachineEvent> = (
  state: SessionState,
  event: TEvent
) => { target: SessionStatus; actions: MachineAction[]; updatedState?: Partial<SessionState> };

/**
 * Transition Table Definition (δ: Q × Σ → Q' × Ω)
 * 
 * Matrix mapping [CurrentState][EventType] -> TransitionRule
 */
export const TRANSITION_TABLE: {
  [KState in SessionStatus]?: {
    [KEvent in MachineEvent['type']]?: TransitionRule<Extract<MachineEvent, { type: KEvent }>>;
  };
} = {
  // 1. INIT: Call missed, greeting scheduled
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

  // 2. AWAITING_REPLY: Waiting for customer's first SMS response
  AWAITING_REPLY: {
    CUSTOMER_MESSAGE: (state, event) => ({
      target: 'QUALIFYING',
      actions: [{ type: 'EVALUATE_WITH_LLM', userText: event.text, mediaUrls: event.mediaUrls }],
      updatedState: {
        metadata: {
          ...state.metadata,
          turnCount: state.metadata.turnCount + 1,
          lastInboundAt: new Date().toISOString(),
        },
      },
    }),
  },

  // 3. QUALIFYING: Iteratively collecting {suburb, issue, urgency}
  QUALIFYING: {
    CUSTOMER_MESSAGE: (state, event) => ({
      target: 'QUALIFYING',
      actions: [{ type: 'EVALUATE_WITH_LLM', userText: event.text, mediaUrls: event.mediaUrls }],
      updatedState: {
        metadata: {
          ...state.metadata,
          turnCount: state.metadata.turnCount + 1,
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
        // Target: COMPLETED when all fields extracted
        return {
          target: 'COMPLETED',
          actions: [
            { type: 'DISPATCH_LEAD_TO_OWNER', lead: mergedData },
            { type: 'SEND_COMPLETION_SMS', customMessage: event.followUpQuestion },
          ],
          updatedState: {
            collectedData: mergedData,
          },
        };
      }

      // Target: stay in QUALIFYING, ask follow-up
      return {
        target: 'QUALIFYING',
        actions: event.followUpQuestion
          ? [{ type: 'SEND_FOLLOWUP_SMS', text: event.followUpQuestion }]
          : [],
        updatedState: {
          collectedData: mergedData,
        },
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
  },

  // 4. COMPLETED: Latching state (already qualified)
  COMPLETED: {
    CUSTOMER_MESSAGE: (state, event) => ({
      target: 'COMPLETED',
      actions: [{ type: 'FORWARD_UNHANDLED_TO_OWNER', text: event.text }],
    }),
  },

  // 5. ESCALATED: Latching state (AI paused, human alerted)
  ESCALATED: {
    CUSTOMER_MESSAGE: (state, event) => ({
      target: 'ESCALATED',
      actions: [{ type: 'FORWARD_UNHANDLED_TO_OWNER', text: event.text }],
    }),
  },
};

/**
 * Pure Transition Function δ(Q, e) -> (Q', actions)
 * 
 * Takes current state and incoming event, performs table lookup,
 * applies transition rule if valid, or safely rejects invalid transitions.
 */
export function transition(currentState: SessionState, event: MachineEvent): TransitionResult {
  const stateTransitions = TRANSITION_TABLE[currentState.status];
  const rule = stateTransitions?.[event.type] as TransitionRule<MachineEvent> | undefined;

  // Illegal Transition Guard: No entry in table for (CurrentState, Event)
  if (!rule) {
    return {
      nextState: currentState,
      actions: [],
      isTransitionValid: false,
    };
  }

  // Execute transition rule
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

