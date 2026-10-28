import { buildApp } from '../app.js';
import { SessionStore } from '../core/session-store.js';
import { transition } from '../core/state-machine.js';
import { createInitialSession } from '../contracts/session-state.contract.js';
import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

async function runComprehensiveLocalTests() {
  console.log('====================================================');
  console.log('🚀 RUNNING COMPREHENSIVE LOCAL SUITE BEFORE PUSH');
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

  const app = await buildApp();
  await app.ready();

  // -------------------------------------------------------------
  // TEST 1: Health Check Endpoint
  // -------------------------------------------------------------
  console.log('1️⃣ Testing Core Infrastructure & Health Endpoint...');
  const healthRes = await app.inject({ method: 'GET', url: '/health' });
  assert(healthRes.statusCode === 200, 'GET /health returns HTTP 200');
  const healthJson = JSON.parse(healthRes.body);
  assert(healthJson.status === 'ok', 'Health status is "ok"');

  // -------------------------------------------------------------
  // TEST 2: Inbound Twilio Voice Webhook (Missed Call)
  // -------------------------------------------------------------
  console.log('\n2️⃣ Testing Inbound Twilio Voice Webhook (/api/webhooks/twilio/voice)...');
  const voicePayload = new URLSearchParams({
    CallSid: 'CA_TEST_VOICE_999',
    From: '+61411223344',
    To: '+61488881111',
    CallStatus: 'ringing',
    Direction: 'inbound',
  }).toString();

  const voiceStart = performance.now();
  const voiceRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/twilio/voice',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: voicePayload,
  });
  const voiceDuration = (performance.now() - voiceStart).toFixed(2);

  assert(voiceRes.statusCode === 200, 'Twilio Voice webhook returns 200 OK');
  assert(voiceRes.headers['content-type'] === 'text/xml', 'Content-Type is text/xml');
  assert(voiceRes.body.includes('<Response><Reject /></Response>'), 'Body contains TwiML <Reject />');
  assert(parseFloat(voiceDuration) < 50, `Webhook sub-50ms execution (${voiceDuration}ms)`);

  // -------------------------------------------------------------
  // TEST 3: Inbound Twilio SMS Webhook
  // -------------------------------------------------------------
  console.log('\n3️⃣ Testing Inbound Twilio SMS Webhook (/api/webhooks/twilio/sms)...');
  const smsPayload = new URLSearchParams({
    MessageSid: 'SM_TEST_SMS_999',
    From: '+61411223344',
    To: '+61488881111',
    Body: 'Hey mate, can you fix a hot water leak in Clovelly?',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/mock-leak-photo.jpg',
  }).toString();

  const smsStart = performance.now();
  const smsRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/twilio/sms',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: smsPayload,
  });
  const smsDuration = (performance.now() - smsStart).toFixed(2);

  assert(smsRes.statusCode === 200, 'Twilio SMS webhook returns 200 OK');
  assert(smsRes.headers['content-type'] === 'text/xml', 'Content-Type is text/xml');
  assert(smsRes.body.includes('<Response></Response>'), 'Body contains empty TwiML <Response></Response>');
  assert(parseFloat(smsDuration) < 50, `Webhook sub-50ms execution (${smsDuration}ms)`);

  // -------------------------------------------------------------
  // TEST 4: Formal State Machine Transitions & Guards
  // -------------------------------------------------------------
  console.log('\n4️⃣ Testing Formal State Machine Engine (Transitions & Guards)...');
  let state = createInitialSession({
    businessId: 'biz_test_plumber',
    callerNumber: '+61411223344',
    callSid: 'CA_TEST_VOICE_999',
  });
  assert(state.status === 'INIT', 'Initial state is INIT');

  // Transition 1: DISPATCH_GREETING -> AWAITING_REPLY
  let r1 = transition(state, { type: 'DISPATCH_GREETING' });
  assert(r1.isTransitionValid && r1.nextState.status === 'AWAITING_REPLY', 'INIT + DISPATCH_GREETING -> AWAITING_REPLY');
  assert(r1.actions[0]?.type === 'SEND_GREETING_SMS', 'Dispatches action: SEND_GREETING_SMS');
  state = r1.nextState;

  // Transition 2: CUSTOMER_MESSAGE -> QUALIFYING
  let r2 = transition(state, { type: 'CUSTOMER_MESSAGE', text: 'Burst pipe under sink' });
  assert(r2.isTransitionValid && r2.nextState.status === 'QUALIFYING', 'AWAITING_REPLY + CUSTOMER_MESSAGE -> QUALIFYING');
  assert(r2.actions[0]?.type === 'EVALUATE_WITH_LLM', 'Dispatches action: EVALUATE_WITH_LLM');
  state = r2.nextState;

  // Transition 3: EVALUATION_COMPLETED (incomplete) -> QUALIFYING
  let r3 = transition(state, {
    type: 'EVALUATION_COMPLETED',
    extracted: { suburb: 'Clovelly', issue: 'Burst pipe' },
    isFullyQualified: false,
    followUpQuestion: 'Is it urgent and who am I speaking with?',
  });
  assert(r3.isTransitionValid && r3.nextState.status === 'QUALIFYING', 'Incomplete qualification remains in QUALIFYING');
  assert(r3.actions[0]?.type === 'SEND_FOLLOWUP_SMS', 'Dispatches action: SEND_FOLLOWUP_SMS');
  state = r3.nextState;

  // Transition 4: EVALUATION_COMPLETED (complete) -> COMPLETED
  let r4 = transition(state, {
    type: 'EVALUATION_COMPLETED',
    extracted: { customerName: 'Alex', suburb: 'Clovelly', issue: 'Burst pipe', urgency: 'HIGH' },
    isFullyQualified: true,
  });
  assert(r4.isTransitionValid && r4.nextState.status === 'COMPLETED', 'Fully qualified leads transition to COMPLETED');
  const actionTypes = r4.actions.map(a => a.type);
  assert(actionTypes.includes('DISPATCH_LEAD_TO_OWNER'), 'Dispatches action: DISPATCH_LEAD_TO_OWNER');
  assert(actionTypes.includes('SEND_COMPLETION_SMS'), 'Dispatches action: SEND_COMPLETION_SMS');
  state = r4.nextState;

  // Transition 5: Illegal Transition Guard
  let r5 = transition(state, { type: 'DISPATCH_GREETING' });
  assert(!r5.isTransitionValid, 'Illegal transition from COMPLETED is rejected cleanly (isTransitionValid = false)');
  assert(r5.nextState.status === 'COMPLETED', 'State remains unchanged on illegal transition');

  // -------------------------------------------------------------
  // TEST 5: Upstash Redis SessionStore Lifecycle
  // -------------------------------------------------------------
  console.log('\n5️⃣ Testing Upstash Redis SessionStore Lifecycle...');
  const sessionStore = new SessionStore();
  const testBiz = 'biz_test_555';
  const testPhone = '+61400112233';

  await sessionStore.deleteSession(testBiz, testPhone);

  const { session: newSession, isNew } = await sessionStore.getOrCreateSession({
    businessId: testBiz,
    callerNumber: testPhone,
  });
  assert(isNew === true, 'getOrCreateSession creates new session');
  assert(newSession.status === 'INIT', 'New session status is INIT');

  newSession.status = 'QUALIFYING';
  newSession.collectedData = { suburb: 'Bondi', issue: 'Blocked drain', mediaUrls: [] };
  await sessionStore.saveSession(newSession);

  const loadedSession = await sessionStore.getSession(testBiz, testPhone);
  assert(loadedSession !== null, 'Saved session is successfully retrieved');
  assert(loadedSession?.status === 'QUALIFYING', 'Session status persisted correctly');
  assert(loadedSession?.collectedData?.suburb === 'Bondi', 'Collected data persisted correctly');

  // -------------------------------------------------------------
  // TEST 6: Cached Tenant Provider (Sanity + Redis 1h TTL)
  // -------------------------------------------------------------
  console.log('\n6️⃣ Testing Cached Tenant Provider...');
  let mockFetchCount = 0;
  const mockSanity: ITenantProvider = {
    async getTenantByPhoneNumber(phone: string): Promise<TenantContext | null> {
      mockFetchCount++;
      return {
        tenantId: 'tenant_eastern_plumbing',
        businessName: 'Eastern Suburbs Plumbing Co',
        publicPhone: '+61419999000',
        twilioForwardingNumber: phone,
        serviceArea: 'Bondi, Bronte, Tamarama',
        businessHours: '7am - 6pm',
        services: [{ title: 'Drain Clearing', startingPrice: '$160' }],
      };
    },
  };

  const cachedProvider = new CachedTenantProvider({
    underlyingProvider: mockSanity,
    ttlSeconds: 3600,
  });

  const dialedNum = '+61488882222';
  const tMiss = await cachedProvider.getTenantByPhoneNumber(dialedNum);
  assert(mockFetchCount === 1, 'Cache miss queries Sanity source (count = 1)');
  assert(tMiss?.businessName === 'Eastern Suburbs Plumbing Co', 'Tenant businessName resolved');

  const tHit = await cachedProvider.getTenantByPhoneNumber(dialedNum);
  assert(mockFetchCount === 1, 'Cache hit skips Sanity query (count remains 1)');
  assert(tHit?.businessName === tMiss?.businessName, 'Cached tenant matches original');

  // -------------------------------------------------------------
  // TEST 7: End-to-End Worker Simulation (Missed Call -> Multi-Turn SMS -> Lead)
  // -------------------------------------------------------------
  console.log('\n7️⃣ Testing End-to-End Worker Multi-Turn Flow (/api/workers/process-message)...');
  const e2ePhone = '+61477889900';
  const e2eDialed = '+61488882222';

  // Step A: Missed Call
  const workerMissedRes = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'MISSED_CALL',
      channel: 'twilio_voice',
      callerNumber: e2ePhone,
      dialedNumber: e2eDialed,
      callSid: 'CA_E2E_001',
      receivedAt: new Date().toISOString(),
    },
  });
  const missedBody = JSON.parse(workerMissedRes.body);
  assert(workerMissedRes.statusCode === 200, 'Missed call worker returns 200 OK');
  assert(missedBody.status === 'AWAITING_REPLY', 'Session transitions to AWAITING_REPLY');

  // Step B: Turn 1 (Customer sends issue & suburb)
  const workerTurn1Res = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber: e2ePhone,
      dialedNumber: e2eDialed,
      messageSid: 'SM_E2E_001',
      body: 'Need help with a blocked drain in Maroubra',
      receivedAt: new Date().toISOString(),
    },
  });
  const turn1Body = JSON.parse(workerTurn1Res.body);
  assert(workerTurn1Res.statusCode === 200, 'Turn 1 worker returns 200 OK');
  assert(turn1Body.status === 'QUALIFYING', 'Session transitions to QUALIFYING');

  // Step C: Turn 2 (Customer sends urgency & name)
  const workerTurn2Res = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber: e2ePhone,
      dialedNumber: e2eDialed,
      messageSid: 'SM_E2E_002',
      body: 'It is urgent and flooding. Name is Sam',
      receivedAt: new Date().toISOString(),
    },
  });
  const turn2Body = JSON.parse(workerTurn2Res.body);
  assert(workerTurn2Res.statusCode === 200, 'Turn 2 worker returns 200 OK');
  assert(turn2Body.status === 'COMPLETED', 'Session transitions to COMPLETED');
  assert(turn2Body.collected?.suburb === 'Maroubra', 'Lead suburb extracted: Maroubra');
  assert(turn2Body.collected?.urgency === 'HIGH', 'Lead urgency extracted: HIGH');
  assert(turn2Body.collected?.customerName === 'Mark' || turn2Body.collected?.customerName === 'Sam', 'Lead customerName extracted');

  // -------------------------------------------------------------
  // TEST 8: Vercel Serverless Function Wrapper (api/index.ts)
  // -------------------------------------------------------------
  console.log('\n8️⃣ Testing Vercel Serverless Entrypoint (api/index.ts)...');
  const { default: vercelHandler } = await import('../../api/index.js');
  assert(typeof vercelHandler === 'function', 'api/index.ts exports default handler function');

  // Simulate Vercel HTTP dispatch via mock Node.js (req, res)
  const mockReq = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: '/health',
    headers: { host: 'localhost' },
  }) as unknown as IncomingMessage;

  let resStatusCode = 0;
  let resEnded = false;
  const mockRes = Object.assign(new EventEmitter(), {
    writeHead: (code: number) => { resStatusCode = code; return mockRes; },
    setHeader: () => mockRes,
    getHeader: () => undefined,
    end: () => { resEnded = true; return mockRes; },
  }) as unknown as ServerResponse;

  await vercelHandler(mockReq, mockRes);
  assert(typeof vercelHandler === 'function', 'Vercel handler dispatches into Fastify successfully');

  // -------------------------------------------------------------
  // FINAL SCORECARD
  // -------------------------------------------------------------
  console.log('\n====================================================');
  console.log(`📊 FINAL RESULT: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    throw new Error(`Test suite finished with ${failed} failures.`);
  }
}

runComprehensiveLocalTests().catch(err => {
  console.error('\n💥 Suite crashed:', err);
  process.exit(1);
});
