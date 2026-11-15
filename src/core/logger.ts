import pino from 'pino';
import crypto from 'node:crypto';

/**
 * ARCHITECTURAL WHY: Masking vs Blind Redaction
 * 1. Blindly replacing phone numbers with '[REDACTED]' makes production triage impossible
 *    when a customer or tradie reports an issue with a specific number.
 * 2. `maskPhoneNumber` (+614****5678) allows immediate human visual verification in logs.
 * 3. `hashPhoneNumber` (deterministic truncated SHA-256 HMAC) lets engineers run queries like:
 *    `telemetry.callerHash = "3f8a9b1c..."` to trace all past interactions from that customer
 *    without storing or exposing raw E.164 numbers in centralized log sinks.
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone || phone.length < 8) return '****';
  const prefix = phone.slice(0, 4);
  const suffix = phone.slice(-4);
  return `${prefix}****${suffix}`;
}

export function hashPhoneNumber(phone: string, salt: string = process.env.PII_SALT || 'tradie-salt'): string {
  return crypto.createHmac('sha256', salt).update(phone).digest('hex').slice(0, 16);
}

/**
 * TelemetryContext
 * Carried across distributed hops: Twilio Ingress -> QStash Queue -> FSM Engine -> ServiceM8 / Twilio Outbound.
 */
export interface TelemetryContext {
  businessId: string;
  callerPhone?: string;     // Raw E.164 (only kept in memory, never logged unmasked)
  maskedPhone?: string;     // e.g. "+614****1234"
  callerHash?: string;      // e.g. "9a8b7c6d5e4f1a2b"
  traceId: string;          // Distributed trace ID (persists across QStash boundary)
  burstId?: string;         // Identifies a specific SMS inside a multi-text burst
  sessionId?: string;       // FSM conversation session ID
}

/**
 * Base Pino Logger Configuration
 * Synchronous fast JSON serialization, masking sensitive bodies while preserving structure.
 */
export const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.body.From',
      'req.body.Body',
      'body.From',
      'body.Body',
      'rawBody',
    ],
    censor: '[REDACTED_PII]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

/**
 * createScopedLogger
 *
 * ARCHITECTURAL WHY: Currying with .child()
 * Injects immutable correlation identifiers directly into every subsequent log statement.
 */
export function createScopedLogger(ctx: TelemetryContext): pino.Logger {
  const maskedPhone = ctx.maskedPhone ?? (ctx.callerPhone ? maskPhoneNumber(ctx.callerPhone) : undefined);
  const callerHash = ctx.callerHash ?? (ctx.callerPhone ? hashPhoneNumber(ctx.callerPhone) : undefined);

  return baseLogger.child({
    telemetry: {
      businessId: ctx.businessId,
      maskedPhone,
      callerHash,
      traceId: ctx.traceId,
      burstId: ctx.burstId,
      sessionId: ctx.sessionId,
    },
  });
}

