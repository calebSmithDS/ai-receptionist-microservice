import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Client } from '@upstash/qstash';
import { env } from '../config/env.js';

export interface TwilioSmsWebhookBody {
  MessageSid?: string;
  SmsSid?: string;
  AccountSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaUrl1?: string;
  [key: string]: any;
}

export interface InboundMessageQueueEvent {
  eventType: 'INBOUND_SMS';
  channel: 'twilio_sms';
  messageSid: string;
  callerNumber: string;
  dialedNumber: string;
  body: string;
  mediaUrls: string[];
  receivedAt: string;
}

const EMPTY_TWIML_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function registerTwilioSmsRoutes(app: FastifyInstance) {
  const qstash = env.QSTASH_TOKEN ? new Client({ token: env.QSTASH_TOKEN }) : null;

  /**
   * INBOUND TWILIO SMS WEBHOOK
   * 
   * Twilio calls this whenever a customer replies to an SMS.
   * Directives:
   * 1. Immediate Acknowledgement: Push event to QStash without blocking on LLM or DB.
   * 2. Return HTTP 200 with empty TwiML <Response/> immediately.
   * 3. Collect any MMS MediaUrl parameters to protect Visual Triage.
   */
  app.post(
    '/api/webhooks/twilio/sms',
    async (req: FastifyRequest<{ Body: TwilioSmsWebhookBody }>, reply: FastifyReply) => {
      const messageSid = req.body?.MessageSid || req.body?.SmsSid;
      const callerNumber = req.body?.From;
      const dialedNumber = req.body?.To;
      const body = req.body?.Body || '';

      // Validate required SMS fields
      if (!messageSid || !callerNumber || !dialedNumber) {
        req.log.warn({ body: req.body }, 'Twilio SMS webhook received missing required fields');
        return reply.status(200).type('text/xml').send(EMPTY_TWIML_RESPONSE);
      }

      // Collect MMS media URLs if present (e.g. photos of switchboard or pipes)
      const mediaUrls: string[] = [];
      const numMedia = parseInt(req.body?.NumMedia || '0', 10);
      for (let i = 0; i < numMedia; i++) {
        const url = req.body?.[`MediaUrl${i}`];
        if (url) {
          mediaUrls.push(url);
        }
      }

      req.log.info(
        { messageSid, callerNumber, dialedNumber, mediaCount: mediaUrls.length },
        'Inbound SMS received. Publishing to QStash.'
      );

      const queueEvent: InboundMessageQueueEvent = {
        eventType: 'INBOUND_SMS',
        channel: 'twilio_sms',
        messageSid,
        callerNumber,
        dialedNumber,
        body,
        mediaUrls,
        receivedAt: new Date().toISOString(),
      };

      const destinationWorkerUrl = `${env.APP_BASE_URL}/api/workers/process-message`;

      if (qstash) {
        try {
          await qstash.publishJSON({
            url: destinationWorkerUrl,
            body: queueEvent,
            deduplicationId: messageSid, // Guarantees carrier duplicate retries are dropped
          });
          req.log.info({ messageSid, destinationWorkerUrl }, 'SMS event published to QStash');
        } catch (err) {
          req.log.error({ err, messageSid }, 'Failed to publish SMS event to QStash');
          return reply.status(500).send({ error: 'Failed to queue SMS event' });
        }
      } else {
        req.log.info(
          { queueEvent, destinationWorkerUrl, note: 'QSTASH_TOKEN not set; simulated publish' },
          '[Local Dev] Simulated QStash publish for SMS'
        );
      }

      // Return empty TwiML with 200 OK immediately
      return reply
        .status(200)
        .header('Content-Type', 'text/xml')
        .send(EMPTY_TWIML_RESPONSE);
    }
  );
}

