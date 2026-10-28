import { buildApp } from '../app.js';
import { SessionStore } from '../core/session-store.js';

async function testPhase2() {
  console.log('🧪 Running Phase 2 Verification...\n');

  // 1. Verify SessionStore logic
  console.log('1️⃣ Testing SessionStore (get, create, save)...');
  const sessionStore = new SessionStore();
  const businessId = 'biz_trade_999';
  const callerNumber = '+61499998888';

  const { session, isNew } = await sessionStore.getOrCreateSession({
    businessId,
    callerNumber,
    callSid: 'CA_TEST_PHASE2',
  });

  console.log(`   Session created? ${isNew}`);
  console.log(`   Initial status: ${session.status}`);
  console.log(`   Channel: ${session.channel}`);

  if (!isNew || session.status !== 'INIT') {
    throw new Error('SessionStore failed to initialize state properly');
  }

  // 2. Verify Inbound SMS Webhook
  console.log('\n2️⃣ Testing Fastify Inbound SMS Webhook (/api/webhooks/twilio/sms)...');
  const app = await buildApp();
  await app.ready();

  const smsPayload = new URLSearchParams({
    MessageSid: 'SM1234567890abcdef1234567890abcdef',
    From: callerNumber,
    To: '+61400001111',
    Body: 'Hi, I have a burst water pipe in Bondi. Need help urgently!',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/mock-pipe-photo.jpg',
  }).toString();

  const startTime = performance.now();
  const response = await app.inject({
    method: 'POST',
    url: '/api/webhooks/twilio/sms',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: smsPayload,
  });
  const durationMs = (performance.now() - startTime).toFixed(2);

  console.log(`   HTTP Status: ${response.statusCode}`);
  console.log(`   Response Time: ${durationMs}ms`);
  console.log(`   Content-Type: ${response.headers['content-type']}`);
  console.log(`   Response Body: ${response.body}`);

  if (response.statusCode !== 200) {
    throw new Error(`Expected 200 OK from SMS webhook, got ${response.statusCode}`);
  }

  if (!response.body.includes('<Response></Response>')) {
    throw new Error(`Expected empty TwiML <Response></Response>, got ${response.body}`);
  }

  console.log('\n✅ Phase 2 verified successfully!');
}

testPhase2().catch(err => {
  console.error('\n❌ Phase 2 test failed:', err);
  process.exit(1);
});

