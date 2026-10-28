import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Client } from '@upstash/qstash';
import { env } from '../config/env.js';

/**
 * Standard Twilio Voice Webhook Form Payload
 * Content-Type: application/x-www-form-urlencoded
 */
export interface TwilioVoiceWebhookBody {
  CallSid?: string;
  AccountSid?: string;
  From?: string;
  To?: string;
  CallStatus?: string;
  Direction?: string;
  FromCity?: string;
  FromState?: string;
  FromCountry?: string;
  [key: string]: any;
}

/**
 * Event published to QStash for worker processing
 */
export interface MissedCallQueueEvent {
  eventType: 'MISSED_CALL';
  channel: 'twilio_voice';
  callSid: string;
  callerNumber: string;
  dialedNumber: string;
  receivedAt: string;
}

// TwiML response telling Twilio to reject the call immediately (no toll/connection charge for customer)
const TWIML_REJECT_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject /></Response>';

export function registerTwilioVoiceRoutes(app: FastifyInstance) {
  // Initialize QStash client once (if token exists)
  const qstash = env.QSTASH_TOKEN ? new Client({ token: env.QSTASH_TOKEN }) : null;

  /**
   * INBOUND TWILIO VOICE WEBHOOK
   * 
   * Twilio sends a POST request here when someone dials the business's Twilio virtual number.
   * Directives:
   * 1. Immediate Acknowledgement: Parse payload, push to QStash with 30s delay, return <Reject/>.
   * 2. Idempotency: Use Twilio's unique CallSid as the QStash deduplicationId.
   * 3. Zero Latency: Offload all database lookups and LLM calls to the async worker.
   */
  app.post(
    '/api/webhooks/twilio/voice',
    async (req: FastifyRequest<{ Body: TwilioVoiceWebhookBody }>, reply: FastifyReply) => {
      const callSid = req.body?.CallSid;
      const callerNumber = req.body?.From;
      const dialedNumber = req.body?.To;

      // Validate required Twilio voice fields
      if (!callSid || !callerNumber || !dialedNumber) {
        req.log.warn({ body: req.body }, 'Twilio voice webhook received with missing required fields');
        // Return 200 with reject so Twilio doesn't retry invalid payloads endlessly
        return reply
          .status(200)
          .header('Content-Type', 'text/xml')
          .send(TWIML_REJECT_RESPONSE);
      }

      req.log.info(
        { callSid, callerNumber, dialedNumber },
        'Inbound voice call intercepted. Preparing QStash delay job.'
      );

      // Build payload contract for the async worker
      const queueEvent: MissedCallQueueEvent = {
        eventType: 'MISSED_CALL',
        channel: 'twilio_voice',
        callSid,
        callerNumber,
        dialedNumber,
        receivedAt: new Date().toISOString(),
      };

      // Destination worker route that handles state transition and greeting SMS dispatch
      const destinationWorkerUrl = `${env.APP_BASE_URL}/api/workers/process-message`;

      if (qstash) {
        try {
          // Schedule greeting SMS dispatch via QStash with a 30-second delay
          await qstash.publishJSON({
            url: destinationWorkerUrl,
            body: queueEvent,
            deduplicationId: callSid, // Drops duplicate webhooks from Twilio
            delay: 30, // 30 seconds delay per architecture specification
          });

          req.log.info(
            { callSid, destinationWorkerUrl, delaySeconds: 30 },
            'Missed call job published to QStash successfully'
          );
        } catch (err) {
          req.log.error({ err, callSid }, 'Failed to publish missed call job to QStash');
          // If queuing fails, return HTTP 500 so Twilio fallback URL or carrier retries can kick in
          return reply.status(500).send({ error: 'Failed to queue missed call task' });
        }
      } else {
        // Fallback simulation for local dev
        req.log.info(
          { queueEvent, destinationWorkerUrl, delay: '30s', note: 'QSTASH_TOKEN not set; simulated publish' },
          '[Local Dev] Simulated QStash publish for missed call'
        );
      }

      // Return TwiML <Reject> immediately with 200 OK
      return reply
        .status(200)
        .header('Content-Type', 'text/xml')
        .send(TWIML_REJECT_RESPONSE);
    }
  );
}

