import { buildServer } from '../server.js';
import { InboundSmsEvent } from '../contracts/inbound-sms.contract.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { GeminiReceptionistAgent } from '../agent/gemini-receptionist.agent.js';
import { LeadDispatcher } from '../integrations/lead-dispatcher.js';
import { registerSmsWorkerRoute } from '../routes/sms-worker.route.js';
import Fastify from 'fastify';

// Mock tenant provider for test run
class MockTenantProvider implements ITenantProvider {
  async getTenantByPhoneNumber(_phone: string): Promise<TenantContext | null> {
    return {
      tenantId: 'tenant_adelaide_plumbing',
      businessName: 'Adelaide Hills Plumbing',
      publicPhone: '+61412345678',
      twilioForwardingNumber: '+61488889999',
      serviceArea: 'Adelaide Hills (Mount Barker, Stirling, Aldgate)',
      businessHours: 'Mon-Fri 7am-5pm. 24/7 Emergency call-outs.',
      aiCustomInstructions: 'Never quote fixed repair prices over SMS. Standard dispatch fee is $150.',
      services: [
        { title: 'Emergency Plumbing', startingPrice: '$150 dispatch' },
        { title: 'Hot Water Repairs', startingPrice: '$150 assessment' },
        { title: 'Blocked Drains', startingPrice: '$180 clearing fee' },
      ],
    };
  }
}

async function test() {
  console.log('--- Testing AI SMS Worker Route ---\n');

  const app = Fastify();
  const mockTenantProvider = new MockTenantProvider();
  const agent = new GeminiReceptionistAgent();
  const leadDispatcher = new LeadDispatcher();

  registerSmsWorkerRoute(app, mockTenantProvider, agent, leadDispatcher);
  await app.ready();

  const mockQStashEvent: InboundSmsEvent = {
    messageId: 'telnyx_msg_test_001',
    fromPhone: '+61499112233',
    toPhone: '+61488889999',
    body: "G'day, my name is Dave. I have a burst water pipe flooding the laundry in Mount Barker, need help ASAP!",
    provider: 'telnyx',
    receivedAt: new Date().toISOString(),
  };

  console.log('Sending queued event to Worker endpoint...\n');
  const response = await app.inject({
    method: 'POST',
    url: '/api/workers/process-sms',
    payload: mockQStashEvent,
  });

  console.log(`Status Code: ${response.statusCode}`);
  console.log('Response Payload:\n', JSON.stringify(JSON.parse(response.body), null, 2));

  await app.close();
}

test();

