import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionStore } from '../core/session-store.js';
import { GeminiQualificationEvaluator } from '../core/gemini-evaluator.js';
import { TwilioSmsClient } from '../core/twilio-client.js';
import { ServiceM8RestClient } from '../core/servicem8-client.js';
import { ITenantProvider } from '../core/types/tenant.js';
import { processMessageEvent, ProcessMessagePayload } from '../core/services/message-dispatcher.js';

export function registerProcessMessageWorkerRoute(
  app: FastifyInstance,
  sessionStore: SessionStore,
  gemini: GeminiQualificationEvaluator,
  twilio: TwilioSmsClient,
  tenantProvider: ITenantProvider,
  servicem8: ServiceM8RestClient
) {
  app.post(
    '/api/workers/process-message',
    async (req: FastifyRequest<{ Body: ProcessMessagePayload }>, reply: FastifyReply) => {
      const result = await processMessageEvent(req.body, {
        sessionStore,
        gemini,
        twilio,
        tenantProvider,
        servicem8,
        logger: req.log,
      });
      return reply.status(result.statusCode).send(result.data);
    }
  );
}
