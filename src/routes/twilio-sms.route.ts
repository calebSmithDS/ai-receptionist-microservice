import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Client } from '@upstash/qstash';
import { MessageBufferManager } from '../core/message-buffer.js';
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
  receivedAt: string;
  debounceVersion: number;
}

const EMPTY_TWIML_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function registerTwilioSmsRoutes(
  app: FastifyInstance,
  bufferManager?: MessageBufferManager
) {
  const qstash = env.QSTASH_TOKEN ? new Client({ token: env.QSTASH_TOKEN }) : null;

  /**
   * INBOUND TWILIO SMS WEBHOOK
   * 
   * When a customer replies, buffer the text in Redis and schedule a 10s debounce
   * trigger via QStash. If the customer sends 3 quick messages in a row, each one
   * extends the buffer and resets the version token, preventing fragmented replies.
   */
  app.post(
    '/api/webhooks/twilio/sms',
    async (req: FastifyRequest<{ Body: TwilioSmsWebhookBody }>, reply: FastifyReply) => {
      const reqLog = req.telemetry || req.log;
      const messageSid = req.body?.MessageSid || req.body?.SmsSid;
      const callerNumber = req.body?.From;
      const dialedNumber = req.body?.To;
      const body = req.body?.Body || '';

      // Validate required SMS fields
      if (!messageSid || !callerNumber || !dialedNumber) {
        reqLog.warn({ body: req.body }, 'Twilio SMS webhook received missing required fields');
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

      // ── Step 1: Ingest into Redis Debounce Buffer ───────────────────────
      const businessId = `tenant_${dialedNumber.replace(/[^0-9]/g, '')}`;
      let debounceVersion = 1;

      if (bufferManager) {
        const result = await bufferManager.ingestMessage(businessId, callerNumber, {
          text: body,
          mediaUrls,
          receivedAt: new Date().toISOString(),
        });
        debounceVersion = result.version;
        reqLog.info(
          { callerNumber, version: debounceVersion, totalBuffered: result.totalBuffered },
          'Customer message ingested into debounce buffer'
        );
      }

      const queueEvent: InboundMessageQueueEvent = {
        eventType: 'INBOUND_SMS',
        channel: 'twilio_sms',
        messageSid,
        callerNumber,
        dialedNumber,
        receivedAt: new Date().toISOString(),
        debounceVersion,
      };

      const destinationWorkerUrl = `${env.APP_BASE_URL}/api/workers/process-message`;

      // ── Step 2: Schedule delayed evaluation (10-second debounce window) ─
      if (qstash) {
        try {
          await qstash.publishJSON({
            url: destinationWorkerUrl,
            body: queueEvent,
            delay: '10s', // Wait 10 seconds for customer to finish typing subsequent texts
          });
          reqLog.info({ messageSid, debounceVersion, delay: '10s' }, 'Scheduled 10s debounced SMS evaluation in QStash');
        } catch (err: any) {
          const errMsg = err?.message || JSON.stringify(err);
          if (errMsg.includes('loopback address') || destinationWorkerUrl.includes('localhost')) {
            reqLog.warn({ destinationWorkerUrl }, '[QStash Local Dev] Simulated successful debounce publish');
          } else {
            reqLog.error({ err, messageSid }, 'Failed to publish SMS event to QStash');
            return reply.status(500).send({ error: 'Failed to queue SMS event' });
          }
        }
      }

      return reply
        .status(200)
        .header('Content-Type', 'text/xml')
        .send(EMPTY_TWIML_RESPONSE);
    }
  );
}

