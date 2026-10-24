import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Client } from '@upstash/qstash';
import { env } from '../config/env.js';
import { InboundSmsEvent } from '../contracts/inbound-sms.contract.js';
import { telemetry } from '../telemetry/metrics.js';

interface TelnyxWebhookBody {
  data?: {
    event_type?: string;
    id?: string;
    payload?: {
      id?: string;
      from?: { phone_number?: string };
      to?: Array<{ phone_number?: string }>;
      text?: string;
    };
  };
}

export function registerTelnyxIngestRoute(app: FastifyInstance) {
  // Initialize QStash client if token is provided
  const qstash = env.QSTASH_TOKEN ? new Client({ token: env.QSTASH_TOKEN }) : null;

  app.post(
    '/api/webhooks/sms/telnyx',
    async (req: FastifyRequest<{ Body: TelnyxWebhookBody }>, reply: FastifyReply) => {
      const startTime = performance.now();
      const body = req.body?.data;

      // 1. Only process "message.received" events from Telnyx
      if (body?.event_type !== 'message.received') {
        return reply.status(200).send({ received: true, ignored: true });
      }

      const payload = body.payload;
      const messageId = payload?.id || body.id;
      const fromPhone = payload?.from?.phone_number;
      const toPhone = payload?.to?.[0]?.phone_number;
      const text = payload?.text || '';

      if (!messageId || !fromPhone || !toPhone) {
        req.log.warn({ payload }, 'Received invalid or incomplete Telnyx SMS payload');
        return reply.status(400).send({ error: 'Missing required SMS fields' });
      }

      // 2. Build our lean Data Contract event
      telemetry.recordSmsReceived();
      const event: InboundSmsEvent = {
        messageId,
        fromPhone,
        toPhone,
        body: text,
        provider: 'telnyx',
        receivedAt: new Date().toISOString(),
      };

      // 3. Queue to Upstash QStash
      const destinationWorkerUrl = `${env.APP_BASE_URL}/api/workers/process-sms`;

      if (qstash) {
        try {
          await qstash.publishJSON({
            url: destinationWorkerUrl,
            body: event,
            deduplicationId: messageId, // Drops duplicate webhooks from Telnyx
          });
          req.log.info({ messageId, destination: destinationWorkerUrl }, 'Dispatched event to QStash');
        } catch (err) {
          req.log.error({ err, messageId }, 'Failed to publish event to QStash');
          // In distributed systems, if queuing fails, return 500 so the carrier retries
          return reply.status(500).send({ error: 'Queue publication failed' });
        }
      } else {
        req.log.info(
          { event, note: 'QSTASH_TOKEN not set; logging event for local dev' },
          'Simulated QStash publish'
        );
      }

      const durationMs = (performance.now() - startTime).toFixed(2);
      req.log.info({ durationMs, messageId }, 'Ingest completed and acknowledged to Telnyx');

      // 4. Return HTTP 200 OK immediately
      return reply.status(200).send({ received: true, durationMs: `${durationMs}ms` });
    }
  );
}

