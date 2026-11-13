import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Root Landing Route (GET /)
 * Redirect to /demo
 */
export function registerLandingRoute(app: FastifyInstance) {
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.redirect('/demo', 302);
  });
}
