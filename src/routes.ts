import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ITenantProvider } from './core/types/tenant.js';
import { ITelephonyProvider } from './telephony/telephony.interface.js';
import { ReceptionistEngine } from './agent/receptionist-engine.js';
import { LeadDispatcher } from './integrations/lead-dispatcher.js';

interface InboundCallBody {
  To?: string;
  From?: string;
  CallSid?: string;
  [key: string]: any;
}

interface CallStatusBody {
  To?: string;
  From?: string;
  DialCallStatus?: string; // Twilio: 'completed', 'busy', 'no-answer', 'failed', 'canceled'
  CallStatus?: string;
  [key: string]: any;
}

interface InboundSmsBody {
  To?: string;
  From?: string;
  Body?: string;
  [key: string]: any;
}

export function registerRoutes(
  app: FastifyInstance,
  tenantProvider: ITenantProvider,
  telephonyProvider: ITelephonyProvider,
  agent: ReceptionistEngine,
  leadDispatcher: LeadDispatcher
) {
  // Health check
  app.get('/health', async () => ({ status: 'ok', service: 'ai-receptionist' }));

  /**
   * 1. INBOUND CALL
   * Customer calls the virtual number. Twilio forward-dials the tradie's mobile.
   */
  app.post('/voice/inbound', async (req: FastifyRequest<{ Body: InboundCallBody }>, reply: FastifyReply) => {
    const dialedNumber = req.body.To || '';
    const callerNumber = req.body.From || '';

    const tenant = await tenantProvider.getTenantByPhoneNumber(dialedNumber);
    if (!tenant) {
      console.warn(`[Voice] No tenant found for dialed number: ${dialedNumber}`);
      reply.type('text/xml').send('<Response><Reject /></Response>');
      return;
    }

    console.log(`[Voice] Inbound call from ${callerNumber} to ${tenant.businessName} (${dialedNumber})`);

    // Target status callback url when the call finishes or times out
    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const statusCallbackUrl = `${protocol}://${host}/voice/call-status`;

    // Forward call to the tradie's public mobile number
    const markup = telephonyProvider.generateForwardingMarkup(
      tenant.publicPhone,
      statusCallbackUrl,
      18 // Ring tradie for 18 seconds before failing over
    );

    reply.type('text/xml').send(markup);
  });

  /**
   * 2. CALL STATUS / MISSED CALL WEBHOOK
   * Fired when the call ends, times out, or goes unanswered by the tradie.
   */
  app.post('/voice/call-status', async (req: FastifyRequest<{ Body: CallStatusBody }>, reply: FastifyReply) => {
    const dialedNumber = req.body.To || '';
    const callerNumber = req.body.From || '';
    const dialStatus = req.body.DialCallStatus || req.body.CallStatus || '';

    console.log(`[Voice Status] Call to ${dialedNumber} from ${callerNumber} ended with status: ${dialStatus}`);

    // If tradie answered, nothing further needed
    if (dialStatus === 'completed' || dialStatus === 'answered') {
      reply.type('text/xml').send('<Response />');
      return;
    }

    // It was a MISSED CALL (no-answer, busy, failed, canceled)
    const tenant = await tenantProvider.getTenantByPhoneNumber(dialedNumber);
    if (!tenant || !callerNumber) {
      reply.type('text/xml').send('<Response />');
      return;
    }

    console.log(`[Missed Call] Triggering instant text-back for tenant ${tenant.businessName}`);

    // 1. Send Instant Text-Back to Caller
    const initialText = agent.generateInitialMissedCallMessage(tenant);
    await telephonyProvider.sendSms({
      to: callerNumber,
      from: dialedNumber,
      body: initialText,
    });

    // 2. Send SMS Alert to the Tradie
    await telephonyProvider.sendSms({
      to: tenant.publicPhone,
      from: dialedNumber,
      body: `⚠️ Missed call from ${callerNumber}. Instant text-back has been sent. AI Receptionist is engaging them now.`,
    });

    reply.type('text/xml').send('<Response />');
  });

  /**
   * 3. INBOUND SMS WEBHOOK
   * Customer replies to the text message. Conversational AI agent qualifies the lead.
   */
  app.post('/sms/inbound', async (req: FastifyRequest<{ Body: InboundSmsBody }>, reply: FastifyReply) => {
    const dialedNumber = req.body.To || '';
    const callerNumber = req.body.From || '';
    const messageBody = req.body.Body || '';

    const tenant = await tenantProvider.getTenantByPhoneNumber(dialedNumber);
    if (!tenant) {
      console.warn(`[SMS] No tenant found for recipient number: ${dialedNumber}`);
      reply.status(200).send('<Response />');
      return;
    }

    console.log(`[SMS Inbound] Received from ${callerNumber} to ${tenant.businessName}: "${messageBody}"`);

    // Process through AI Receptionist engine
    const { reply: botReply, completedLead } = await agent.handleIncomingSms(tenant, callerNumber, messageBody);

    // Send AI reply back to the customer
    await telephonyProvider.sendSms({
      to: callerNumber,
      from: dialedNumber,
      body: botReply,
    });

    // If lead qualifications were completed in this turn, dispatch to WaaS and alert tradie
    if (completedLead) {
      console.log(`[Lead Complete] Lead captured for ${completedLead.customerName} (${completedLead.urgency})`);

      // 1. Dispatch to parent Astro SSR website endpoint
      await leadDispatcher.dispatchLead(tenant.customDomain, completedLead);

      // 2. Alert the tradie immediately via SMS
      const urgencyIcon = completedLead.urgency === 'EMERGENCY' ? '🚨 EMERGENCY LEAD' : '🔔 NEW LEAD';
      await telephonyProvider.sendSms({
        to: tenant.publicPhone,
        from: dialedNumber,
        body: `${urgencyIcon}: ${completedLead.customerName} (${completedLead.location || 'Unknown area'})\nIssue: ${completedLead.jobDescription}\nPhone: ${callerNumber}`,
      });
    }

    reply.status(200).send('<Response />');
  });
}
