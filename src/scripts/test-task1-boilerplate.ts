import { buildApp } from '../app.js';
import {
  buildSessionKey,
  createInitialSession,
  SessionStateSchema,
} from '../contracts/session-state.contract.js';

async function testBoilerplate() {
  console.log('🧪 Running Task 1 Boilerplate Verification...\n');

  // 1. Verify State Machine Contract & Helpers
  console.log('1️⃣ Testing Upstash Redis Session State Schema...');
  const businessId = 'biz_plumbing_co_123';
  const callerNumber = '+61412345678';
  const callSid = 'CA1234567890abcdef1234567890abcdef';

  const redisKey = buildSessionKey(businessId, callerNumber);
  console.log(`   Redis Key: ${redisKey}`);
  if (redisKey !== 'session:biz_plumbing_co_123:+61412345678') {
    throw new Error(`Unexpected Redis key: ${redisKey}`);
  }

  const initialSession = createInitialSession({
    businessId,
    callerNumber,
    callSid,
    channel: 'twilio_voice',
  });

  const parsed = SessionStateSchema.safeParse(initialSession);
  if (!parsed.success) {
    throw new Error(`Session validation failed: ${JSON.stringify(parsed.error.format())}`);
  }
  console.log('   ✅ Initial Session State is valid:');
  console.log(`      Status: ${initialSession.status}`);
  console.log(`      Channel: ${initialSession.channel}`);
  console.log(`      CallSid: ${initialSession.metadata.callSid}`);

  // 2. Verify Fastify App & Twilio Voice Webhook via app.inject()
  console.log('\n2️⃣ Testing Fastify Inbound Twilio Voice Webhook (/api/webhooks/twilio/voice)...');
  const app = await buildApp();
  await app.ready();

  const formPayload = new URLSearchParams({
    CallSid: callSid,
    From: callerNumber,
    To: '+61488889999',
    CallStatus: 'ringing',
    Direction: 'inbound',
  }).toString();

  const response = await app.inject({
    method: 'POST',
    url: '/api/webhooks/twilio/voice',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: formPayload,
  });

  console.log(`   HTTP Status: ${response.statusCode}`);
  console.log(`   Content-Type: ${response.headers['content-type']}`);
  console.log(`   Response Body: ${response.body}`);

  // Destination worker URL verified
  if (response.statusCode !== 200) {
    throw new Error(`Expected HTTP 200, got ${response.statusCode}`);
  }

  if (!response.body.includes('<Response><Reject /></Response>')) {
    throw new Error(`Expected <Response><Reject /></Response>, got: ${response.body}`);
  }

  console.log('\n✅ All Task 1 checks passed successfully!');
}

testBoilerplate().catch(err => {
  console.error('\n❌ Verification failed:', err);
  process.exit(1);
});

