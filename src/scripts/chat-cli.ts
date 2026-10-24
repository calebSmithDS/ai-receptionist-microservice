import readline from 'readline';
import { GeminiReceptionistAgent } from '../agent/gemini-receptionist.agent.js';
import { TenantContext } from '../core/types/tenant.js';

const mockTenant: TenantContext = {
  tenantId: 'tenant_adelaide_plumbing',
  businessName: 'Adelaide Hills Plumbing',
  publicPhone: '+61412345678',
  twilioForwardingNumber: '+61488889999',
  serviceArea: 'Adelaide Hills (Mount Barker, Stirling, Aldgate, Crafers)',
  businessHours: 'Mon-Fri 7am-5pm. 24/7 Emergency call-outs.',
  aiCustomInstructions: 'Never quote fixed repair prices over SMS. Standard dispatch/assessment fee is $150.',
  services: [
    { title: 'Emergency Plumbing', startingPrice: '$150 dispatch' },
    { title: 'Hot Water Systems', startingPrice: '$150 assessment' },
    { title: 'Blocked Drains', startingPrice: '$180 clearing fee' },
    { title: 'Gas Fitting', startingPrice: '$160 inspection fee' },
  ],
};

async function startCli() {
  console.log('=====================================================');
  console.log(`🤖 AI Receptionist Live Chat: ${mockTenant.businessName}`);
  console.log(`📍 Service Area: ${mockTenant.serviceArea}`);
  console.log(`💰 Base Fee: $150 dispatch | Never fixed repair quotes`);
  console.log('=====================================================\n');

  const agent = new GeminiReceptionistAgent();
  const customerPhone = '+61499112233';

  // Initial missed call text
  console.log(`📲 [Auto-SMS to Customer]: "Hi, thanks for calling ${mockTenant.businessName}! Sorry we missed your call, we're currently on a job. How can we help you today? Feel free to reply here."\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptUser = () => {
    rl.question('You (Customer SMS): ', async (userInput) => {
      if (userInput.trim().toLowerCase() === 'exit') {
        console.log('\nExiting chat simulation. Goodbye!');
        rl.close();
        return;
      }

      if (!userInput.trim()) {
        promptUser();
        return;
      }

      console.log('🤖 AI Receptionist is thinking...');
      const { replyText, completedLead } = await agent.processMessage(
        mockTenant,
        customerPhone,
        userInput
      );

      console.log(`\n💬 AI Receptionist: "${replyText}"\n`);

      if (completedLead) {
        console.log('-----------------------------------------------------');
        console.log('🎯 LEAD CAPTURED & TRIGGERED:');
        console.log(JSON.stringify(completedLead, null, 2));
        console.log('-----------------------------------------------------\n');
      }

      promptUser();
    });
  };

  promptUser();
}

startCli();

