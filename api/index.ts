import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

// Global cache for the Fastify app instance across warm serverless invocations
let app: FastifyInstance | null = null;

/**
 * Lazy-initializes and caches the Fastify instance.
 * Ensures plugins, decorators, and schemas are fully registered via `await app.ready()`.
 */
async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

/**
 * Vercel Serverless Function Entrypoint
 * 
 * In serverless environments, no persistent socket or `app.listen()` exists.
 * We bridge Vercel's (req, res) HTTP lifecycle into Fastify by emitting the 'request'
 * event on Fastify's underlying Node.js http.Server.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  console.log(`[Vercel Ingress] ${req.method} ${req.url} (rawHeaders host: ${req.headers.host})`);
  const fastify = await getApp();
  fastify.server.emit('request', req, res);
}

