import { buildApp } from '../app.js';
import { SessionStore } from '../core/session-store.js';
import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';

async function runDemoScenarios() {
  const sessionStore = new SessionStore();

  // Instant local mock tenant provider so tests execute in milliseconds without network DNS wait
  const mockTenantProvider: ITenantProvider = {
    async getTenantByPhoneNumber(phone: string): Promise<TenantContext | null> {
      return {
        tenantId: 'tenant_apex_plumbing',
        businessName: 'Apex Plumbing Specialists',
        publicPhone: '+61411222333',
        twilioForwardingNumber: phone,
        serviceArea: 'Bondi, Coogee, Maroubra',
        services: [{ title: 'Emergency Burst Pipes', startingPrice: '$180' }],
        aiCustomInstructions: 'Confirm if water is actively leaking.',
      };
    },
  };

  const cachedTenantProvider = new CachedTenantProvider({
    underlyingProvider: mockTenantProvider,
    ttlSeconds: 3600,
  });

  const app = await buildApp({
    sessionStore,
    tenantProvider: cachedTenantProvider,
  });
  await app.ready();

  const callerNumber = '+61499112233';
  const dialedNumber = '+61488880000';
  const businessId = 'tenant_apex_plumbing';

  const separator = (title: string) => {
    console.log('\n' + '='.repeat(65));
    console.log(`📌 ${title}`);
    console.log('='.repeat(65));
  };

  // =========================================================================
  // SCENARIO 1: The "Good" Test - Full Qualification Lifecycle
  // =========================================================================
  separator('SCENARIO 1 (GOOD): Missed Call -> Qualification -> Lead Captured');
  await sessionStore.deleteSession(businessId, callerNumber);

  // Step 1: Twilio Voice Webhook
  console.log('\n--- Step 1: Inbound Missed Call ---');
  console.log('📥 INCOMING WEBHOOK from Twilio:');
  console.log({
    CallSid: 'CA_GOOD_TEST_01',
    From: callerNumber,
    To: dialedNumber,
    CallStatus: 'no-answer',
  });

  const voiceRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/twilio/voice',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      CallSid: 'CA_GOOD_TEST_01',
      From: callerNumber,
      To: dialedNumber,
      CallStatus: 'no-answer',
    }).toString(),
  });

  console.log('📤 WEBHOOK RESPONSE (HTTP Status):', voiceRes.statusCode);
  console.log('📤 TWIML OUTPUT (Reject Call, No Connection Charge):');
  console.log(voiceRes.body.trim());

  // Step 2: QStash delayed job dispatch
  console.log('\n--- Step 2: QStash 30s Delayed Greeting Trigger ---');
  console.log('📥 QSTASH POST to /api/workers/process-message:');
  console.log({ eventType: 'MISSED_CALL', caller: callerNumber });

  const greetRes = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'MISSED_CALL',
      channel: 'twilio_voice',
      callerNumber,
      dialedNumber,
      businessId,
      callSid: 'CA_GOOD_TEST_01',
      receivedAt: new Date().toISOString(),
    },
  });
  console.log('📤 WORKER RESPONSE:', greetRes.body);

  // Step 3: Customer replies with partial details
  console.log('\n--- Step 3: Customer Replies with Partial Issue ---');
  const userMsg1 = 'My hot water heater just exploded in Bondi';
  console.log(`📥 CUSTOMER SMS: "${userMsg1}"`);

  const smsRes1 = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber,
      dialedNumber,
      businessId,
      messageSid: 'SM_GOOD_01',
      body: userMsg1,
      receivedAt: new Date().toISOString(),
    },
  });
  const smsBody1 = JSON.parse(smsRes1.body);
  console.log('📤 CURRENT STATE:', smsBody1.status);
  console.log('📤 EXTRACTED DATA SO FAR:', smsBody1.collected);

  // Step 4: Customer completes qualification
  console.log('\n--- Step 4: Customer Supplies Remaining Details ---');
  const userMsg2 = 'It is flooding the basement urgently! Name is Greg';
  console.log(`📥 CUSTOMER SMS: "${userMsg2}"`);

  const smsRes2 = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber,
      dialedNumber,
      businessId,
      messageSid: 'SM_GOOD_02',
      body: userMsg2,
      receivedAt: new Date().toISOString(),
    },
  });
  const smsBody2 = JSON.parse(smsRes2.body);
  console.log('📤 FINAL STATE:', smsBody2.status);
  console.log('📤 FINAL QUALIFIED LEAD BRIEF DISPATCHED TO OWNER:');
  console.log(smsBody2.collected);

  // =========================================================================
  // SCENARIO 2: The "Bad" Test - Malformed Inbound Webhook
  // =========================================================================
  separator('SCENARIO 2 (BAD): Corrupted / Incomplete Twilio Webhook');
  console.log('📥 INCOMING WEBHOOK with Missing Phone Numbers:');
  console.log({ CallSid: 'CA_CORRUPT_001' });

  const brokenRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/twilio/voice',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ CallSid: 'CA_CORRUPT_001' }).toString(),
  });

  console.log('📤 HTTP Status:', brokenRes.statusCode);
  console.log('📤 Defensive TwiML (Drops call cleanly, prevents endless carrier retries):');
  console.log(brokenRes.body.trim());

  // =========================================================================
  // SCENARIO 3: The "Bad / Edge Case" Test - Anger & Escalation Detection
  // =========================================================================
  separator('SCENARIO 3 (BAD): Frustrated Customer Triggers Escalation');
  const angryCaller = '+61499555666';
  await sessionStore.deleteSession(businessId, angryCaller);

  const angryMsg = "STOP WITH THIS AUTOMATED BOT! I've been waiting 4 hours, get me a real human right now!";
  console.log(`📥 CUSTOMER SMS: "${angryMsg}"`);

  const angryRes = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber: angryCaller,
      dialedNumber,
      businessId,
      messageSid: 'SM_ANGRY_01',
      body: angryMsg,
      receivedAt: new Date().toISOString(),
    },
  });

  const angryJson = JSON.parse(angryRes.body);
  console.log('📤 WORKER RESULT STATUS:', angryJson.status);

  const angrySession = await sessionStore.getSession(businessId, angryCaller);
  console.log('📤 REDIS STATE MACHINE STATUS:', angrySession?.status);
  console.log('📤 REDIS ESCALATION DETAILS:');
  console.log(angrySession?.escalation);

  // =========================================================================
  // SCENARIO 4: The "Bad / Replay" Test - Illegal Transition Guard
  // =========================================================================
  separator('SCENARIO 4 (BAD): Duplicate Missed Call Replayed on Completed Lead');
  console.log('📥 REPLAY: QStash accidentally redelivers MISSED_CALL to an already COMPLETED lead');

  const replayRes = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'MISSED_CALL',
      channel: 'twilio_voice',
      callerNumber: callerNumber, // Greg from Scenario 1
      dialedNumber,
      businessId,
      callSid: 'CA_REPLAY_DUPLICATE',
      receivedAt: new Date().toISOString(),
    },
  });

  console.log('📤 WORKER RESPONSE (Guard Triggered):', replayRes.body);
  const gregSession = await sessionStore.getSession(businessId, callerNumber);
  console.log(`📤 REDIS STATE REMAINS: [${gregSession?.status}] (Zero duplicate greeting sent)`);

  console.log('\n🏁 All Good and Bad Scenarios Executed Successfully!\n');
}

runDemoScenarios().catch(err => {
  console.error(err);
  process.exit(1);
});

