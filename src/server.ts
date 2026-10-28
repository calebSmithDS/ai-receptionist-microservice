import { buildApp } from './app.js';
import { env } from './config/env.js';

/**
 * Local Node.js Development Server Entrypoint
 * 
 * In production on Vercel, `api/index.ts` is invoked directly as a serverless function.
 * For local dev (`npm run dev`), this file boots the Fastify server using `app.listen()`.
 */
async function start() {
  const app = await buildApp();
  const host = env.HOST || '0.0.0.0';
  const port = env.PORT || 3000;

  try {
    const address = await app.listen({ port, host });
    console.log(`\n🚀 AI Receptionist Service listening at: ${address}\n`);
    console.log(`📍 Webhooks:`);
    console.log(`   - Twilio Voice: POST http://localhost:${port}/api/webhooks/twilio/voice`);
    console.log(`   - Twilio SMS:   POST http://localhost:${port}/api/webhooks/twilio/sms`);
    console.log(`   - Message Worker: POST http://localhost:${port}/api/workers/process-message`);
    console.log(`   - Health Check: GET  http://localhost:${port}/health\n`);
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

start();
