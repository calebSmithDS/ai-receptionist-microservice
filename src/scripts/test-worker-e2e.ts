import { SessionStore } from '../core/session-store.js';
import { GeminiQualificationEvaluator } from '../core/gemini-evaluator.js';
import { TwilioSmsClient } from '../core/twilio-client.js';
import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { registerProcessMessageWorkerRoute } from '../routes/process-message.worker.js';
import Fastify from 'fastify';

async function testWorkerE2E() {
  console.log('🧪 Testing End-to-End Worker Lifecycle with Multi-Turn History & Tenant Cache...\n');

  const app = Fastify({ logger: false });
  const sessionStore = new SessionStore();
  const gemini = new GeminiQualificationEvaluator();
  const twilio = new TwilioSmsClient();

  // Mock Sanity provider
  const mockSanityProvider: ITenantProvider = {
    async getTenantByPhoneNumber(phone: string): Promise<TenantContext | null> {
      return {
        tenantId: 'tenant_apex_plumbing',
        businessName: 'Apex Plumbing Specialists',
        publicPhone: '+61411222333',
        twilioForwardingNumber: phone,
        serviceArea: 'Eastern Suburbs',
        services: [{ title: 'Emergency Blocked Drains', startingPrice: '$150' }],
        aiCustomInstructions: 'Always be polite and confirm urgency level.',
      };
    },
  };

  const cachedTenantProvider = new CachedTenantProvider({
    underlyingProvider: mockSanityProvider,
    ttlSeconds: 3600,
  });

  registerProcessMessageWorkerRoute(app, sessionStore, gemini, twilio, cachedTenantProvider);
  await app.ready();

  const callerNumber = '+61499112233';
  const dialedNumber = '+61488880000';
  const businessId = 'tenant_apex_plumbing';

  // Clean any previous test session
  await sessionStore.deleteSession(businessId, callerNumber);

  // -------------------------------------------------------------------------
  // STEP 1: Process Missed Call Event
  // -------------------------------------------------------------------------
  console.log('1️⃣ Simulating QStash job: MISSED_CALL');
  const missedCallRes = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'MISSED_CALL',
      channel: 'twilio_voice',
      callerNumber,
      dialedNumber,
      callSid: 'CA_TEST_E2E_1',
      receivedAt: new Date().toISOString(),
    },
  });

  console.log(`   Worker HTTP Status: ${missedCallRes.statusCode}`);
  const step1Body = JSON.parse(missedCallRes.body);
  console.log(`   Session State: ${step1Body.status}`);
  if (step1Body.status !== 'AWAITING_REPLY') {
    throw new Error(`Expected AWAITING_REPLY, got ${step1Body.status}`);
  }

  let session = await sessionStore.getSession(businessId, callerNumber);
  console.log(`   Turns in conversation tape: ${session?.history.length}`);
  console.log(`   Turn 1: [${session?.history[0]?.role.toUpperCase()}] "${session?.history[0]?.content}"`);

  // -------------------------------------------------------------------------
  // STEP 2: Customer replies (Turn 1: incomplete details)
  // -------------------------------------------------------------------------
  console.log('\n2️⃣ Simulating QStash job: INBOUND_SMS (Customer: "Blocked drain in Maroubra")');
  const turn1Res = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber,
      dialedNumber,
      messageSid: 'SM_TEST_TURN_1',
      body: 'Blocked drain in Maroubra',
      receivedAt: new Date().toISOString(),
    },
  });

  const step2Body = JSON.parse(turn1Res.body);
  console.log(`   Session State: ${step2Body.status}`);
  console.log(`   Collected so far:`, JSON.stringify(step2Body.collected));

  session = await sessionStore.getSession(businessId, callerNumber);
  console.log(`   Turns in conversation tape: ${session?.history.length}`);

  // -------------------------------------------------------------------------
  // STEP 3: Customer replies again (Turn 2: providing remaining details)
  // -------------------------------------------------------------------------
  console.log('\n3️⃣ Simulating QStash job: INBOUND_SMS (Customer: "It is overflowing into the driveway urgently. Name is Mark")');
  const turn2Res = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber,
      dialedNumber,
      messageSid: 'SM_TEST_TURN_2',
      body: 'It is overflowing into the driveway urgently. Name is Mark',
      receivedAt: new Date().toISOString(),
    },
  });

  const step3Body = JSON.parse(turn2Res.body);
  console.log(`   Session State: ${step3Body.status}`);
  console.log(`   Final Lead Data:`, JSON.stringify(step3Body.collected));

  session = await sessionStore.getSession(businessId, callerNumber);
  console.log(`\n📜 Full Conversation Tape Saved in Redis:`);
  session?.history.forEach((turn, idx) => {
    console.log(`   Turn ${idx + 1} [${turn.role.toUpperCase()}]: ${turn.content}`);
  });

  if (session?.status !== 'COMPLETED') {
    throw new Error(`Expected session status COMPLETED, got ${session?.status}`);
  }

  console.log('\n✅ End-to-End Worker & Multi-Turn History verified successfully!');
}

testWorkerE2E().catch(err => {
  console.error('\n❌ E2E Worker test failed:', err);
  process.exit(1);
});

