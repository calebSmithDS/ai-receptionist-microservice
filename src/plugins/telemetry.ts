import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import type { Logger } from 'pino';
import {
  createScopedLogger,
  maskPhoneNumber,
  hashPhoneNumber,
  TelemetryContext,
} from '../core/logger.js';
import { TenantResolverService, TenantConfig } from '../services/tenant-resolver.js';

/**
 * ARCHITECTURAL WHY: TypeScript Module Augmentation
 * By default, Fastify's `FastifyRequest` only knows about standard HTTP properties (`body`, `headers`, etc.).
 * Rather than casting `(request as any).telemetry` everywhere in route handlers (which breaks
 * type safety), TypeScript module augmentation merges our custom properties directly into Fastify's
 * global type interface.
 */
declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: TenantConfig;
    telemetry: Logger;
    telemetryContext: TelemetryContext;
  }
}

/**
 * Inbound Twilio Webhook Payload Shape (x-www-form-urlencoded)
 */
interface TwilioWebhookBody {
  To?: string;
  From?: string;
  Body?: string;
  MessageSid?: string;
  CallSid?: string;
  [key: string]: unknown;
}

/**
 * Asynchronous Worker / QStash Webhook Payload Shape
 */
interface WorkerWebhookBody {
  traceId?: string;
  businessId?: string;
  callerNumber?: string;
  callerPhone?: string;
  dialedNumber?: string;
  sessionId?: string;
  [key: string]: unknown;
}

const tenantResolver = new TenantResolverService();

/**
 * Telemetry & Tenant Context Fastify Plugin
 *
 * Intercepts:
 * 1. Twilio Ingress (/api/webhooks/twilio/*)
 * 2. Async QStash / Process Message Worker (/api/workers/process-message)
 */
const telemetryPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;

    // -------------------------------------------------------------------------
    // SCENARIO A: Inbound Twilio Webhooks (/api/webhooks/twilio/sms or voice)
    // -------------------------------------------------------------------------
    if (url.includes('/webhooks/twilio/')) {
      const body = (request.body as TwilioWebhookBody) || {};
      const dialedNumber = body.To;
      const rawCallerPhone = body.From;

      // Always generate a fresh distributed traceId at the very first point of ingress
      const traceId = crypto.randomUUID();
      const burstId = body.MessageSid || body.CallSid || crypto.randomUUID();

      if (!dialedNumber || !rawCallerPhone) {
        request.telemetryContext = {
          businessId: 'unknown',
          traceId,
          burstId,
        };
        request.telemetry = createScopedLogger(request.telemetryContext);
        request.telemetry.warn('Malformed Twilio payload missing To or From');
        return;
      }

      // Resolve Tenant
      const tenant = await tenantResolver.resolveTenantByTwilioNumber(dialedNumber);

      if (!tenant) {
        request.telemetryContext = {
          businessId: 'unassigned_number',
          callerPhone: rawCallerPhone,
          traceId,
          burstId,
        };
        request.telemetry = createScopedLogger(request.telemetryContext);
        request.telemetry.warn({ dialedNumber }, 'Inbound webhook to unassigned Twilio number');
        return;
      }

      // Populate context on request
      request.tenantContext = tenant;
      request.telemetryContext = {
        businessId: tenant.businessId,
        callerPhone: rawCallerPhone,
        maskedPhone: maskPhoneNumber(rawCallerPhone),
        callerHash: hashPhoneNumber(rawCallerPhone),
        traceId,
        burstId,
      };
      request.telemetry = createScopedLogger(request.telemetryContext);
      return;
    }

    // -------------------------------------------------------------------------
    // SCENARIO B: Asynchronous Worker (/api/workers/process-message)
    // -------------------------------------------------------------------------
    if (url.includes('/api/workers/process-message')) {
      const body = (request.body as WorkerWebhookBody) || {};

      const traceId = body.traceId || (request.headers['x-request-id'] as string) || crypto.randomUUID();
      const rawCallerPhone = body.callerNumber || body.callerPhone;
      const businessId = body.businessId || 'unknown';

      request.telemetryContext = {
        businessId,
        callerPhone: rawCallerPhone,
        maskedPhone: rawCallerPhone ? maskPhoneNumber(rawCallerPhone) : undefined,
        callerHash: rawCallerPhone ? hashPhoneNumber(rawCallerPhone) : undefined,
        traceId,
        sessionId: body.sessionId,
      };
      request.telemetry = createScopedLogger(request.telemetryContext);
      return;
    }

    // -------------------------------------------------------------------------
    // SCENARIO C: Default / Non-webhook routes (/health, etc.)
    // -------------------------------------------------------------------------
    const defaultTraceId = (request.headers['x-request-id'] as string) || crypto.randomUUID();
    request.telemetryContext = { businessId: 'system', traceId: defaultTraceId };
    request.telemetry = createScopedLogger(request.telemetryContext);
  });
};

export default fp(telemetryPlugin, {
  name: 'telemetry-plugin',
  fastify: '5.x',
});
