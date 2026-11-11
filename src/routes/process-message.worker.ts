import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionStore } from '../core/session-store.js';
import { GeminiQualificationEvaluator } from '../core/gemini-evaluator.js';
import { TwilioSmsClient } from '../core/twilio-client.js';
import { ServiceM8RestClient } from '../core/servicem8-client.js';
import { ITenantProvider } from '../core/types/tenant.js';
import { MessageBufferManager } from '../core/message-buffer.js';
import { EligibilityEngine } from '../core/eligibility/eligibility-engine.js';
import { GeminiBouncerClassifier } from '../core/eligibility/gemini-bouncer.js';
import { processMessageEvent, ProcessMessagePayload } from '../core/services/message-dispatcher.js';

export function registerProcessMessageWorkerRoute(
  app: FastifyInstance,
  sessionStore: SessionStore,
  gemini: GeminiQualificationEvaluator,
  twilio: TwilioSmsClient,
  tenantProvider: ITenantProvider,
  servicem8: ServiceM8RestClient,
  bufferManager?: MessageBufferManager,
  eligibilityEngine?: EligibilityEngine,
  bouncerClassifier?: GeminiBouncerClassifier
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
        bufferManager,
        eligibilityEngine,
        bouncerClassifier,
        logger: req.log,
      });
      return reply.status(result.statusCode).send(result.data);
    }
  );
}
