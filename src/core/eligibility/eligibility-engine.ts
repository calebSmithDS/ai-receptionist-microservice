/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ALLIUM SPEC IMPLEMENTATION: spec/eligibility-engine.allium
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, deterministic evaluation engine and repository interfaces.
 */

export type ContactCategory =
  | 'unknown_caller'
  | 'single_first_name'
  | 'commercial_contact'
  | 'explicit_excluded'
  | 'opted_out';

export type EligibilityAction = 'standard_sms' | 'neutral_sms' | 'suppress';

export type EligibilityReason =
  | 'personal_exclusion'
  | 'opted_out'
  | 'duplicate_call_window'
  | 'recent_sms_window'
  | 'recent_callback_detected'
  | 'known_contact_uncertain'
  | 'unknown_caller';

export interface ContactRecord {
  businessId: string;
  phoneNumber: string;
  category: ContactCategory;
  displayName?: string | null;
  isMuted: boolean;
  lastInteractionAt?: Date | null;
  lastMissedCallAt?: Date | null;
}

export interface IntentSessionRecord {
  businessId: string;
  callerPhone: string;
  status: 'awaiting_intent' | 'resolved_personal' | 'resolved_service' | 'expired';
  neutralSmsSentAt: Date;
  incomingReplyText?: string | null;
  classificationResult?: 'personal' | 'service' | null;
}

export interface EligibilityDecisionResult {
  action: EligibilityAction;
  reason: EligibilityReason;
  evaluatedAt: Date;
}

export interface IEligibilityRepository {
  getContact(businessId: string, phoneNumber: string): Promise<ContactRecord | null>;
  upsertContact(contact: ContactRecord): Promise<void>;
  muteContact(businessId: string, phoneNumber: string): Promise<void>;
  unmuteContact(businessId: string, phoneNumber: string): Promise<void>;
  getIntentSession(businessId: string, callerPhone: string): Promise<IntentSessionRecord | null>;
  saveIntentSession(session: IntentSessionRecord): Promise<void>;
  createMagicLinkToken(token: string, businessId: string, targetPhone: string): Promise<void>;
  redeemMagicLinkToken(token: string): Promise<{ success: boolean; targetPhone?: string; businessId?: string; actionTaken?: 'muted' | 'unmuted' }>;
  recordDecision(decision: EligibilityDecisionResult & { businessId: string; callerPhone: string }): Promise<void>;
}

export class EligibilityEngine {
  constructor(public readonly repo: IEligibilityRepository) {}

  /**
   * Deterministically evaluates whether a missed call should receive an SMS.
   * Enforces rules from Section 2 of spec/eligibility-engine.allium:
   *   - SuppressMutedOrOptedOutCaller
   *   - SuppressDuplicateMissedCallWithin15Minutes
   *   - SuppressRecentSmsInteractionWithin4Hours
   *   - DispatchNeutralSmsForUncertainContact
   *   - DispatchStandardSmsForUnknownCaller
   */
  async evaluateMissedCall(
    businessId: string,
    callerPhone: string,
    now: Date = new Date()
  ): Promise<EligibilityDecisionResult> {
    const contact = await this.repo.getContact(businessId, callerPhone);

    // Rule 1: SuppressMutedOrOptedOutCaller
    if (contact && (contact.isMuted || contact.category === 'explicit_excluded' || contact.category === 'opted_out')) {
      return this.recordAndReturn(businessId, callerPhone, {
        action: 'suppress',
        reason: 'personal_exclusion',
        evaluatedAt: now,
      });
    }

    // Rule 2: SuppressDuplicateMissedCallWithin15Minutes (15 * 60 * 1000 = 900,000 ms)
    if (contact && contact.lastMissedCallAt) {
      const diffMs = now.getTime() - contact.lastMissedCallAt.getTime();
      if (diffMs < 15 * 60 * 1000 && diffMs >= 0) {
        return this.recordAndReturn(businessId, callerPhone, {
          action: 'suppress',
          reason: 'duplicate_call_window',
          evaluatedAt: now,
        });
      }
    }

    // Rule 3: SuppressRecentSmsInteractionWithin4Hours (4 * 60 * 60 * 1000 = 14,400,000 ms)
    if (contact && contact.lastInteractionAt) {
      const diffMs = now.getTime() - contact.lastInteractionAt.getTime();
      if (diffMs < 4 * 60 * 60 * 1000 && diffMs >= 0) {
        return this.recordAndReturn(businessId, callerPhone, {
          action: 'suppress',
          reason: 'recent_sms_window',
          evaluatedAt: now,
        });
      }
    }

    // Rule 4: DispatchNeutralSmsForUncertainContact (single first names or known contacts)
    if (contact && (contact.category === 'single_first_name' || contact.category === 'commercial_contact')) {
      await this.repo.saveIntentSession({
        businessId,
        callerPhone,
        status: 'awaiting_intent',
        neutralSmsSentAt: now,
      });

      // Update last missed call timestamp on contact
      contact.lastMissedCallAt = now;
      await this.repo.upsertContact(contact);

      return this.recordAndReturn(businessId, callerPhone, {
        action: 'neutral_sms',
        reason: 'known_contact_uncertain',
        evaluatedAt: now,
      });
    }

    // Rule 5: DispatchStandardSmsForUnknownCaller
    const unknownContact: ContactRecord = contact || {
      businessId,
      phoneNumber: callerPhone,
      category: 'unknown_caller',
      isMuted: false,
      lastMissedCallAt: now,
    };
    unknownContact.lastMissedCallAt = now;
    await this.repo.upsertContact(unknownContact);

    return this.recordAndReturn(businessId, callerPhone, {
      action: 'standard_sms',
      reason: 'unknown_caller',
      evaluatedAt: now,
    });
  }

  private async recordAndReturn(
    businessId: string,
    callerPhone: string,
    result: EligibilityDecisionResult
  ): Promise<EligibilityDecisionResult> {
    await this.repo.recordDecision({
      ...result,
      businessId,
      callerPhone,
    });
    return result;
  }
}

