import { GeminiReceptionistAgent } from '../agent/gemini-receptionist.agent.js';
import { TenantContext } from '../core/types/tenant.js';

const mockTenant: TenantContext = {
  tenantId: 'tenant_adelaide_plumbing',
  businessName: 'Adelaide Hills Plumbing',
  publicPhone: '+61412345678',
  twilioForwardingNumber: '+61488889999',
  serviceArea: 'Adelaide Hills (Mount Barker, Stirling, Aldgate)',
  businessHours: 'Mon-Fri 7am-5pm. 24/7 Emergency call-outs.',
  aiCustomInstructions: 'Never quote fixed repair prices over SMS. Blocked drain clearing starts from $180.',
  services: [
    { title: 'Blocked Drains', startingPrice: '$180 clearing fee' },
    { title: 'Emergency Plumbing', startingPrice: '$150 dispatch' },
  ],
};

async function testMultiTurn() {
  console.log('--- Testing Multi-Turn SMS Conversation Flow ---\n');

  const agent = new GeminiReceptionistAgent();
  const callerPhone = '+61411222333';

  // Turn 1: Customer asks vague pricing question
  console.log('Turn 1: Customer texts -> "Hey, how much to clear a blocked drain?"');
  const res1 = await agent.processMessage(mockTenant, callerPhone, 'Hey, how much to clear a blocked drain?');
  console.log(`🤖 AI Reply: "${res1.replyText}"`);
  console.log(`Lead Triggered? ${!!res1.completedLead}\n`);

  // Turn 2: Customer gives suburb only
  console.log('Turn 2: Customer texts -> "I am in Stirling"');
  const res2 = await agent.processMessage(mockTenant, callerPhone, 'I am in Stirling');
  console.log(`🤖 AI Reply: "${res2.replyText}"`);
  console.log(`Lead Triggered? ${!!res2.completedLead}\n`);

  // Turn 3: Customer gives name
  console.log('Turn 3: Customer texts -> "My name is Tom"');
  const res3 = await agent.processMessage(mockTenant, callerPhone, 'My name is Tom');
  console.log(`🤖 AI Reply: "${res3.replyText}"`);
  console.log(`Lead Triggered? ${!!res3.completedLead}`);

  if (res3.completedLead) {
    console.log('\n🎯 Final Captured Lead Payload:');
    console.log(JSON.stringify(res3.completedLead, null, 2));
  }
}

testMultiTurn();

