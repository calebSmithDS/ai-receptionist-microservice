import readline from 'node:readline';
import { buildApp } from '../app.js';
import { SessionStore } from '../core/session-store.js';
import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { Redis } from '@upstash/redis';
import { env } from '../config/env.js';

// Visual formatting helpers
const color = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
};

async function startSimulator() {
  console.clear();
  console.log(`${color.bright}${color.cyan}================================================================${color.reset}`);
  console.log(`${color.bright}${color.cyan}📱 AI RECEPTIONIST - INTERACTIVE SMS PHONE SIMULATOR${color.reset}`);
  console.log(`${color.bright}${color.cyan}================================================================${color.reset}`);
  console.log(`${color.dim}Simulates an SMS conversation between a customer and your AI Receptionist.`);
  console.log(`Connected directly to your Live Upstash Redis cloud.${color.reset}\n`);

  const twilioVirtualNumber = '+17372508034';
  const customerMobile = '+61499112233';
  const ownerMobile = env.BUSINESS_OWNER_PHONE || '+61481880277';

  // 1. Live Upstash Redis
  const redis = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
    : null;

  const sessionStore = new SessionStore();

  // 2. Tenant Context for Caleb's Plumbing
  const calebTenant: TenantContext = {
    tenantId: 'tenant_caleb_plumbing',
    businessName: "Caleb's Emergency Plumbing & Gas",
    ownerFirstName: 'Caleb',
    tradeType: 'plumber',
    publicPhone: ownerMobile,
    twilioForwardingNumber: twilioVirtualNumber,
    serviceArea: 'Adelaide Metro, Glenelg, Brighton, Norwood',
    businessHours: 'Monday to Friday 7am-5pm. 24/7 Emergency call-outs.',
    aiCustomInstructions:
      'Friendly Aussie tradie tone. If an active leak or burst pipe is mentioned, check if water is currently flowing. Do not promise exact arrival times; let them know Caleb will call directly.',
    emergencyTriageAdvice:
      'Advise customer to locate and turn off their main water meter isolation tap at the front of the house to stop water damage while waiting!',
    services: [
      { title: 'Blocked Drains', startingPrice: 'From $150' },
      { title: 'Burst Pipe Repair', startingPrice: 'From $180 call-out' },
      { title: 'Hot Water Replacement', startingPrice: 'Quote on site' },
    ],
    excludedServices: [
      'Commercial roofing',
      'Solar hot water panel installation',
      'Asbestos removal',
    ],
  };

  const mockProvider: ITenantProvider = {
    async getTenantByPhoneNumber(phone: string): Promise<TenantContext | null> {
      return phone.replace(/[^\d+]/g, '') === twilioVirtualNumber.replace(/[^\d+]/g, '') ? calebTenant : null;
    },
  };

  const cachedTenantProvider = new CachedTenantProvider({
    underlyingProvider: mockProvider,
    redis,
    ttlSeconds: 3600,
  });

  const app = await buildApp({
    sessionStore,
    tenantProvider: cachedTenantProvider,
  });
  await app.ready();

  // Reset session in Redis for a fresh interactive run
  await sessionStore.deleteSession(calebTenant.tenantId, customerMobile);

  console.log(`${color.yellow}🏢 Business:${color.reset} ${calebTenant.businessName}`);
  console.log(`${color.yellow}📍 Service Area:${color.reset} ${calebTenant.serviceArea}`);
  console.log(`${color.yellow}📞 Tradie Mobile (Lead Alerts):${color.reset} ${ownerMobile}`);
  console.log(`${color.yellow}📱 Twilio Virtual Line dialed:${color.reset} ${twilioVirtualNumber}`);
  console.log(`${color.yellow}👤 Your simulated caller ID:${color.reset} ${customerMobile}\n`);

  // Helper to render state dashboard
  async function renderStateDashboard() {
    const s = await sessionStore.getSession(calebTenant.tenantId, customerMobile);
    const statusColor = s?.status === 'COMPLETED' ? color.green : s?.status === 'ESCALATED' ? color.red : color.magenta;

    console.log(`\n${color.dim}------------------------------------------------------------${color.reset}`);
    console.log(`📊 ${color.bright}State Machine:${color.reset} ${statusColor}[${s?.status || 'EMPTY'}]${color.reset} | ${color.dim}Turns in Redis:${color.reset} ${s?.history.length || 0}`);
    console.log(`📋 ${color.bright}Collected Lead Data:${color.reset} ${color.cyan}${JSON.stringify(s?.collectedData || {})}${color.reset}`);
    console.log(`${color.dim}------------------------------------------------------------${color.reset}\n`);
  }

  // --- Step 1: Simulate the Missed Call ---
  console.log(`${color.bright}[1] Customer calls ${twilioVirtualNumber} and misses call...${color.reset}`);
  
  const callRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/twilio/voice',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      CallSid: 'CA_SIM_' + Date.now(),
      From: customerMobile,
      To: twilioVirtualNumber,
      CallStatus: 'no-answer',
    }).toString(),
  });

  console.log(`    ↳ Call intercepted! HTTP ${callRes.statusCode} returned with TwiML <Reject/> (no charge).`);

  // --- Step 2: Trigger the Missed Call Text-back ---
  console.log(`\n${color.bright}[2] QStash 30s timer fires -> AI sends greeting SMS...${color.reset}`);
  await app.inject({
    method: 'POST',
    url: '/api/workers/process-message',
    payload: {
      eventType: 'MISSED_CALL',
      channel: 'twilio_voice',
      callerNumber: customerMobile,
      dialedNumber: twilioVirtualNumber,
      businessId: calebTenant.tenantId,
      callSid: 'CA_SIM_' + Date.now(),
      receivedAt: new Date().toISOString(),
    },
  });

  const sessionInit = await sessionStore.getSession(calebTenant.tenantId, customerMobile);
  const initialGreeting = sessionInit?.history[0]?.content || '';

  console.log(`\n  💬 ${color.green}${color.bright}[AI Receptionist] -> Customer:${color.reset}`);
  console.log(`     "${initialGreeting}"`);

  await renderStateDashboard();

  // --- Step 3: Interactive SMS loop ---
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`${color.bright}You can now text the bot! Type your message and hit Enter.${color.reset}`);
  console.log(`${color.dim}(Type "r" or "reset" to start a new chat, "exit" to quit)${color.reset}\n`);

  const promptUser = () => {
    rl.question(`${color.blue}${color.bright}👤 You (Customer SMS): ${color.reset}`, async (input) => {
      const text = input.trim();

      if (!text) {
        promptUser();
        return;
      }

      if (text.toLowerCase() === 'exit') {
        console.log(`\n${color.yellow}Closing simulator. Goodbye!${color.reset}\n`);
        rl.close();
        process.exit(0);
      }

      if (text.toLowerCase() === 'reset' || text.toLowerCase() === 'r') {
        await sessionStore.deleteSession(calebTenant.tenantId, customerMobile);
        console.clear();
        console.log(`\n${color.yellow}🔄 Session reset in Redis! Starting fresh conversation...${color.reset}\n`);
        rl.close();
        startSimulator();
        return;
      }

      console.log(`${color.dim}   (Processing message through Gemini & State Machine...)${color.reset}`);

      const res = await app.inject({
        method: 'POST',
        url: '/api/workers/process-message',
        payload: {
          eventType: 'INBOUND_SMS',
          channel: 'twilio_sms',
          callerNumber: customerMobile,
          dialedNumber: twilioVirtualNumber,
          businessId: calebTenant.tenantId,
          messageSid: 'SM_SIM_' + Date.now(),
          body: text,
          receivedAt: new Date().toISOString(),
        },
      });

      const updatedSession = await sessionStore.getSession(calebTenant.tenantId, customerMobile);
      const lastTurn = updatedSession?.history[updatedSession.history.length - 1];

      if (lastTurn && lastTurn.role === 'assistant') {
        console.log(`\n  💬 ${color.green}${color.bright}[AI Receptionist]:${color.reset}`);
        console.log(`     "${lastTurn.content}"`);
      }

      if (updatedSession?.status === 'COMPLETED') {
        console.log(`\n${color.bright}${color.yellow}============================================================${color.reset}`);
        console.log(`🎯 ${color.bright}${color.yellow}LEAD COMPLETE! SMS ALERT DISPATCHED TO TRADIE MOBILE:${color.reset}`);
        console.log(`${color.yellow}   To: ${ownerMobile}`);
        console.log(`   Business: ${calebTenant.businessName}`);
        console.log(`   Customer: ${updatedSession.collectedData.customerName || 'Customer'}`);
        console.log(`   Phone: ${customerMobile}`);
        console.log(`   Suburb: ${updatedSession.collectedData.suburb}`);
        console.log(`   Issue: ${updatedSession.collectedData.issue}`);
        console.log(`   Urgency: ${updatedSession.collectedData.urgency}`);
        console.log(`   ServiceM8 Sync: ${updatedSession.crmSync?.status === 'SYNCED' ? '✅ Logged in Inbox' : '⚠️ ' + (updatedSession.crmSync?.error || 'Pending')}${color.reset}`);
        console.log(`${color.bright}${color.yellow}============================================================${color.reset}`);
      } else if (updatedSession?.status === 'TERMINATED') {
        console.log(`\n${color.bright}${color.magenta}============================================================${color.reset}`);
        console.log(`🛑 ${color.bright}${color.magenta}SPAM SINKHOLE TRIGGERED (ABS-01):${color.reset}`);
        console.log(`${color.magenta}   Intent: ${updatedSession.collectedData.intent || 'spam'}`);
        console.log(`   Action: Session TERMINATED. 0 outbound SMS sent. $0 cost.${color.reset}`);
        console.log(`${color.bright}${color.magenta}============================================================${color.reset}`);
      } else if (updatedSession?.status === 'ABANDONED') {
        console.log(`\n${color.bright}${color.dim}============================================================${color.reset}`);
        console.log(`🔇 ${color.bright}ANTI-LOOP ABANDONED (ABS-04):${color.reset}`);
        console.log(`   User message count reached threshold without qualification.`);
        console.log(`   Action: Session ABANDONED. All future webhooks dropped silently.${color.reset}`);
        console.log(`${color.bright}${color.dim}============================================================${color.reset}`);
      } else if (updatedSession?.status === 'ESCALATED') {
        console.log(`\n${color.bright}${color.red}============================================================${color.reset}`);
        console.log(`🚨 ${color.bright}${color.red}ESCALATION TRIGGERED! AI HALTED & TRADIE ALERTED:${color.reset}`);
        console.log(`${color.red}   To: ${ownerMobile}`);
        console.log(`   Reason: ${updatedSession.escalation?.reason}`);
        console.log(`   Last Message: "${text}"${color.reset}`);
        console.log(`${color.bright}${color.red}============================================================${color.reset}`);
      }

      await renderStateDashboard();
      promptUser();
    });
  };

  promptUser();
}

startSimulator().catch(err => {
  console.error('Simulator error:', err);
  process.exit(1);
});

