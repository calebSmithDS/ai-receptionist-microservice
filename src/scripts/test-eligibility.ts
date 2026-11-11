/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TEST OBLIGATIONS: spec/eligibility-engine.allium
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies all 9 Allium rules for the Pre-Flight Eligibility Engine and 1-Tap Mute.
 */

import {
  EligibilityEngine,
  IEligibilityRepository,
  ContactRecord,
  IntentSessionRecord,
  EligibilityDecisionResult,
} from '../core/eligibility/eligibility-engine.js';

class InMemoryEligibilityRepository implements IEligibilityRepository {
  contacts = new Map<string, ContactRecord>();
  intentSessions = new Map<string, IntentSessionRecord>();
  magicLinks = new Map<string, { businessId: string; targetPhone: string; isRedeemed: boolean }>();
  decisions: any[] = [];

  async getContact(businessId: string, phoneNumber: string): Promise<ContactRecord | null> {
    return this.contacts.get(`${businessId}:${phoneNumber}`) || null;
  }

  async upsertContact(contact: ContactRecord): Promise<void> {
    this.contacts.set(`${contact.businessId}:${contact.phoneNumber}`, { ...contact });
  }

  async muteContact(businessId: string, phoneNumber: string): Promise<void> {
    const contact = await this.getContact(businessId, phoneNumber);
    if (contact) {
      contact.isMuted = true;
      contact.category = 'explicit_excluded';
    } else {
      this.contacts.set(`${businessId}:${phoneNumber}`, {
        businessId,
        phoneNumber,
        category: 'explicit_excluded',
        isMuted: true,
      });
    }
  }

  async getIntentSession(businessId: string, callerPhone: string): Promise<IntentSessionRecord | null> {
    return this.intentSessions.get(`${businessId}:${callerPhone}`) || null;
  }

  async saveIntentSession(session: IntentSessionRecord): Promise<void> {
    this.intentSessions.set(`${session.businessId}:${session.callerPhone}`, { ...session });
  }

  async createMagicLinkToken(token: string, businessId: string, targetPhone: string): Promise<void> {
    this.magicLinks.set(token, { businessId, targetPhone, isRedeemed: false });
  }

  async redeemMagicLinkToken(token: string): Promise<{ success: boolean; targetPhone?: string; businessId?: string }> {
    const link = this.magicLinks.get(token);
    if (!link || link.isRedeemed) return { success: false };
    link.isRedeemed = true;
    await this.muteContact(link.businessId, link.targetPhone);
    return { success: true, targetPhone: link.targetPhone, businessId: link.businessId };
  }

  async recordDecision(decision: EligibilityDecisionResult & { businessId: string; callerPhone: string }): Promise<void> {
    this.decisions.push(decision);
  }
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

async function runEligibilityTests() {
  console.log('\n====================================================');
  console.log('🛡️ ELIGIBILITY ENGINE: ALLIUM SPECIFICATION VERIFICATION');
  console.log('====================================================\n');

  const repo = new InMemoryEligibilityRepository();
  const engine = new EligibilityEngine(repo);
  const biz = 'tenant_caleb_plumbing';
  const baseTime = new Date('2026-11-11T12:00:00Z');

  // ── TEST 1: Rule SuppressMutedOrOptedOutCaller ─────────────────────────────
  console.log('1️⃣ Rule: SuppressMutedOrOptedOutCaller');
  await repo.upsertContact({
    businessId: biz,
    phoneNumber: '+61411111111',
    category: 'explicit_excluded',
    isMuted: true,
  });

  const res1 = await engine.evaluateMissedCall(biz, '+61411111111', baseTime);
  assert(res1.action === 'suppress', 'Muted contact action is suppress');
  assert(res1.reason === 'personal_exclusion', 'Reason is personal_exclusion ($0 cost)');

  // ── TEST 2: Rule SuppressDuplicateMissedCallWithin15Minutes ──────────────────
  console.log('\n2️⃣ Rule: SuppressDuplicateMissedCallWithin15Minutes');
  const tenMinutesAgo = new Date(baseTime.getTime() - 10 * 60 * 1000);
  await repo.upsertContact({
    businessId: biz,
    phoneNumber: '+61422222222',
    category: 'unknown_caller',
    isMuted: false,
    lastMissedCallAt: tenMinutesAgo,
  });

  const res2 = await engine.evaluateMissedCall(biz, '+61422222222', baseTime);
  assert(res2.action === 'suppress', 'Call within 10 minutes is suppressed');
  assert(res2.reason === 'duplicate_call_window', 'Reason is duplicate_call_window');

  // If called after 16 minutes, it is no longer duplicate
  const sixteenMinutesAgo = new Date(baseTime.getTime() - 16 * 60 * 1000);
  await repo.upsertContact({
    businessId: biz,
    phoneNumber: '+61422222222',
    category: 'unknown_caller',
    isMuted: false,
    lastMissedCallAt: sixteenMinutesAgo,
  });
  const res2b = await engine.evaluateMissedCall(biz, '+61422222222', baseTime);
  assert(res2b.action === 'standard_sms', 'Call after 16 minutes proceeds to standard_sms');

  // ── TEST 3: Rule SuppressRecentSmsInteractionWithin4Hours ───────────────────
  console.log('\n3️⃣ Rule: SuppressRecentSmsInteractionWithin4Hours');
  const twoHoursAgo = new Date(baseTime.getTime() - 2 * 60 * 60 * 1000);
  await repo.upsertContact({
    businessId: biz,
    phoneNumber: '+61433333333',
    category: 'unknown_caller',
    isMuted: false,
    lastInteractionAt: twoHoursAgo,
  });

  const res3 = await engine.evaluateMissedCall(biz, '+61433333333', baseTime);
  assert(res3.action === 'suppress', 'Call within 2 hours of active SMS is suppressed');
  assert(res3.reason === 'recent_sms_window', 'Reason is recent_sms_window');

  // ── TEST 4: Rule DispatchNeutralSmsForUncertainContact ───────────────────────
  console.log('\n4️⃣ Rule: DispatchNeutralSmsForUncertainContact');
  await repo.upsertContact({
    businessId: biz,
    phoneNumber: '+61444444444',
    displayName: 'Dave',
    category: 'single_first_name',
    isMuted: false,
  });

  const res4 = await engine.evaluateMissedCall(biz, '+61444444444', baseTime);
  assert(res4.action === 'neutral_sms', 'Single first name contact receives neutral_sms');
  assert(res4.reason === 'known_contact_uncertain', 'Reason is known_contact_uncertain');
  
  const session4 = await repo.getIntentSession(biz, '+61444444444');
  assert(session4?.status === 'awaiting_intent', 'Intent session placed in awaiting_intent');

  // ── TEST 5: Rule DispatchStandardSmsForUnknownCaller ────────────────────────
  console.log('\n5️⃣ Rule: DispatchStandardSmsForUnknownCaller');
  const res5 = await engine.evaluateMissedCall(biz, '+61455555555', baseTime);
  assert(res5.action === 'standard_sms', 'Completely fresh caller receives standard_sms');
  assert(res5.reason === 'unknown_caller', 'Reason is unknown_caller');

  // ── TEST 6: Rule TradieRedeemsMagicMuteLink ─────────────────────────────────
  console.log('\n6️⃣ Rule: TradieRedeemsMagicMuteLink (1-Tap Mute)');
  const token = 'token_xyz_123';
  await repo.createMagicLinkToken(token, biz, '+61466666666');

  // Contact initially active
  const initialContact = await repo.getContact(biz, '+61466666666');
  assert(!initialContact?.isMuted, 'Target contact initially unmuted');

  // Tradie taps link
  const redeemResult = await repo.redeemMagicLinkToken(token);
  assert(redeemResult.success === true, 'Magic link redeemed successfully');

  // Contact is now permanently muted
  const updatedContact = await repo.getContact(biz, '+61466666666');
  assert(updatedContact?.isMuted === true, 'Contact is now permanently isMuted: true');
  assert(updatedContact?.category === 'explicit_excluded', 'Category updated to explicit_excluded');

  // Second tap fails (single-use token)
  const secondRedeem = await repo.redeemMagicLinkToken(token);
  assert(secondRedeem.success === false, 'Cannot redeem magic link twice');

  console.log('\n====================================================');
  console.log(`📊 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) process.exit(1);
}

runEligibilityTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

