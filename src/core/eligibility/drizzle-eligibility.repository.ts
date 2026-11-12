import { eq, and } from 'drizzle-orm';
import { AppDatabase } from '../db/index.js';
import * as schema from '../db/schema.js';
import {
  IEligibilityRepository,
  ContactRecord,
  IntentSessionRecord,
  EligibilityDecisionResult,
} from './eligibility-engine.js';

export class DrizzleEligibilityRepository implements IEligibilityRepository {
  constructor(private db: AppDatabase) {}

  async getContact(businessId: string, phoneNumber: string): Promise<ContactRecord | null> {
    const id = `${businessId}:${phoneNumber}`;
    const [row] = await this.db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, id))
      .limit(1);

    if (!row) return null;

    return {
      businessId: row.businessId,
      phoneNumber: row.phoneNumber,
      category: row.category as any,
      displayName: row.displayName,
      isMuted: row.isMuted,
      lastInteractionAt: row.lastInteractionAt,
      lastMissedCallAt: row.lastMissedCallAt,
    };
  }

  async upsertContact(contact: ContactRecord): Promise<void> {
    const id = `${contact.businessId}:${contact.phoneNumber}`;
    await this.db
      .insert(schema.contacts)
      .values({
        id,
        businessId: contact.businessId,
        phoneNumber: contact.phoneNumber,
        category: contact.category,
        displayName: contact.displayName || null,
        isMuted: contact.isMuted,
        lastInteractionAt: contact.lastInteractionAt || null,
        lastMissedCallAt: contact.lastMissedCallAt || null,
      })
      .onConflictDoUpdate({
        target: [schema.contacts.businessId, schema.contacts.phoneNumber],
        set: {
          category: contact.category,
          displayName: contact.displayName || null,
          isMuted: contact.isMuted,
          lastInteractionAt: contact.lastInteractionAt || null,
          lastMissedCallAt: contact.lastMissedCallAt || null,
          updatedAt: new Date(),
        },
      });
  }

  async muteContact(businessId: string, phoneNumber: string): Promise<void> {
    const id = `${businessId}:${phoneNumber}`;
    await this.db
      .update(schema.contacts)
      .set({
        isMuted: true,
        category: 'explicit_excluded',
        updatedAt: new Date(),
      })
      .where(eq(schema.contacts.id, id));
  }

  async unmuteContact(businessId: string, phoneNumber: string): Promise<void> {
    const id = `${businessId}:${phoneNumber}`;
    await this.db
      .update(schema.contacts)
      .set({
        isMuted: false,
        category: 'commercial_contact', // Upgraded to verified commercial client so AI never auto-mutes them again!
        updatedAt: new Date(),
      })
      .where(eq(schema.contacts.id, id));
  }

  async getIntentSession(businessId: string, callerPhone: string): Promise<IntentSessionRecord | null> {
    const id = `${businessId}:${callerPhone}`;
    const [row] = await this.db
      .select()
      .from(schema.intentSessions)
      .where(eq(schema.intentSessions.id, id))
      .limit(1);

    if (!row) return null;

    return {
      businessId: row.businessId,
      callerPhone: row.callerPhone,
      status: row.status as any,
      neutralSmsSentAt: row.neutralSmsSentAt,
      incomingReplyText: row.incomingReplyText,
      classificationResult: row.classificationResult as any,
    };
  }

  async saveIntentSession(session: IntentSessionRecord): Promise<void> {
    const id = `${session.businessId}:${session.callerPhone}`;
    await this.db
      .insert(schema.intentSessions)
      .values({
        id,
        businessId: session.businessId,
        callerPhone: session.callerPhone,
        status: session.status,
        neutralSmsSentAt: session.neutralSmsSentAt,
        incomingReplyText: session.incomingReplyText || null,
        classificationResult: session.classificationResult || null,
      })
      .onConflictDoUpdate({
        target: [schema.intentSessions.id],
        set: {
          status: session.status,
          incomingReplyText: session.incomingReplyText || null,
          classificationResult: session.classificationResult || null,
          updatedAt: new Date(),
        },
      });
  }

  async createMagicLinkToken(token: string, businessId: string, targetPhone: string): Promise<void> {
    await this.db.insert(schema.muteMagicLinks).values({
      token,
      businessId,
      targetPhone,
      isRedeemed: false,
    });
  }

  async redeemMagicLinkToken(token: string): Promise<{ success: boolean; targetPhone?: string; businessId?: string; actionTaken?: 'muted' | 'unmuted' }> {
    const [row] = await this.db
      .select()
      .from(schema.muteMagicLinks)
      .where(eq(schema.muteMagicLinks.token, token))
      .limit(1);

    if (!row) {
      return { success: false };
    }

    // Dynamic 2-Way Toggle: Check current contact mute status
    const currentContact = await this.getContact(row.businessId, row.targetPhone);
    const shouldUnmute = currentContact?.isMuted === true;

    if (shouldUnmute) {
      await this.unmuteContact(row.businessId, row.targetPhone);
    } else {
      await this.muteContact(row.businessId, row.targetPhone);
    }

    await this.db
      .update(schema.muteMagicLinks)
      .set({ isRedeemed: true, redeemedAt: new Date() })
      .where(eq(schema.muteMagicLinks.token, token));

    return {
      success: true,
      targetPhone: row.targetPhone,
      businessId: row.businessId,
      actionTaken: shouldUnmute ? 'unmuted' : 'muted',
    };
  }

  async recordDecision(
    decision: EligibilityDecisionResult & { businessId: string; callerPhone: string }
  ): Promise<void> {
    const id = `dec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await this.db.insert(schema.eligibilityDecisions).values({
      id,
      businessId: decision.businessId,
      callerPhone: decision.callerPhone,
      action: decision.action,
      reason: decision.reason,
      evaluatedAt: decision.evaluatedAt,
    });
  }
}

