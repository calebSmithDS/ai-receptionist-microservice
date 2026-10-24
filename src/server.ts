import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { env } from './config/env.js';
import { SanityTenantProvider } from './core/providers/sanity-tenant.provider.js';
import { GeminiReceptionistAgent } from './agent/gemini-receptionist.agent.js';
import { registerTelnyxIngestRoute } from './routes/telnyx-ingest.route.js';
import { registerSmsWorkerRoute } from './routes/sms-worker.route.js';
import { registerTelnyxVoiceRoutes } from './routes/telnyx-voice.route.js';
import { telemetry } from './telemetry/metrics.js';

export function buildServer() {
  const app = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  // Fastify plugin to parse application/x-www-form-urlencoded payloads from voice webhooks
  app.register(formbody);

  // Health check endpoint
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // Live Telemetry & Metrics endpoint (Global Snapshot)
  app.get('/metrics', async () => telemetry.getSnapshot());

  // Per-Tenant Telemetry endpoint
  app.get('/metrics/tenant/:tenantId', async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const metrics = telemetry.getTenantMetrics(tenantId);
    if (!metrics) {
      return reply.status(404).send({ error: 'Tenant not found or has no activity yet' });
    }
    return { tenantId, ...metrics };
  });

  // Initialize Core Services
  const tenantProvider = new SanityTenantProvider({
    projectId: env.SANITY_PROJECT_ID,
    dataset: env.SANITY_DATASET,
    apiVersion: env.SANITY_API_VERSION,
  });
  const agent = new GeminiReceptionistAgent();

  // Register Routes
  registerTelnyxIngestRoute(app);
  registerSmsWorkerRoute(app, tenantProvider, agent);
  registerTelnyxVoiceRoutes(app, tenantProvider);

  return app;
}

// Start server when run directly as main entrypoint
const isDirectRun = process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  app.listen({ port: env.PORT, host: env.HOST }, (err, address) => {
    if (err) {
      console.error('Error starting server:', err);
      process.exit(1);
    }
    console.log(`\nAI Receptionist Ingest Service listening at: ${address}\n`);
  });
}
