import { buildServer } from '../server.js';

async function test() {
  console.log('--- Testing Telnyx Ingest Webhook ---\n');

  const app = buildServer();
  await app.ready();

  // Simulated Telnyx "message.received" webhook payload
  const mockTelnyxPayload = {
    data: {
      event_type: 'message.received',
      id: 'telnyx_msg_abc123',
      payload: {
        id: 'telnyx_msg_abc123',
        from: { phone_number: '+61412345678' },
        to: [{ phone_number: '+61488889999' }],
        text: 'Hi, I need an urgent plumber in Mount Barker!',
      },
    },
  };

  const startTime = performance.now();

  const response = await app.inject({
    method: 'POST',
    url: '/api/webhooks/sms/telnyx',
    payload: mockTelnyxPayload,
  });

  const totalTime = (performance.now() - startTime).toFixed(2);

  console.log(`\nHTTP Status Code: ${response.statusCode}`);
  console.log('Response Body:', response.body);
  console.log(`Total round-trip time: ${totalTime}ms`);

  if (response.statusCode === 200 && Number(totalTime) < 50) {
    console.log('\n✅ TEST PASSED: Webhook acknowledged in sub-50ms window!');
  } else {
    console.log('\n⚠️ Check response or timing.');
  }

  await app.close();
}

test();

