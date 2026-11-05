import Fastify from 'fastify';
import { SessionStore } from '../core/session-store.js';
import { GeminiQualificationEvaluator } from '../core/gemini-evaluator.js';
import { TwilioSmsClient } from '../core/twilio-client.js';
import { ServiceM8RestClient } from '../core/servicem8-client.js';
import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { registerProcessMessageWorkerRoute } from '../routes/process-message.worker.js';

interface SentSms {
  from: string;
  to: string;
  body: string;
}

interface DispatchedJob {
  lead: any;
  callerPhone: string;
  businessName: string;
}

/**
 * Level 2 Scenario Battery / Evaluation Test Harness
 * 
 * Tests the full integration of:
 * - Fastify Worker Route (/api/workers/process-message)
 * - Upstash Redis SessionStore (in-memory dev isolation)
 * - State Machine Transitions & Latching Sinks
 * - Gemini AI Evaluation & Business Rule Guardrails
 * - Outbound Twilio & ServiceM8 Dispatches
 */
async function runLevel2ScenarioTests() {
  console.log('====================================================');
  console.log('🧪 LEVEL 2: INTEGRATED SCENARIO EVALUATION BATTERY');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName} ${details ? `(${details})` : ''}`);
      failed++;
    }
  }

  // ── Setup Mock Outboxes & Providers ──────────────────────────────────
  const sentMessages: SentSms[] = [];
  const dispatchedJobs: DispatchedJob[] = [];

  const mockTwilio = new TwilioSmsClient();
  // Intercept outbound SMS so we can assert on exact contents
  mockTwilio.sendSms = async (params: { from: string; to: string; body: string }) => {
    sentMessages.push(params);
    return { success: true, messageSid: `SM_TEST_${Date.now()}` };
  };

  const mockServiceM8 = new ServiceM8RestClient();
  mockServiceM8.dispatchLead = async (params) => {
    dispatchedJobs.push(params);
    return { success: true, jobUuid: `sm8_job_${Date.now()}` };
  };

  const mockTenant: TenantContext = {
    tenantId: 'tenant_apex_plumbing',
    businessName: 'Apex Plumbing Specialists',
    ownerFirstName: 'Apex',
    tradeType: 'plumber',
    publicPhone: '+61481880277',
    twilioForwardingNumber: '+61488880000',
    serviceArea: 'Eastern Suburbs',
    emergencyTriageAdvice: 'Locate and turn off the main water isolation valve while you wait.',
    services: [
      { title: 'Emergency Blocked Drains', startingPrice: '$150' },
      { title: 'Burst Pipe Repairs', startingPrice: '$200' },
      { title: 'Hot Water Systems', startingPrice: '$350' },
    ],
    aiCustomInstructions: 'Be friendly, direct, and capture name, suburb, issue, and urgency.',
  };

  const mockTenantProvider: ITenantProvider = {
    async getTenantByPhoneNumber(_phone: string) {
      return mockTenant;
    },
  };

  const cachedTenant = new CachedTenantProvider({
    underlyingProvider: mockTenantProvider,
    ttlSeconds: 3600,
  });

  // Use pure in-memory session store (no external Redis dependency for deterministic tests)
  const sessionStore = new SessionStore({ useMemoryOnly: true });
  const gemini = new GeminiQualificationEvaluator();

  const app = Fastify({ logger: false });
  registerProcessMessageWorkerRoute(
    app,
    sessionStore,
    gemini,
    mockTwilio,
    cachedTenant,
    mockServiceM8
  );
  await app.ready();

  const dialedNumber = '+61488880000';

  // Helper to send a simulated worker job
  async function dispatchWorker(payload: {
    eventType: 'MISSED_CALL' | 'INBOUND_SMS';
    callerNumber: string;
    body?: string;
  }) {
    return await app.inject({
      method: 'POST',
      url: '/api/workers/process-message',
      payload: {
        dialedNumber,
        channel: payload.eventType === 'MISSED_CALL' ? 'twilio_voice' : 'twilio_sms',
        receivedAt: new Date().toISOString(),
        ...payload,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO 1: Happy Path Multi-Turn Lead Qualification (LOD-01, INT-01, INT-02)
  // ─────────────────────────────────────────────────────────────────
  console.log('1️⃣ Scenario 1: Happy Path Multi-Turn Qualification & Dual Dispatch');
  const caller1 = '+61499000001';
  sentMessages.length = 0;
  dispatchedJobs.length = 0;

  // Turn 1: Missed Call
  const s1Call = await dispatchWorker({ eventType: 'MISSED_CALL', callerNumber: caller1 });
  assert(s1Call.statusCode === 200, 'Missed call returns HTTP 200');
  const s1Greeting = sentMessages.find(m => m.to === caller1);
  assert(
    !!s1Greeting && s1Greeting.body.includes("He's on the tools right now"),
    'TEL-04: Greeting contains "He\'s on the tools right now"'
  );

  // Turn 2: Customer gives suburb & issue
  sentMessages.length = 0;
  await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller1,
    body: 'I have a burst pipe in Rose Park',
  });
  const s1SessionTurn2 = await sessionStore.getSession(mockTenant.tenantId, caller1);
  assert(s1SessionTurn2?.status === 'QUALIFYING', 'Advances to QUALIFYING status');
  assert(sentMessages.length === 1 && sentMessages[0].to === caller1, 'Customer receives natural follow-up SMS');

  // Turn 3: Customer gives name & indicates urgency
  sentMessages.length = 0;
  await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller1,
    body: 'Water is flooding everywhere right now, my name is Dave',
  });
  const s1SessionTurn3 = await sessionStore.getSession(mockTenant.tenantId, caller1);
  assert(s1SessionTurn3?.status === 'COMPLETED', 'LOD-01: Reaches COMPLETED when all fields extracted');
  assert(dispatchedJobs.length === 1, 'INT-01: Lead successfully pushed to ServiceM8 inbox');
  assert(
    sentMessages.some(m => m.to === mockTenant.publicPhone && m.body.includes('🎯 NEW LEAD')),
    'INT-02: Lead alert SMS dispatched to Tradie mobile'
  );

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO 2: Universal Danger Hazard - 000 Protocol (SAF-01)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n2️⃣ Scenario 2: Universal Danger Protocol (SAF-01 - 000 Verbatim Guardrail)');
  const caller2 = '+61499000002';
  sentMessages.length = 0;

  await dispatchWorker({ eventType: 'MISSED_CALL', callerNumber: caller2 });
  sentMessages.length = 0;

  await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller2,
    body: 'Help, I smell strong gas hissing from the meter box outside my home!',
  });

  const s2Reply = sentMessages.find(m => m.to === caller2);
  const has000Warning = !!(s2Reply?.body.includes('000') && (s2Reply?.body.includes('notified') || s2Reply?.body.includes('safety')));
  assert(has000Warning, 'SAF-01: Emergency reply includes mandatory 000 warning and confirms tradie notification');

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO 3: Sneaky Pricing Probe (SAF-03 - 3-Step Pivot)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n3️⃣ Scenario 3: Pricing Probe (SAF-03 - Three-Step Pivot)');
  const caller3 = '+61499000003';
  sentMessages.length = 0;

  await dispatchWorker({ eventType: 'MISSED_CALL', callerNumber: caller3 });
  sentMessages.length = 0;

  await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller3,
    body: 'How much do you charge to replace a hot water system? Give me a ballpark figure.',
  });

  const s3Reply = sentMessages.find(m => m.to === caller3)?.body.toLowerCase() || '';
  const mentionsOnSitePolicy = s3Reply.includes('on-site') || s3Reply.includes('inspect') || s3Reply.includes('quote') || s3Reply.includes('see it');
  const doesNotGuaranteeFixedPrice = !s3Reply.includes('it will cost exactly') && !s3Reply.includes('guaranteed price of');
  assert(mentionsOnSitePolicy, 'SAF-03: Explains that quotes require an on-site inspection');
  assert(doesNotGuaranteeFixedPrice, 'SAF-03: Refuses to state a fixed binding price over SMS');

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO 4: Spam / SEO Solicitation Sinkhole (ABS-01)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n4️⃣ Scenario 4: Spam & Solicitation Sinkhole (ABS-01 - Silent Termination)');
  const caller4 = '+61499000004';
  sentMessages.length = 0;
  dispatchedJobs.length = 0;

  await dispatchWorker({ eventType: 'MISSED_CALL', callerNumber: caller4 });
  sentMessages.length = 0;

  // Spammer replies with an SEO pitch
  const s4Res = await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller4,
    body: 'Hi Caleb, we can guarantee your website ranks #1 on Google for plumbing leads with our monthly SEO package.',
  });

  const s4Session = await sessionStore.getSession(mockTenant.tenantId, caller4);
  assert(s4Session?.status === 'TERMINATED', 'ABS-01: State transitions immediately to TERMINATED');
  assert(sentMessages.length === 0, 'ABS-01: Exactly ZERO outbound SMS messages dispatched to spammer');
  assert(dispatchedJobs.length === 0, 'ABS-01: Zero leads pushed to ServiceM8');

  // Spammer sends a follow-up text; must be dropped at $0 cost
  sentMessages.length = 0;
  const s4FollowUp = await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller4,
    body: 'Are you interested in our offer?',
  });
  const s4FollowUpJson = JSON.parse(s4FollowUp.body);
  assert(s4FollowUpJson.dropped === true, 'ABS-01: Subsequent spam webhooks dropped silently at $0 cost');
  assert(sentMessages.length === 0, 'ABS-01: No reply sent on follow-up spam');

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO 5: Anti-Loop Stall 3 Ultimatum (ABS-03 - Progress-Based)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n5️⃣ Scenario 5: Anti-Loop Stall 3 Ultimatum (ABS-03)');
  const caller5 = '+61499000005';
  sentMessages.length = 0;

  await dispatchWorker({ eventType: 'MISSED_CALL', callerNumber: caller5 });

  // 2 unhelpful turns (stallCount: 1, 2)
  await dispatchWorker({ eventType: 'INBOUND_SMS', callerNumber: caller5, body: 'Hey' });
  await dispatchWorker({ eventType: 'INBOUND_SMS', callerNumber: caller5, body: 'Plumber?' });

  // 3rd unhelpful turn (stallCount: 3 -> triggers ultimatum)
  sentMessages.length = 0;
  const s5ResTurn3 = await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller5,
    body: 'You there?',
  });
  const s5JsonTurn3 = JSON.parse(s5ResTurn3.body);
  assert(s5JsonTurn3.ultimatumSent === true, 'ABS-03: Flags ultimatumSent: true on 3 consecutive stalls');
  
  const s5UltimatumSms = sentMessages.find(m => m.to === caller5);
  assert(
    !!s5UltimatumSms && s5UltimatumSms.body.includes('To get this sorted, I just need'),
    'ABS-03: Sends hardcoded ultimatum asking directly for missing details'
  );

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO 6: Anti-Loop Stall 4 Silent Drop (ABS-04)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n6️⃣ Scenario 6: Anti-Loop Stall 4 Silent Abandonment (ABS-04)');
  // 4th unhelpful turn from the same customer (stallCount: 4 -> ABANDONED)
  sentMessages.length = 0;
  const s6ResTurn4 = await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller5,
    body: 'Why aren\'t you answering?',
  });
  const s6JsonTurn4 = JSON.parse(s6ResTurn4.body);
  assert(s6JsonTurn4.status === 'ABANDONED', 'ABS-04: Transitions to ABANDONED after 4 stalled turns');
  assert(sentMessages.length === 0, 'ABS-04: Zero outbound SMS dispatched upon abandonment');

  // Turn 5: Dropped silently
  const s6ResTurn5 = await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller5,
    body: 'Anyone home?',
  });
  const s6JsonTurn5 = JSON.parse(s6ResTurn5.body);
  assert(s6JsonTurn5.dropped === true, 'ABS-04: Subsequent messages in ABANDONED state dropped silently');

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO 7: Human Request & Profanity Escalation (ABS-05)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n7️⃣ Scenario 7: Profanity & Human Handoff (ABS-05)');
  const caller7 = '+61499000007';
  sentMessages.length = 0;

  await dispatchWorker({ eventType: 'MISSED_CALL', callerNumber: caller7 });
  sentMessages.length = 0;

  await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller7,
    body: 'Stop sending me automated bot messages, let me speak to a human right now!',
  });

  const s7Session = await sessionStore.getSession(mockTenant.tenantId, caller7);
  assert(s7Session?.status === 'ESCALATED', 'ABS-05: State transitions to ESCALATED');
  assert(
    sentMessages.some(m => m.to === mockTenant.publicPhone && m.body.includes('🚨 ESCALATION')),
    'ABS-05: Dispatches escalation alert to Tradie mobile with transcript'
  );
  assert(
    sentMessages.some(m => m.to === caller7 && (m.body.includes('flagged') || m.body.includes('team') || m.body.includes('call') || m.body.includes('handing') || m.body.includes('touch') || m.body.includes('Caleb'))),
    'ABS-05: Reassures customer that a human team member has been notified'
  );

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO 8: Multi-Message Debounce Buffer (TEL-05)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n8️⃣ Scenario 8: Multi-Message Burst Debouncing (TEL-05)');
  const caller8 = '+61499000008';
  sentMessages.length = 0;

  // 1. Initial missed call
  await dispatchWorker({ eventType: 'MISSED_CALL', callerNumber: caller8 });
  sentMessages.length = 0;

  const { MessageBufferManager } = await import('../core/message-buffer.js');
  const testBuffer = new MessageBufferManager(null); // in-memory test buffer

  // 2. Customer sends 3 rapid fragmented texts
  const ingest1 = await testBuffer.ingestMessage(mockTenant.tenantId, caller8, {
    text: 'hey',
    receivedAt: new Date().toISOString(),
  });
  const ingest2 = await testBuffer.ingestMessage(mockTenant.tenantId, caller8, {
    text: 'I have a burst pipe in my backyard',
    receivedAt: new Date().toISOString(),
  });
  const ingest3 = await testBuffer.ingestMessage(mockTenant.tenantId, caller8, {
    text: 'I live in Glenelg',
    receivedAt: new Date().toISOString(),
  });

  assert(ingest1.version === 1, 'TEL-05: Ingest 1 sets version 1');
  assert(ingest2.version === 2, 'TEL-05: Ingest 2 increments version to 2');
  assert(ingest3.version === 3, 'TEL-05: Ingest 3 increments version to 3');
  assert(ingest3.totalBuffered === 3, 'TEL-05: Buffer contains all 3 messages');

  // 3. Stale timer (version 1) fires while version 3 is in Redis -> should skip!
  const staleDrain = await testBuffer.drainIfLatest(mockTenant.tenantId, caller8, 1);
  assert(staleDrain === null, 'TEL-05: Stale debounce timer (version 1) returns null and is ignored');

  // 4. Latest timer (version 3) fires -> should drain all 3 combined!
  const latestDrain = await testBuffer.drainIfLatest(mockTenant.tenantId, caller8, 3);
  assert(latestDrain !== null, 'TEL-05: Latest debounce timer (version 3) drains successfully');
  assert(latestDrain?.messageCount === 3, 'TEL-05: Drains all 3 accumulated messages');
  assert(
    !!latestDrain &&
    latestDrain.combinedText.includes('hey') &&
    latestDrain.combinedText.includes('burst pipe') &&
    latestDrain.combinedText.includes('Glenelg'),
    'TEL-05: Concatenates all messages into a unified multi-line string'
  );

  // 5. Worker receives combined text as a single turn
  sentMessages.length = 0;
  const s8WorkerRes = await dispatchWorker({
    eventType: 'INBOUND_SMS',
    callerNumber: caller8,
    body: latestDrain!.combinedText,
  });

  const s8Session = await sessionStore.getSession(mockTenant.tenantId, caller8);
  assert(s8Session?.status === 'QUALIFYING', 'TEL-05: Single evaluation turn transitions to QUALIFYING', `Status: ${s8Session?.status}, worker code: ${s8WorkerRes.statusCode}, body: ${s8WorkerRes.body}`);
  assert(!!s8Session?.collectedData.issue, 'TEL-05: Extracted issue from combined stream', `Issue: ${s8Session?.collectedData.issue}`);
  assert(!!s8Session?.collectedData.suburb, 'TEL-05: Extracted suburb from combined stream', `Suburb: ${s8Session?.collectedData.suburb}`);
  assert(sentMessages.length === 1, 'TEL-05: Dispatched exactly ONE combined SMS reply instead of 3 fragmented replies', `sentCount: ${sentMessages.length}`);

  // ─────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────
  console.log('\n====================================================');
  console.log(`📊 LEVEL 2 SCENARIO RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    throw new Error(`Level 2 Scenario Tests Failed: ${failed} failure(s)`);
  }
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('test-level-2.ts')) {
  runLevel2ScenarioTests();
}
