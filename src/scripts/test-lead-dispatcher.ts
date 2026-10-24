import { LeadDispatcher } from '../integrations/lead-dispatcher.js';
import { TenantContext } from '../core/types/tenant.js';
import { ExtractedLead } from '../agent/gemini-receptionist.agent.js';

async function test() {
  console.log('--- Testing WaaS LeadDispatcher ---\n');

  const dispatcher = new LeadDispatcher();

  const mockTenant: TenantContext = {
    tenantId: 'tenant_adelaide_plumbing',
    businessName: 'Adelaide Hills Plumbing',
    publicPhone: '+61412345678',
    twilioForwardingNumber: '+61488889999',
    serviceArea: 'Adelaide Hills',
    services: [],
    customDomain: 'adelaidehillsplumbing.com.au',
  };

  const mockLead: ExtractedLead = {
    customerName: 'Sarah Jenkins',
    suburb: 'Mount Barker',
    jobDescription: 'Burst hot water cylinder leaking in laundry',
    urgency: 'EMERGENCY',
    isWithinServiceArea: true,
  };

  const mockTranscript = [
    { role: 'user' as const, text: 'Hey, our hot water system just burst and water is flooding the laundry!' },
    { role: 'model' as const, text: 'Sorry to hear that Sarah! Can you confirm your suburb?' },
    { role: 'user' as const, text: 'Mount Barker on Wellington Road, my name is Sarah.' },
  ];

  console.log('Dispatching simulated lead for Sarah Jenkins...');
  const result = await dispatcher.dispatchToWaaS(
    mockTenant,
    '+61499112233',
    mockLead,
    mockTranscript
  );

  console.log('\nDispatch Result:', result);
  console.log('\nLead Dispatcher test completed.');
}

test();
