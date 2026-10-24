import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ITenantProvider } from '../core/types/tenant.js';
import { env } from '../config/env.js';
import { telemetry } from '../telemetry/metrics.js';

interface InboundCallBody {
  To?: string;
  From?: string;
  CallSid?: string;
  call_session_id?: string;
  [key: string]: any;
}

interface CallStatusBody {
  To?: string;
  From?: string;
  DialCallStatus?: string; // 'completed', 'busy', 'no-answer', 'failed', 'canceled'
  CallStatus?: string;
  [key: string]: any;
}

export function registerTelnyxVoiceRoutes(
  app: FastifyInstance,
  tenantProvider: ITenantProvider
) {
  /**
   * 1. INBOUND CALL WEBHOOK
   * Telnyx calls this when a customer dials the virtual phone number.
   * We look up the tenant in Sanity and return TeXML to ring the tradie's mobile.
   */
  app.post(
    '/api/webhooks/voice/inbound',
    async (req: FastifyRequest<{ Body: InboundCallBody }>, reply: FastifyReply) => {
      // Telnyx and Twilio pass dialed number in "To" and caller number in "From"
      const dialedNumber = req.body?.To || req.body?.data?.payload?.to || '';
      const callerNumber = req.body?.From || req.body?.data?.payload?.from || '';

      telemetry.recordCallReceived();
      req.log.info({ dialedNumber, callerNumber }, 'Inbound voice call received');

      // 1. Resolve Tenant from Sanity
      const tenant = await tenantProvider.getTenantByPhoneNumber(dialedNumber);
      if (!tenant) {
        req.log.warn({ dialedNumber }, 'No tenant found for incoming voice call; rejecting');
        // TeXML Reject
        return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject /></Response>');
      }

      req.log.info(
        { businessName: tenant.businessName, forwardTo: tenant.publicPhone },
        'Forwarding call to tradie mobile'
      );

      // 2. Build Status Callback URL for when the call ends/times out
      const host = req.headers.host || 'localhost:3000';
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const statusCallbackUrl = `${protocol}://${host}/api/webhooks/voice/status`;

      // 3. Generate TeXML: Ring tradie for 18 seconds
      const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="18" action="${statusCallbackUrl}" method="POST">
    <Number>${tenant.publicPhone}</Number>
  </Dial>
</Response>`;

      return reply.type('text/xml').send(texml);
    }
  );

  /**
   * 2. CALL STATUS / MISSED CALL CALLBACK
   * Telnyx calls this when the forward-dial completes, is rejected, or times out.
   */
  app.post(
    '/api/webhooks/voice/status',
    async (req: FastifyRequest<{ Body: CallStatusBody }>, reply: FastifyReply) => {
      const dialedNumber = req.body?.To || req.body?.data?.payload?.to || '';
      const callerNumber = req.body?.From || req.body?.data?.payload?.from || '';
      // Status can be: 'completed', 'no-answer', 'busy', 'failed', 'canceled'
      const status = req.body?.DialCallStatus || req.body?.CallStatus || req.body?.data?.payload?.call_status || '';

      req.log.info({ dialedNumber, callerNumber, status }, 'Voice call status callback received');

      // If tradie picked up and spoke, the call was successful; no SMS needed!
      if (status === 'completed' || status === 'answered') {
        req.log.info('Call answered and completed successfully. No text-back needed.');
        return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response />');
      }

      // If status is 'no-answer', 'busy', 'failed', or 'canceled', it was a MISSED CALL!
      telemetry.recordCallMissed();
      req.log.warn({ status, callerNumber }, 'Missed call detected! Triggering instant text-back');

      const tenant = await tenantProvider.getTenantByPhoneNumber(dialedNumber);
      if (!tenant || !callerNumber) {
        return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response />');
      }

      const textBackMessage = `Hi, thanks for calling ${tenant.businessName}! Sorry we missed your call, we're currently on a job. How can we help you today? Feel free to reply here.`;
      const tradieAlertMessage = `⚠️ Missed call from ${callerNumber}. Instant text-back has been sent. AI Receptionist will qualify them when they reply.`;

      // Trigger Outbound SMS to Customer & Tradie via Telnyx REST API
      if (env.TELNYX_API_KEY) {
        try {
          // 1. Text customer
          await fetch('https://api.telnyx.com/v2/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.TELNYX_API_KEY}`,
            },
            body: JSON.stringify({
              from: dialedNumber,
              to: callerNumber,
              text: textBackMessage,
            }),
          });

          // 2. Alert tradie
          await fetch('https://api.telnyx.com/v2/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.TELNYX_API_KEY}`,
            },
            body: JSON.stringify({
              from: dialedNumber,
              to: tenant.publicPhone,
              text: tradieAlertMessage,
            }),
          });

          req.log.info('Missed call SMS notifications sent via Telnyx API');
        } catch (err) {
          req.log.error({ err }, 'Failed to dispatch missed call text-back via Telnyx');
        }
      } else {
        req.log.info(
          { toCustomer: callerNumber, textCustomer: textBackMessage, toTradie: tenant.publicPhone, textTradie: tradieAlertMessage },
          'Simulated missed-call text-back dispatch (TELNYX_API_KEY not set)'
        );
      }

      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response />');
    }
  );
}

