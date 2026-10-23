import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { env } from './config/env.js';
import { SanityTenantProvider } from './core/providers/sanity-tenant.provider.js';
import { TwilioProvider } from './telephony/twilio.provider.js';
import { TelnyxProvider } from './telephony/telnyx.provider.js';
import { ReceptionistEngine } from './agent/receptionist-engine.js';
import { LeadDispatcher } from './integrations/lead-dispatcher.js';
import { registerRoutes } from './routes.js';

async function bootstrap() {
  const app = Fastify({
    logger: true,
  });

  // Fastify plugin to parse application/x-www-form-urlencoded from Twilio/Telnyx webhooks
  await app.register(formbody);

  // Initialize Providers
  const tenantProvider = new SanityTenantProvider();
  const telephonyProvider = env.TELEPHONY_PROVIDER === 'telnyx'
    ? new TelnyxProvider()
    : new TwilioProvider();

  const agent = new ReceptionistEngine();
  const leadDispatcher = new LeadDispatcher();

  // Register Webhook & Health Routes
  registerRoutes(app, tenantProvider, telephonyProvider, agent, leadDispatcher);

  // Start Server
  try {
    const address = await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`[AI Receptionist] Microservice running on ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

bootstrap();
