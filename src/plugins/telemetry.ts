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
  [key: string]: unknown;
}

/**
 * Asynchronous QStash Webhook Payload Shape
 */
interface QStashWebhookBody {
  traceId?: string;
  businessId?: string;
  callerPhone?: string;
  sessionId?: string;
  [key: string]: unknown;
}

const tenantResolver = new TenantResolverService();

/**
 * Telemetry & Tenant Context Fastify Plugin
 *
 * Wrapped in `fastify-plugin` (fp) so Fastify does NOT encapsulate decorators and hooks
 * into a child scope, making them available across all application routes.
 */
const telemetryPlugin: FastifyPluginAsync = async (fastify) => {
  /**
   * ARCHITECTURAL WHY: preHandler Hook vs onRequest Hook
   * - `onRequest` executes before the HTTP body is parsed.
   * - Twilio sends inbound SMS as `application/x-www-form-urlencoded`.
   * - We need the parsed `request.body.To` and `request.body.From`, so we run this in `preHandler`
   *   (after `@fastify/formbody` has parsed the payload into an object).
   */
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;

    // 1. ROUTE GUARD: Non-webhook routes (e.g. /health, /metrics) bypass heavy tenant lookups
    if (!url.startsWith('/webhooks/')) {
      const defaultTraceId = (request.headers['x-request-id'] as string) || crypto.randomUUID();
      request.telemetryContext = { businessId: 'system', traceId: defaultTraceId };
      request.telemetry = createScopedLogger(request.telemetryContext);
      return;
    }

    // -------------------------------------------------------------------------
    // SCENARIO A: Inbound Twilio Webhook (/webhooks/twilio)
    // -------------------------------------------------------------------------
    if (url.startsWith('/webhooks/twilio')) {
      const body = (request.body as TwilioWebhookBody) || {};
      const dialedNumber = body.To;
      const rawCallerPhone = body.From;

      // Always generate a fresh distributed traceId at the very first point of ingress
      const traceId = crypto.randomUUID();
      const burstId = body.MessageSid || crypto.randomUUID();

      if (!dialedNumber || !rawCallerPhone) {
        request.telemetryContext = {
          businessId: 'unknown',
          traceId,
          burstId,
        };
        request.telemetry = createScopedLogger(request.telemetryContext);
        request.telemetry.warn('Malformed Twilio payload missing To or From');
        return reply.status(400).send({ error: 'Missing To or From in Twilio payload' });
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
        request.telemetry.warn({ dialedNumber }, 'Inbound SMS to unassigned Twilio number');
        return reply.status(404).send({ error: 'TenantNotFound' });
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

      request.telemetry.info(
        { messageSid: body.MessageSid, companyName: tenant.companyName },
        'Inbound Twilio SMS received and correlated'
      );
      return;
    }

    // -------------------------------------------------------------------------
    // SCENARIO B: Asynchronous QStash Debounced Worker (/webhooks/qstash)
    // -------------------------------------------------------------------------
    if (url.startsWith('/webhooks/qstash')) {
      const body = (request.body as QStashWebhookBody) || {};

      /**
       * ARCHITECTURAL WHY: Trace Continuity Across Async Boundaries
       * Instead of creating a brand-new traceId, we re-hydrate the traceId that the inbound
       * Twilio handler placed into the QStash message payload.
       * This unifies logs across the entire asynchronous lifecycle.
       */
      const traceId = body.traceId || crypto.randomUUID();
      const businessId = body.businessId || 'unknown';
      const rawCallerPhone = body.callerPhone;

      request.telemetryContext = {
        businessId,
        callerPhone: rawCallerPhone,
        maskedPhone: rawCallerPhone ? maskPhoneNumber(rawCallerPhone) : undefined,
        callerHash: rawCallerPhone ? hashPhoneNumber(rawCallerPhone) : undefined,
        traceId,
        sessionId: body.sessionId,
      };
      request.telemetry = createScopedLogger(request.telemetryContext);

      request.telemetry.info('QStash debounced worker execution resumed with preserved traceId');
      return;
    }
  });
};

export default fp(telemetryPlugin, {
  name: 'telemetry-plugin',
  fastify: '5.x',
});

