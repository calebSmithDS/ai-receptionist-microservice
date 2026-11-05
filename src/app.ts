import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { registerTwilioVoiceRoutes } from './routes/twilio-voice.route.js';
import { registerTwilioSmsRoutes } from './routes/twilio-sms.route.js';
import { registerProcessMessageWorkerRoute } from './routes/process-message.worker.js';
import { registerDemoRoutes } from './routes/demo.route.js';
import { SessionStore } from './core/session-store.js';
import { GeminiQualificationEvaluator } from './core/gemini-evaluator.js';
import { TwilioSmsClient } from './core/twilio-client.js';
import { ServiceM8RestClient } from './core/servicem8-client.js';
import { SanityTenantProvider } from './core/providers/sanity-tenant.provider.js';
import { CachedTenantProvider } from './core/providers/cached-tenant.provider.js';
import { MessageBufferManager } from './core/message-buffer.js';
import { Redis } from '@upstash/redis';
import { env } from './config/env.js';

/**
 * Fastify Application Factory
 * 
 * Configures all middleware, plugins, and route handlers.
 * Decoupled from `app.listen()` so it can be invoked:
 * 1. By `api/index.ts` inside Vercel Serverless Functions
 * 2. By `src/server.ts` for local Node.js development
 */
export interface AppOptions {
  sessionStore?: SessionStore;
  tenantProvider?: CachedTenantProvider;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const isDev = process.env.NODE_ENV !== 'production';

  const app = Fastify({
    logger: isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
        }
      : true, // High-performance JSON logging in production
  });

  // Fastify plugin to parse application/x-www-form-urlencoded payloads from Twilio webhooks
  await app.register(formbody);

  // Multi-tenant configuration: Sanity CMS wrapped with Upstash Redis 1-hour caching
  const redis = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
    : null;

  // Distributed Message Burst Buffer (Debouncing multi-message SMS streams)
  const bufferManager = new MessageBufferManager(redis);

  // Health check endpoint
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  }));

  // Twilio Voice Webhooks
  registerTwilioVoiceRoutes(app);

  // Twilio SMS Webhooks (with debounce buffer)
  registerTwilioSmsRoutes(app, bufferManager);

  // Initialize Core Services for Worker
  const sessionStore = options.sessionStore || new SessionStore();
  const geminiEvaluator = new GeminiQualificationEvaluator();
  const twilioClient = new TwilioSmsClient();
  const servicem8Client = new ServiceM8RestClient();

  const sanityProvider = new SanityTenantProvider({
    projectId: env.SANITY_PROJECT_ID,
    dataset: env.SANITY_DATASET,
    apiVersion: env.SANITY_API_VERSION,
  });

  const cachedTenantProvider = options.tenantProvider || new CachedTenantProvider({
    underlyingProvider: sanityProvider,
    redis,
    ttlSeconds: 3600, // 1 hour TTL
  });

  // Async Worker Route (Invoked by QStash)
  registerProcessMessageWorkerRoute(
    app,
    sessionStore,
    geminiEvaluator,
    twilioClient,
    cachedTenantProvider,
    servicem8Client
  );

  // Interactive Web Simulator Demo (Option A: Mobile preview for client testing)
  registerDemoRoutes(
    app,
    sessionStore,
    geminiEvaluator,
    twilioClient,
    cachedTenantProvider,
    servicem8Client,
    bufferManager
  );

  return app;
}

