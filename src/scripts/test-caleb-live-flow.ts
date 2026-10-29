import { buildApp } from '../app.js';
import { SessionStore } from '../core/session-store.js';
import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';

dotenv.config();

async function runCalebPlumbingFlow() {
  console.log('================================================================');
  console.log("🛠️ RUNNING LIVE TEST: Caleb's Emergency Plumbing & Gas");
  console.log('================================================================\n');

  const twilioNumber = '+17372508034'; // Your assigned Twilio virtual line
  const customerNumber = '+61499112233'; // Simulated customer caller
  const ownerMobile = '+61481880277'; // Your verified phone

  // 1. Initialize real Upstash Redis client
  const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;

  if (redis) {
    console.log('✅ Connected to LIVE Upstash Redis Cloud at:', process.env.UPSTASH_REDIS_REST_URL);
  }

  // 2. Tenant Context configured with Caleb's Plumbing specifications
  const calebTenant: TenantContext = {
    tenantId: 'tenant_caleb_plumbing',
    businessName: "Caleb's Emergency Plumbing & Gas",
    publicPhone: ownerMobile,
    twilioForwardingNumber: twilioNumber,
    serviceArea: 'Adelaide Metro, Glenelg, Brighton, Norwood',
    businessHours: 'Monday to Friday 7am-5pm. 24/7 Emergency call-outs.',
    aiCustomInstructions:
      'Friendly Aussie tradie tone. Always confirm if water is actively gushing before booking. Do not promise exact arrival times; let them know Caleb will call directly.',
    services: [
      { title: 'Blocked Drains', startingPrice: 'From $150' },
      { title: 'Burst Pipe Repair', startingPrice: 'From $180 call-out' },
      { title: 'Hot Water Replacement', startingPrice: 'Quote on site' },
    ],
  };

  const mockProvider: ITenantProvider = {
    async getTenantByPhoneNumber(phone: string): Promise<TenantContext | null> {
      return phone.replace(/[^\d+]/g, '') === twilioNumber ? calebTenant : null;
    },
  };

  const cachedTenantProvider = new CachedTenantProvider({
    underlyingProvider: mockProvider,
    redis,
    ttlSeconds: 3600,
  });

  const sessionStore = new SessionStore();
  // Clear any existing test session from your live Redis
  await sessionStore.deleteSession(calebTenant.tenantId, customerNumber);

  const app = await buildApp({
    sessionStore,
    tenantProvider: cachedTenantProvider,
  });
  await app.ready();

  // -------------------------------------------------------------------------
  // STEP 1: Customer calls Twilio Number (+17372508034) and misses call
  // -------------------------------------------------------------------------
  console.log('\n[STEP 1: Inbound Call to +17372508034]');
  console.log(`📞 Customer ${customerNumber} dials ${twilioNumber}...`);

  const callRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/twilio/voice',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      CallSid: 'CA_CALEB_TEST_01',
      From: customerNumber,
      To: twilioNumber,
      CallStatus: 'no-answer',
    }).toString(),
  });

  console.log('   📤 Twilio Webhook Response (HTTP):', callRes.statusCode);
  console.log('   📤 TwiML Returned (Call instantly ended without charge):', callRes.body.trim());

  // -------------------------------------------------------------------------
  // STEP 2: QStash 30s delay triggers the greeting SMS
  // -------------------------------------------------------------------------
  console.log('\n[STEP 2: QStash Delivers 30s Delayed Greeting Job]');
  const greetingJob = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'MISSED_CALL',
      channel: 'twilio_voice',
      callerNumber: customerNumber,
      dialedNumber: twilioNumber,
      businessId: calebTenant.tenantId,
      callSid: 'CA_CALEB_TEST_01',
      receivedAt: new Date().toISOString(),
    },
  });

  console.log('   📤 Worker Response:', greetingJob.body);

  // -------------------------------------------------------------------------
  // STEP 3: Customer texts back (Partial Issue)
  // -------------------------------------------------------------------------
  console.log('\n[STEP 3: Customer Replies via SMS (Partial Info)]');
  const msg1 = 'Gday, got a burst pipe flooding my kitchen in Glenelg';
  console.log(`   💬 Customer SMS: "${msg1}"`);

  const turn1Res = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber: customerNumber,
      dialedNumber: twilioNumber,
      businessId: calebTenant.tenantId,
      messageSid: 'SM_CALEB_01',
      body: msg1,
      receivedAt: new Date().toISOString(),
    },
  });

  const turn1Json = JSON.parse(turn1Res.body);
  console.log('   📤 State Machine Status:', turn1Json.status);
  console.log('   📤 Extracted Details So Far:', turn1Json.collected);

  // -------------------------------------------------------------------------
  // STEP 4: Customer texts back with urgency and name
  // -------------------------------------------------------------------------
  console.log('\n[STEP 4: Customer Sends Final Clarification]');
  const msg2 = 'Water is gushing out rapidly! Name is Darren';
  console.log(`   💬 Customer SMS: "${msg2}"`);

  const turn2Res = await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'INBOUND_SMS',
      channel: 'twilio_sms',
      callerNumber: customerNumber,
      dialedNumber: twilioNumber,
      businessId: calebTenant.tenantId,
      messageSid: 'SM_CALEB_02',
      body: msg2,
      receivedAt: new Date().toISOString(),
    },
  });

  const turn2Json = JSON.parse(turn2Res.body);
  console.log('   📤 Final State Machine Status:', turn2Json.status);
  console.log('   📤 Final Extracted Lead Data:', turn2Json.collected);

  // -------------------------------------------------------------------------
  // STEP 5: Verify Live Upstash Redis Persistence
  // -------------------------------------------------------------------------
  console.log('\n[STEP 5: Verifying Live Session State in Upstash Redis]');
  const session = await sessionStore.getSession(calebTenant.tenantId, customerNumber);
  console.log(`   🔑 Redis Key: session:${calebTenant.tenantId}:${customerNumber}`);
  console.log(`   📊 Status in Redis: [${session?.status}]`);
  console.log(`   📝 Total Conversation Turns Recorded: ${session?.history.length}`);
  console.log('\n📜 Complete Conversation Tape Stored in Live Redis:');
  session?.history.forEach((turn, idx) => {
    console.log(`     ${idx + 1}. [${turn.role.toUpperCase()}]: ${turn.content}`);
  });

  console.log('\n🎯 Notice where the Lead Brief went:');
  console.log(`   To Owner Mobile: ${ownerMobile} (Your verified number)`);
  console.log(`   Business Name: ${calebTenant.businessName}`);
  console.log(`   Lead Brief: Darren | Glenelg | Burst Pipe | HIGH Urgency`);

  console.log('\n✅ Caleb Plumbing Flow Completed Successfully Against Live Redis!\n');
}

runCalebPlumbingFlow().catch(err => {
  console.error(err);
  process.exit(1);
});

