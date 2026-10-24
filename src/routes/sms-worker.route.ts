import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { InboundSmsEventSchema } from '../contracts/inbound-sms.contract.js';
import { ITenantProvider } from '../core/types/tenant.js';
import { GeminiReceptionistAgent } from '../agent/gemini-receptionist.agent.js';
import { LeadDispatcher } from '../integrations/lead-dispatcher.js';
import { env } from '../config/env.js';

export function registerSmsWorkerRoute(
  app: FastifyInstance,
  tenantProvider: ITenantProvider,
  agent: GeminiReceptionistAgent,
  leadDispatcher: LeadDispatcher
) {
  app.post('/api/workers/process-sms', async (req: FastifyRequest, reply: FastifyReply) => {
    const parseResult = InboundSmsEventSchema.safeParse(req.body);
    if (!parseResult.success) {
      req.log.warn({ errors: parseResult.error.format() }, 'Invalid QStash SMS worker payload');
      return reply.status(400).send({ error: 'Invalid payload structure' });
    }

    const event = parseResult.data;
    req.log.info({ messageId: event.messageId, to: event.toPhone }, 'Processing queued SMS event');

    // 1. Resolve Tenant from Sanity using dialed number
    const tenant = await tenantProvider.getTenantByPhoneNumber(event.toPhone);
    if (!tenant) {
      req.log.warn({ toPhone: event.toPhone }, 'No tenant found for dialed virtual number');
      return reply.status(200).send({ status: 'ignored', reason: 'Tenant not found' });
    }

    // 2. Run Gemini Receptionist Agent
    const { replyText, completedLead } = await agent.processMessage(tenant, event.fromPhone, event.body);
    req.log.info({ replyText, completedLead: !!completedLead }, 'Generated AI response');

    // 3. Send Outbound SMS Reply to the Customer via Telnyx REST API
    if (env.TELNYX_API_KEY) {
      try {
        const telnyxRes = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.TELNYX_API_KEY}`,
          },
          body: JSON.stringify({
            from: event.toPhone,
            to: event.fromPhone,
            text: replyText,
          }),
        });

        if (!telnyxRes.ok) {
          const errBody = await telnyxRes.text();
          req.log.error({ errBody }, 'Telnyx outbound SMS failed');
        } else {
          req.log.info('Outbound SMS sent successfully via Telnyx');
        }
      } catch (err) {
        req.log.error({ err }, 'Network error sending outbound Telnyx SMS');
      }
    } else {
      req.log.info(
        { to: event.fromPhone, from: event.toPhone, text: replyText },
        'Simulated outbound SMS delivery (TELNYX_API_KEY not configured)'
      );
    }

    // 4. If lead completed: Dispatch to WaaS Astro website & Alert the Tradie
    if (completedLead) {
      req.log.info(
        { lead: completedLead, tenantId: tenant.tenantId },
        '🎯 Qualified lead captured by AI'
      );

      // A. Dispatch to Astro SSR website endpoint (/api/submit-lead)
      const session = agent.getSession(tenant.tenantId, event.fromPhone);
      await leadDispatcher.dispatchToWaaS(tenant, event.fromPhone, completedLead, session.turns);

      // B. Send instant SMS summary to the tradie's mobile
      const urgencyIcon = completedLead.urgency === 'EMERGENCY' ? '🚨 EMERGENCY LEAD' : '🔔 NEW LEAD';
      const tradieNotification = `${urgencyIcon}: ${completedLead.customerName} (${completedLead.suburb})\nIssue: ${completedLead.jobDescription}\nPhone: ${event.fromPhone}`;

      if (env.TELNYX_API_KEY) {
        try {
          await fetch('https://api.telnyx.com/v2/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.TELNYX_API_KEY}`,
            },
            body: JSON.stringify({
              from: event.toPhone,
              to: tenant.publicPhone,
              text: tradieNotification,
            }),
          });
          req.log.info('Tradie notified of new lead via SMS');
        } catch (err) {
          req.log.error({ err }, 'Failed to send tradie SMS notification');
        }
      } else {
        req.log.info(
          { toTradie: tenant.publicPhone, alert: tradieNotification },
          'Simulated tradie lead SMS notification'
        );
      }
    }

    return reply.status(200).send({ success: true, replySent: replyText, completedLead });
  });
}
