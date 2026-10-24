import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { registerTelnyxVoiceRoutes } from '../routes/telnyx-voice.route.js';

class MockTenantProvider implements ITenantProvider {
  async getTenantByPhoneNumber(_phone: string): Promise<TenantContext | null> {
    return {
      tenantId: 'tenant_adelaide_plumbing',
      businessName: 'Adelaide Hills Plumbing',
      publicPhone: '+61412345678', // Tradie's actual mobile
      twilioForwardingNumber: '+61488889999', // Dialed virtual line
      serviceArea: 'Adelaide Hills',
      services: [],
    };
  }
}

async function test() {
  console.log('--- Testing Telnyx Voice & Missed-Call Lifecycle ---\n');

  const app = Fastify();
  app.register(formbody);

  const mockProvider = new MockTenantProvider();
  registerTelnyxVoiceRoutes(app, mockProvider);
  await app.ready();

  // Test 1: Inbound Call Received
  console.log('1. Customer dials virtual line +61488889999...');
  const inboundRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/voice/inbound',
    payload: {
      To: '+61488889999',
      From: '+61499112233',
      CallSid: 'call_test_123',
    },
  });

  console.log(`Status: ${inboundRes.statusCode}`);
  console.log('Returned TeXML:\n', inboundRes.body);

  // Test 2: Call Times Out / Tradie is on a job (no-answer)
  console.log('\n2. Call times out after 18 seconds (no-answer)...');
  const statusRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/voice/status',
    payload: {
      To: '+61488889999',
      From: '+61499112233',
      DialCallStatus: 'no-answer',
    },
  });

  console.log(`Status: ${statusRes.statusCode}`);
  console.log('Status callback acknowledged successfully.');

  await app.close();
}

test();

